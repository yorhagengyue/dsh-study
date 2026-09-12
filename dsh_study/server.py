"""Loopback-only authenticated HTTP transport; never log request URLs or tokens."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

from . import __version__
from .backend import StudyBackend, StudyError
from .canvas import CanvasError
from .material_sync import process_alive, safe_error


class StudyServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, root, port=8766):
        self.backend = StudyBackend(root)
        super().__init__(("127.0.0.1", port), Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = "dsh-study/" + __version__

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def send_bytes(self, status, body=b"", headers=None):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; sandbox")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json(self, status, value):
        self.send_bytes(status, json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def check_access(self):
        # Agent-to-local-server API; browsers are not API clients and get no CORS grant.
        if self.headers.get("Origin"):
            raise StudyError("origin_rejected", "本地资料接口不接受浏览器跨源请求。", 403)
        if not self.server.backend.authorized(self.headers.get("Authorization")):
            raise StudyError("unauthorized", "需要有效的本机资料 API 凭证。", 401)

    def handle_error(self, exc):
        if isinstance(exc, StudyError):
            self.json(exc.status, {"ok": False, "error": {"code": exc.code, "message": str(exc)}})
        else:
            self.json(502 if isinstance(exc, CanvasError) else 500,
                      {"ok": False, "error": {"code": "canvas_error" if isinstance(exc, CanvasError) else "backend_error", "message": safe_error(exc)}})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            route = urlsplit(self.path)
            if route.path == "/health":
                return self.json(200, {"service": "dsh-study", "version": __version__, "project_root": str(self.server.backend.root)})
            self.check_access()
            if route.path != "/api/file":
                raise StudyError("not_found", "接口不存在。", 404)
            query = parse_qs(route.query)
            if any(len(v) != 1 for v in query.values()):
                raise StudyError("invalid_arguments", "查询参数不能重复。")
            path, resource = self.server.backend.file({key: values[0] for key, values in query.items()})
            size = path.stat().st_size
            start, end, status = 0, size - 1, 200
            value = self.headers.get("Range")
            if value:
                try:
                    if not value.startswith("bytes=") or "," in value:
                        raise ValueError()
                    first, last = value[6:].split("-", 1)
                    if first:
                        start, end = int(first), min(int(last), size - 1) if last else size - 1
                    else:
                        suffix = int(last)
                        if suffix <= 0:
                            raise ValueError()
                        start, end = max(0, size - suffix), size - 1
                    if start < 0 or start > end or start >= size:
                        raise ValueError()
                    status = 206
                except ValueError:
                    return self.send_bytes(416, headers={"Content-Range": f"bytes */{size}"})
            with path.open("rb") as stream:
                self.send_response(status)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(max(0, end - start + 1)))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Security-Policy", "default-src 'none'; sandbox")
                self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(resource["title"], safe=""))
                self.send_header("X-Study-Status", resource.get("status", "unknown"))
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                if self.command == "HEAD":
                    return
                stream.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = stream.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception as exc:
            self.handle_error(exc)

    def do_POST(self):
        try:
            self.check_access()
            if urlsplit(self.path).path != "/api/call":
                raise StudyError("not_found", "接口不存在。", 404)
            if self.headers.get("Transfer-Encoding"):
                raise StudyError("invalid_request", "仅接受有 Content-Length 的 JSON 请求。")
            if self.headers.get_content_type() != "application/json":
                raise StudyError("invalid_request", "Content-Type 必须是 application/json。", 415)
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if not 0 < length <= 65536:
                raise StudyError("invalid_request", "请求正文应为 1 至 65536 字节。", 413)
            try:
                request = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError):
                raise StudyError("invalid_request", "请求不是有效 JSON。") from None
            if not isinstance(request, dict) or not isinstance(request.get("operation"), str):
                raise StudyError("invalid_request", "需要 operation 字符串和 arguments 对象。")
            result = self.server.backend.call(request["operation"], request.get("arguments", {}))
            self.json(200, {"ok": True, "result": result})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception as exc:
            self.handle_error(exc)


def serve(root, port=8766, parent_pid=None):
    server = StudyServer(root, port)
    stop = threading.Event()
    if parent_pid:
        def watch_parent():
            while not stop.wait(2):
                if not process_alive(parent_pid):
                    server.shutdown()
                    return
        threading.Thread(target=watch_parent, daemon=True, name="study-parent-watch").start()
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        stop.set()
        server.server_close()
