#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Canvas 只读客户端；同步器导入，直接运行可检查项目根 .env 的连接。
API 只发送同源 GET；文件下载跨域不携带 token，错误不泄露签名 URL。
"""

import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


class CanvasError(Exception):
    """HTTP 状态和安全提示；不向外传服务端正文、签名查询参数或异常原文。"""

    def __init__(self, code, path="", message=""):
        self.code = code
        self.path = urlsplit(str(path)).path
        super().__init__(message or (f"Canvas 返回 HTTP {code}" if code else "Canvas 请求失败"))


def load_env(path=ENV_FILE):
    """只读取指定项目 .env，不从环境变量或其他项目搜索凭证。"""
    path = Path(path)
    if not path.exists():
        raise CanvasError(0, message="尚未配置 Canvas。请把项目根 .env.example 复制为 .env，在文件里填写地址和 token。")
    env = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def public_addresses(url):
    """拒绝本机／内网 HTTPS；连接使用这里校验过的地址，避免 DNS 二次解析。"""
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.port not in (None, 443) or "\\" in url or any(ord(c) < 32 for c in url)):
            raise ValueError()
        entries = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(entry[4][0] for entry in entries))
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise ValueError()
        return addresses
    except (ValueError, OSError):
        raise CanvasError(0, message="地址无效、无法解析，或指向本机／内网；已停止请求。") from None


class _PublicHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        addresses = public_addresses("https://" + self.host)
        last_error = None
        for address in addresses:
            try:
                self.sock = socket.create_connection((address, self.port), self.timeout, self.source_address)
                self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)
                return
            except OSError as exc:
                last_error = exc
                if self.sock:
                    self.sock.close()
        raise last_error or OSError("connection failed")


class _PublicHTTPSHandler(HTTPSHandler):
    def https_open(self, request):
        return self.do_open(_PublicHTTPSConnection, request, context=self._context)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Canvas:
    """get 返回数据和响应头；list 自动翻页；download_file 保存完整附件。"""

    def __init__(self, env_file=ENV_FILE, base_url_env="CANVAS_BASE_URL", token_env="CANVAS_API_TOKEN"):
        env = load_env(env_file)
        self.base = env.get(base_url_env, "").rstrip("/")
        self.token = env.get(token_env, "")
        parsed = urlsplit(self.base)
        if (not self.token or "粘贴" in self.token or self.token.startswith("your_")
                or parsed.scheme != "https" or not parsed.hostname or parsed.path
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.port not in (None, 443)):
            raise CanvasError(0, message="项目根 .env 的 Canvas 地址或 token 尚未填写完整。")
        self.host = parsed.netloc
        self.requests = 0
        self.last_headers = {}
        # 禁用系统代理，固定已校验的公共地址；重定向由下面逐跳检查。
        self.opener = build_opener(ProxyHandler({}), _PublicHTTPSHandler(), _NoRedirect())

    def _same_origin(self, url):
        parsed = urlsplit(url)
        return parsed.scheme == "https" and parsed.netloc == self.host

    def _open(self, url, api_only=False):
        """逐跳创建请求，绝不复制 Authorization 到外部存储服务器。"""
        seen = set()
        for _ in range(6):
            parsed = urlsplit(url)
            if api_only and (not self._same_origin(url) or not parsed.path.startswith("/api/v1/")):
                raise CanvasError(0, message="Canvas API 重定向到了其他站点或非 API 页面；已拒绝发送凭证。")
            public_addresses(url)
            if url in seen:
                raise CanvasError(0, message="Canvas 下载或 API 重定向循环。")
            seen.add(url)
            headers = {"Accept": "application/json" if api_only else "*/*", "User-Agent": "dsh-study/0.1"}
            if self._same_origin(url):
                headers["Authorization"] = "Bearer " + self.token
            self.requests += 1
            try:
                return self.opener.open(Request(url, headers=headers, method="GET"), timeout=45)
            except HTTPError as exc:
                if exc.code in (301, 302, 303, 307, 308) and exc.headers.get("Location"):
                    url = urljoin(url, exc.headers["Location"])
                    exc.close()
                    continue
                code = exc.code
                exc.close()
                raise CanvasError(code) from None
            except (URLError, OSError, http.client.HTTPException):
                raise CanvasError(0, message="Canvas 网络连接失败或超时，请稍后刷新。") from None
        raise CanvasError(0, message="Canvas 重定向次数过多，已停止。")

    def get(self, path, params=None):
        url = path if path.startswith("https://") else self.base + path
        if params:
            url += ("&" if "?" in url else "?") + urlencode(params, doseq=True)
        for attempt in range(3):
            try:
                with self._open(url, api_only=True) as response:
                    self.last_headers = {k.lower(): v for k, v in response.headers.items()}
                    content = response.read(32 * 1024 * 1024 + 1)
                    if len(content) > 32 * 1024 * 1024:
                        raise CanvasError(0, message="Canvas API 响应过大，已停止读取。")
                    return json.loads(content), self.last_headers
            except CanvasError as exc:
                if exc.code in (429, 502, 503, 504) and attempt < 2:
                    time.sleep(2 ** (attempt + 1))
                    continue
                raise
            except (ValueError, UnicodeError, OSError, http.client.HTTPException):
                raise CanvasError(0, message="Canvas 未返回完整有效的资料数据，可能需要重新认证。") from None

    def list(self, path, params=None):
        params = {"per_page": 100, **(params or {})}
        result, seen = [], set()
        while path:
            if path in seen or len(seen) >= 1000:
                raise CanvasError(0, message="Canvas 列表翻页循环或页数异常，保留旧资料。")
            seen.add(path)
            body, headers = self.get(path, params)
            if not isinstance(body, list):
                raise CanvasError(0, message="Canvas 列表接口没有返回列表，保留旧资料。")
            result.extend(body)
            match = re.search(r'<([^>]+)>;\s*rel="next"', headers.get("link", "") or "")
            path, params = (match.group(1), None) if match else (None, None)
        return result

    def download_file(self, metadata, destination):
        """只接受 API 文件对象中的 url；完整下载和校验后再替换目标文件。"""
        url = metadata.get("url")
        if not isinstance(url, str) or not url:
            raise CanvasError(0, message="Canvas 没有提供该文件的下载地址。")
        # 目录隐藏的文件可能允许按链接访问，最终下载权限仍由 Canvas GET 判断。
        if metadata.get("locked_for_user") or metadata.get("downloadable") is False:
            raise CanvasError(403, message="老师尚未开放该文件，或当前账号没有权限。")
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Windows 的完整路径有限长；临时名独立且简短，避免长课件名再叠加 UUID。
        temporary = destination.with_name(".download-" + uuid.uuid4().hex + ".part")
        expected = metadata.get("size")
        if isinstance(expected, int) and expected > MAX_FILE_BYTES:
            raise CanvasError(0, message="该文件超过 2 GB，基础版本暂不自动下载；可从 Canvas 原页获取。")
        try:
            with self._open(url) as response, temporary.open("wb") as output:
                digest, size = hashlib.sha256(), 0
                content_type = response.headers.get("Content-Type", "application/octet-stream").split(";")[0]
                metadata_type = metadata.get("content-type") or metadata.get("content_type") or ""
                if content_type == "text/html" and metadata_type and metadata_type != "text/html":
                    raise CanvasError(0, message="下载地址返回了登录或错误页面，旧文件已保留。")
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_FILE_BYTES:
                        raise CanvasError(0, message="该文件超过 2 GB，基础版本暂不自动下载；旧文件已保留。")
                    output.write(chunk)
                    digest.update(chunk)
                declared = response.headers.get("Content-Length")
                if ((declared and declared.isdigit() and size != int(declared))
                        or (isinstance(expected, int) and size != expected)):
                    raise CanvasError(0, message="文件下载不完整，旧文件已保留；请稍后刷新重试。")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
            return {"checksum": digest.hexdigest(), "size": size, "content_type": content_type}
        except (URLError, OSError, http.client.HTTPException):
            raise CanvasError(0, message="文件下载中断或无法保存，旧文件已保留。") from None
        finally:
            if temporary.exists():
                temporary.unlink()

    def rate_limit_remaining(self):
        value = self.last_headers.get("x-rate-limit-remaining")
        try:
            return float(value) if value is not None else None
        except ValueError:
            return None


if __name__ == "__main__":
    try:
        api = Canvas()
        api.get("/api/v1/users/self")
        print("Canvas 连接正常，凭证有效。")
    except CanvasError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
