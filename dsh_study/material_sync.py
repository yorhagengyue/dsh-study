#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下载 Canvas 课程资料到本机；运行 python tools/material_sync.py，或由本机 App 调用。

仅 GET，只写 state/materials/。从列表、模块、公告／作业／页面正文发现资源；
没有列表权限时仍沿合法链接取单个资源。失败保留旧文件，完整清单原子替换。
"""

import copy
import ctypes
import hashlib
import json
import os
import re
import sys
import uuid
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

try:
    from .canvas import ROOT, Canvas, CanvasError
except ImportError:
    from canvas import ROOT, Canvas, CanvasError

TYPE_NAMES = {"file": "文件", "page": "页面", "assignment": "作业说明", "announcement": "公告"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return copy.deepcopy(default)


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def process_alive(pid):
    """只查询进程存活；Windows 不使用 os.kill，避免误触终止语义。"""
    if not isinstance(pid, int) or pid <= 0:
        return True
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87
        try:
            status = ctypes.c_ulong()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(status)) or status.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


@contextmanager
def sync_lock(directory):
    """CLI 与 App 共用排他锁；只回收已确认进程不存在的锁。"""
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / "sync.lock"
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        recovery = directory / "sync-recovery.lock"
        try:
            guard = os.open(recovery, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            raise CanvasError(0, message="其他进程正在恢复同步状态，请稍后重试。") from None
        try:
            os.close(guard)
            record = read_json(lock, {})
            if process_alive(record.get("pid")):
                raise CanvasError(0, message="已有资料同步正在运行，请等待完成。")
            lock.unlink(missing_ok=True)
            try:
                descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                raise CanvasError(0, message="已有资料同步正在运行，请等待完成。") from None
        finally:
            recovery.unlink(missing_ok=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump({"pid": os.getpid(), "started_at": now()}, stream)
        yield
    finally:
        lock.unlink(missing_ok=True)


def safe_error(exc):
    """不把第三方异常、网络地址或服务端正文带进界面。"""
    if isinstance(exc, CanvasError):
        return {401: "Canvas 凭证已失效，请在项目根 .env 更新。",
                403: "Canvas 未授权读取，或老师尚未开放。",
                404: "Canvas 暂时找不到该内容，可能已替换、隐藏或移除。",
                429: "Canvas 请求额度暂时不足，请稍后刷新。"}.get(exc.code, str(exc))
    if isinstance(exc, OSError):
        return "本机文件无法读取或保存，旧资料已保留。"
    return "Canvas 返回的数据不完整，旧资料已保留，请稍后刷新。"


def clean_url(value):
    """清单仅保留可回到 Canvas 的普通链接，不保留下载签名或验证码参数。"""
    try:
        parsed = urlsplit(str(value or ""))
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
            return ""
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    except ValueError:
        return ""


def file_name(value):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value or "file")).strip(" .")
    # Windows 项目路径较长，缩短文件名并保留扩展名，保证下载后仍能直接打开。
    suffix = Path(value).suffix[:20]
    return (value[:90 - len(suffix)] + suffix if len(value) > 90 else value) or "file"


def fingerprint(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def cache_rows(name, rows):
    """只剔除资料浏览不需要的默认个人状态，不改变正文、权限或模块引用。"""
    excluded = {
        "announcements": {"read_state", "unread_count", "subscribed", "subscription_hold",
                          "expanded", "expanded_locked", "user_can_see_posts"},
        "assignments": {"has_submitted_submissions", "submission", "submissions", "score_statistics",
                        "observed_users", "can_submit"},
        "modules": {"state", "completed_at"},
        "module_items": {"completion_requirement", "content_details"},
    }.get(name, set())
    result = []
    for row in rows:
        cleaned = {key: copy.deepcopy(value) for key, value in row.items() if key not in excluded}
        if name == "modules" and isinstance(cleaned.get("items"), list):
            cleaned["items"] = cache_rows("module_items", cleaned["items"])
        result.append(cleaned)
    return result


class ContentLinks(HTMLParser):
    """只解析链接，不执行页面脚本，不读取外站或测验提交内容。"""
    def __init__(self, base, course_id):
        super().__init__(convert_charrefs=True)
        self.base, self.course_id = base, str(course_id)
        self.links = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name not in ("href", "src", "data-api-endpoint", "data-download-url") or not value:
                continue
            try:
                parsed = urlsplit(urljoin(self.base, value))
                if parsed.scheme != "https" or parsed.netloc != urlsplit(self.base).netloc:
                    continue
                path = unquote(parsed.path)
                match = re.fullmatch(r"(?:/api/v1)?(?:/courses/\d+)?/files/(\d+)(?:/(?:download|preview))?/?", path)
                if match:
                    self.links.append(("file", match.group(1)))
                    continue
                match = re.fullmatch(r"(?:/api/v1)?/courses/(\d+)/pages/([^/]+)/?", path)
                if match and match.group(1) == self.course_id:
                    self.links.append(("page", match.group(2)))
                    continue
                match = re.fullmatch(r"(?:/api/v1)?/courses/(\d+)/assignments/(\d+)/?", path)
                if match and match.group(1) == self.course_id:
                    self.links.append(("assignment", match.group(2)))
            except ValueError:
                continue


class CourseSync:
    def __init__(self, root, api, key, course, previous, progress):
        self.root, self.api, self.key, self.course = root, api, key, course
        self.cid, self.previous, self.progress = str(course["id"]), previous or {}, progress
        self.base = api.base.rstrip("/")
        self.cache = root / "state" / "materials" / "raw" / key
        self.old = {r["id"]: r for r in self.previous.get("resources", [])}
        self.resources, self.sources, self.queue, self.seeds = {}, {}, deque(), {}
        self.successful_sources, self.errors, self.changes = set(), [], []
        self.incomplete_sources = set()

    def tell(self, text):
        if self.progress:
            self.progress(f"{self.key}：{text}")

    def error(self, label, exc):
        message = f"{label}：{safe_error(exc)}"
        if message not in self.errors:
            self.errors.append(message)
        return message

    def cached_list(self, name, path, params=None):
        try:
            rows = self.api.list(path, params)
            if not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows):
                raise CanvasError(0, message="Canvas 列表格式不完整，保留旧资料。")
            rows = cache_rows(name, rows)
            write_json(self.cache / f"{name}.json", rows)
            self.successful_sources.add(name)
            return rows, True
        except (CanvasError, OSError, ValueError, TypeError) as exc:
            self.error({"files": "文件列表不可用，继续沿模块和正文查找文件",
                        "pages": "页面列表不可用，继续沿模块和正文查找页面",
                        "announcements": "公告列表", "assignments": "作业列表", "modules": "模块目录"}.get(name, name), exc)
            rows = read_json(self.cache / f"{name}.json")
            if rows is None:
                rows = []
            return cache_rows(name, rows or []), False

    def enqueue(self, kind, identity, source, seed=None):
        if identity is None or str(identity) == "":
            return None
        identity = str(identity)
        if kind != "page" and not identity.isdigit():
            return None
        rid = f"{kind}:{identity}"
        if rid not in self.sources:
            self.queue.append((kind, identity))
            self.sources[rid] = set()
        self.sources[rid].add(source)
        if seed:
            self.seeds[rid] = seed
        return rid

    def parse_body(self, resource, raw=None):
        # 相对链接遵循正文所在页面的位置；不把资源的外站链接当作 Canvas 基址。
        body_url = resource.get("html_url") or ""
        target = urlsplit(body_url)
        if target.scheme != "https" or target.netloc != urlsplit(self.base).netloc:
            body_url = self.base + f"/courses/{self.cid}/"
        parser = ContentLinks(body_url, self.cid)
        parser.feed(resource.get("body_html") or "")
        links = parser.links
        for attachment in (raw or {}).get("attachments") or []:
            if isinstance(attachment, dict) and attachment.get("id"):
                links.append(("file", str(attachment["id"])))
        related = []
        for kind, identity in links:
            rid = self.enqueue(kind, identity, resource["id"])
            if rid and rid != resource["id"] and rid not in related:
                related.append(rid)
        resource["related_resources"] = related

    def body_resource(self, kind, identity, raw):
        body_key = "description" if kind == "assignment" else "message" if kind == "announcement" else "body"
        returned_body = raw.get(body_key)
        can_view = (raw.get("lock_info") or {}).get("can_view")
        # 公告的锁可能只关评论，作业的锁可能只关提交；API 已返回的正文仍可读。
        has_body = isinstance(returned_body, str) and bool(returned_body.strip())
        if raw.get("locked_for_user") and can_view is False and not has_body:
            raise CanvasError(403)
        if body_key not in raw or raw.get(body_key) is None:
            if (kind == "assignment" and body_key in raw
                    and (not raw.get("locked_for_user") or can_view is True)):
                body = ""  # Canvas 明确返回 null 表示尚未填写作业说明。
            else:
                raise CanvasError(0, message="Canvas 未返回该资料的正文，尚不能离线阅读。")
        else:
            body = raw[body_key]
            if not isinstance(body, str):
                raise CanvasError(0, message="Canvas 返回的正文格式不完整，尚不能离线阅读。")
        resource = {"id": f"{kind}:{identity}", "type": kind,
                    "title": raw.get("title") or raw.get("name") or self.old.get(f"{kind}:{identity}", {}).get("title") or TYPE_NAMES[kind],
                    "body_html": str(body), "status": "ready", "updated_at": raw.get("updated_at") or raw.get("posted_at"),
                    "html_url": clean_url(raw.get("html_url")), "change": None}
        if kind == "assignment":
            resource["due_at"] = raw.get("due_at")
        resource["fingerprint"] = fingerprint({k: resource.get(k) for k in ("title", "body_html", "due_at", "updated_at")})
        self.parse_body(resource, raw)
        self.successful_sources.add(resource["id"])
        return resource

    def pull_file(self, identity):
        metadata, _ = self.api.get(f"/api/v1/files/{identity}")
        # hidden_for_user 仅可能表示 Files 目录隐藏；按合法模块链接仍可下载。
        if metadata.get("locked_for_user") or metadata.get("downloadable") is False:
            raise CanvasError(403)
        rid = f"file:{identity}"
        title = metadata.get("display_name") or metadata.get("filename") or self.seeds.get(rid, {}).get("title") or "文件"
        info = {k: metadata.get(k) for k in ("id", "filename", "display_name", "updated_at", "modified_at", "size", "content-type")}
        stamp = fingerprint(info)
        old = self.old.get(rid, {})
        resource = {"id": rid, "type": "file", "title": title, "status": "ready", "change": None,
                    "updated_at": metadata.get("updated_at") or metadata.get("modified_at"),
                    "html_url": self.base + f"/courses/{self.cid}/files/{identity}",
                    "content_type": metadata.get("content-type") or "application/octet-stream", "fingerprint": stamp}
        old_path = (self.root / old.get("local_path", "__missing__")).resolve()
        allowed = (self.root / "state" / "materials" / "files").resolve()
        # 相同元数据仍验证缓存摘要；丢失或损坏时重新下载。
        valid = old_path.is_relative_to(allowed) and old_path.is_file()
        if valid and old.get("fingerprint") == stamp and old.get("checksum"):
            digest = hashlib.sha256()
            with old_path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            valid = digest.hexdigest() == old["checksum"]
        else:
            valid = False
        if valid:
            for field in ("local_path", "checksum", "size", "downloaded_at"):
                resource[field] = old.get(field)
        else:
            relative = Path("state/materials/files") / self.key / f"{identity}-{stamp[:12]}-{file_name(title)}"
            self.tell(f"下载「{title}」")
            result = self.api.download_file(metadata, self.root / relative)
            resource.update(result)
            resource.update(local_path=relative.as_posix(), downloaded_at=now())
        return resource

    def failed_resource(self, kind, identity, exc):
        rid = f"{kind}:{identity}"
        resource = copy.deepcopy(self.old.get(rid) or {"id": rid, "type": kind,
                                 "title": self.seeds.get(rid, {}).get("title") or self.seeds.get(rid, {}).get("name") or TYPE_NAMES[kind]})
        seed = self.seeds.get(rid, {})
        # 列表已提供名称时，失败提示仍沿用名称，避免所有受限附件都显示成“文件”。
        resource["title"] = seed.get("title") or seed.get("name") or seed.get("display_name") or seed.get("filename") or resource["title"]
        body_key = {"announcement": "message", "assignment": "description", "page": "body"}.get(kind)
        if "body_html" not in resource and body_key and body_key in seed:
            resource["body_html"] = seed[body_key] or ""
            resource["html_url"] = clean_url(seed.get("html_url"))
        available = "body_html" in resource or bool(resource.get("local_path") and (self.root / resource["local_path"]).is_file())
        resource.update(status="stale" if available else "error", error=self.error(f"「{resource['title']}」", exc), change=None)
        # 上次正文仍可读，关联附件仍可逐项检查，但不据旧正文推断移除。
        if resource.get("body_html"):
            self.parse_body(resource)
        return resource

    def pull_front_page(self):
        """首页不一定出现在模块或页面列表；作为独立来源继续发现正文及附件。"""
        self.tell("读取课程首页")
        rid = None
        try:
            raw, _ = self.api.get(f"/api/v1/courses/{self.cid}/front_page")
            identity = raw.get("url") or raw.get("page_id")
            if identity is None:
                raise CanvasError(0, message="Canvas 没有返回课程首页的页面标识。")
            rid = self.enqueue("page", identity, "front_page", raw)
            resource = self.body_resource("page", str(identity), raw)
            self.resources[rid] = resource
            write_json(self.cache / "front_page.json", raw)
            self.successful_sources.add("front_page")
        except (CanvasError, OSError, ValueError, TypeError, KeyError) as exc:
            if isinstance(exc, CanvasError) and exc.code == 404 and self.course.get("default_view") != "wiki":
                # 未把页面设为首页的课程可以正常返回 404，不代表资料同步失败。
                self.successful_sources.add("front_page")
                return
            self.error("课程首页未能读取，保留已缓存资料", exc)
            if rid:
                self.resources[rid] = self.failed_resource("page", rid.split(":", 1)[1], exc)

    def module_items(self, modules, fresh):
        result = []
        old_modules = {str(m["id"]): m for m in self.previous.get("modules", [])}
        if fresh:
            self.successful_sources.update(f"module:{mid}" for mid in old_modules)
        for module in modules:
            mid = str(module["id"])
            source = f"module:{mid}"
            try:
                # 不信 include[]=items 的内嵌截断版本，每次完整分页读取条目。
                items = self.api.list(f"/api/v1/courses/{self.cid}/modules/{mid}/items")
                items = cache_rows("module_items", items)
                self.successful_sources.add(source)
                write_json(self.cache / f"module-{mid}.json", items)
                items_fresh = True
            except (CanvasError, OSError, ValueError, TypeError) as exc:
                items = read_json(self.cache / f"module-{mid}.json")
                if items is None:
                    items = module.get("items") or []
                if not items and mid in old_modules:
                    items = old_modules[mid].get("items", [])
                self.successful_sources.discard(source)
                self.incomplete_sources.add(source)
                self.error(f"模块「{module.get('name', '未命名')}」条目，沿用旧目录", exc)
                items_fresh = False
            entry = {"id": module["id"], "name": module.get("name") or "未命名模块", "items": [],
                     "status": "ready" if items_fresh and fresh else "stale"}
            for item in items:
                kind = str(item.get("type", "")).lower()
                identity = item.get("page_url") if kind == "page" else item.get("content_id")
                if not identity and item.get("resource_id", "").startswith(kind + ":"):
                    identity = item["resource_id"].split(":", 1)[1]
                rid = self.enqueue(kind, identity, source, item) if kind in ("page", "file", "assignment") else None
                # 测验、LTI、外站和文字标题留目录入口，不请求作答、成绩或第三方页面。
                if not rid and kind != "subheader":
                    rid = f"external:{item['id']}"
                    self.resources[rid] = {"id": rid, "type": "external", "title": item.get("title") or "外部内容",
                                           "html_url": clean_url(item.get("external_url") or item.get("html_url")),
                                           "status": "missing", "error": "此项需要在 Canvas 原页查看，未提供离线正文。", "change": None,
                                           "sources": [source]}
                    self.sources[rid] = {source}
                entry["items"].append({"id": item["id"], "title": item.get("title") or "未命名内容", "type": kind,
                                       "resource_id": rid, "html_url": clean_url(item.get("html_url")),
                                       "indent": item.get("indent", 0)})
            result.append(entry)
        if self.previous.get("modules") and fresh:
            current = {str(m["id"]): m for m in result}
            for mid, module in current.items():
                old = old_modules.get(mid)
                if old is None:
                    self.changes.append(f"{self.key}：新增模块「{module['name']}」")
                elif module["status"] == "ready":
                    before = [(i.get("id"), i.get("title"), i.get("resource_id"), i.get("indent")) for i in old.get("items", [])]
                    after = [(i.get("id"), i.get("title"), i.get("resource_id"), i.get("indent")) for i in module.get("items", [])]
                    if old.get("name") != module["name"] or before != after:
                        self.changes.append(f"{self.key}：模块「{module['name']}」的名称、顺序或内容已变化")
            for mid, old in old_modules.items():
                if mid not in current:
                    self.changes.append(f"{self.key}：模块「{old['name']}」已移出当前目录")
        return result

    def run(self):
        self.tell("读取课程目录、公告和作业说明")
        since = ((self.course.get("term") or {}).get("start_at") or self.course.get("start_at") or "2000-01-01")[:10]
        until = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")
        announcements, anns_fresh = self.cached_list("announcements", "/api/v1/announcements",
             {"context_codes[]": [f"course_{self.cid}"], "start_date": since, "end_date": until})
        assignments, ass_fresh = self.cached_list("assignments", f"/api/v1/courses/{self.cid}/assignments", {"order_by": "due_at"})
        modules, mods_fresh = self.cached_list("modules", f"/api/v1/courses/{self.cid}/modules")
        pages, pages_fresh = self.cached_list("pages", f"/api/v1/courses/{self.cid}/pages")
        files, files_fresh = self.cached_list("files", f"/api/v1/courses/{self.cid}/files")
        tree = self.module_items(modules, mods_fresh)
        for kind, rows, fresh, source in (("announcement", announcements, anns_fresh, "announcements"),
                                        ("assignment", assignments, ass_fresh, "assignments")):
            for raw in rows:
                rid = self.enqueue(kind, raw.get("id"), source, raw)
                if rid and fresh:
                    try:
                        self.resources[rid] = self.body_resource(kind, str(raw["id"]), raw)
                    except CanvasError as exc:
                        self.resources[rid] = self.failed_resource(kind, str(raw["id"]), exc)
        for page in pages:
            self.enqueue("page", page.get("url") or page.get("page_id"), "pages", page)
        for attachment in files:
            self.enqueue("file", attachment.get("id"), "files", attachment)
        self.pull_front_page()

        # 页面链接可能再含页面与附件；队列去重保证循环链接只处理一次。
        while self.queue:
            kind, identity = self.queue.popleft()
            rid = f"{kind}:{identity}"
            if rid in self.resources:
                continue
            self.tell(f"读取{TYPE_NAMES[kind]}「{self.seeds.get(rid, {}).get('title') or self.seeds.get(rid, {}).get('name') or identity}」")
            try:
                if kind == "file":
                    resource = self.pull_file(identity)
                elif kind == "page":
                    raw, _ = self.api.get(f"/api/v1/courses/{self.cid}/pages/{quote(identity, safe='')}")
                    resource = self.body_resource(kind, identity, raw)
                elif kind == "assignment":
                    raw, _ = self.api.get(f"/api/v1/courses/{self.cid}/assignments/{identity}")
                    resource = self.body_resource(kind, identity, raw)
                else:
                    raw, _ = self.api.get(f"/api/v1/courses/{self.cid}/discussion_topics/{identity}")
                    resource = self.body_resource(kind, identity, raw)
                self.resources[rid] = resource
            except (CanvasError, OSError, ValueError, TypeError, KeyError) as exc:
                self.resources[rid] = self.failed_resource(kind, identity, exc)

        # 只在所有旧来源都已成功检查时标记消失；无权限绝不等同于删除。
        missing = {rid: copy.deepcopy(resource) for rid, resource in self.old.items() if rid not in self.resources}
        removed = set()
        for _ in range(len(missing) + 1):
            changed = False
            for rid, resource in missing.items():
                sources = resource.get("sources") or []
                if rid not in removed and sources and all(s in self.successful_sources or s in removed for s in sources):
                    removed.add(rid)
                    changed = True
            if not changed:
                break
        for rid, resource in missing.items():
            if rid in removed:
                resource.update(status="removed", error="该内容已不在本次可见目录或正文中；保留上次缓存。",
                                change="removed" if resource.get("status") != "removed" else None)
            else:
                resource.update(status="stale", error="本次未能确认所有来源，保留上次资料。", change=None)
            self.resources[rid] = resource
        for rid, resource in self.resources.items():
            if rid in self.sources:
                resource["sources"] = sorted(self.sources[rid])
            old = self.old.get(rid)
            if resource.get("status") == "ready":
                resource["change"] = "new" if old is None else "updated" if old.get("fingerprint") != resource.get("fingerprint") or old.get("status") == "removed" else None
            if resource.get("change"):
                verb = {"new": "新增", "updated": "更新", "removed": "移出当前目录"}[resource["change"]]
                self.changes.append(f"{self.key}：{verb}「{resource.get('title', '资料')}」")
        return {"key": self.key, "id": self.course["id"], "name": self.course.get("name") or self.key,
                "modules": tree, "resources": list(self.resources.values()), "errors": self.errors,
                "updated_at": now(), "status": "partial" if self.errors else "ready"}


def run_sync(root=ROOT, api=None, progress=None, course_ids=None):
    """同步并返回 manifest；progress(message) 可更新 App 状态，api 可注入受控测试替身。"""
    root = Path(root).resolve()
    directory = root / "state" / "materials"
    with sync_lock(directory):
        api = api or Canvas(env_file=root / ".env")
        if progress:
            progress("正在连接 Canvas，读取当前课程")
        previous = read_json(directory / "manifest.json")
        if previous is None:
            previous = {"courses": []}
        old_courses = {str(c["id"]): c for c in previous.get("courses", [])}
        courses = api.list("/api/v1/courses", {"enrollment_state": "active", "include[]": ["term"]})
        selected = None if course_ids is None else {str(cid) for cid in course_ids}
        picked, used = [], set()
        for course in courses:
            if selected is not None and str(course["id"]) not in selected:
                continue
            # Cache keys use safe identifiers, independent of school course-code formats.
            key = old_courses.get(str(course["id"]), {}).get("key") or "course-" + str(course["id"])
            if not re.fullmatch(r"[A-Za-z0-9_-]+", key):
                raise CanvasError(0, message="课程标识格式无效，已停止同步。")
            if key in used:
                key += "-" + str(course["id"])
            used.add(key)
            picked.append((key, course))
        manifest = {"version": 1, "updated_at": now(), "courses": [], "errors": [], "changes": [], "source": "canvas"}
        for key, course in sorted(picked, key=lambda pair: pair[0]):
            sync = CourseSync(root, api, key, course, old_courses.get(str(course["id"])), progress)
            result = sync.run()
            manifest["courses"].append(result)
            manifest["errors"].extend(f"{key}：{message}" for message in result["errors"])
            manifest["changes"].extend(sync.changes)
        active = {str(course["id"]) for _, course in picked}
        for cid, course in old_courses.items():
            if cid not in active:
                course = copy.deepcopy(course)
                if selected is not None and cid not in selected:
                    # A targeted refresh must not mark untouched courses stale.
                    manifest["courses"].append(course)
                    continue
                message = "本次未出现在当前课程列表，保留此前资料；可能已结课或权限改变。"
                course.update(status="stale", errors=[message])
                for resource in course.get("resources", []):
                    resource.update(status="stale", error=message, change=None)
                manifest["courses"].append(course)
                manifest["errors"].append(f"{course['key']}：{message}")
        if not manifest["courses"]:
            manifest["errors"].append("Canvas 未返回当前配置可见的课程。")
        manifest["updated_at"] = now()
        manifest["api_requests"] = getattr(api, "requests", None)
        write_json(directory / "manifest.json", manifest)
        if progress:
            progress("资料刷新结束；部分资料需要重试" if manifest["errors"] else "资料已刷新")
        return manifest


if __name__ == "__main__":
    try:
        manifest = run_sync(progress=print)
        print(f"已保留 {len(manifest['courses'])} 门课程；发现 {len(manifest['changes'])} 处变化，{len(manifest['errors'])} 项待处理。")
        sys.exit(1 if manifest["errors"] else 0)
    except (CanvasError, OSError, ValueError) as exc:
        print(safe_error(exc), file=sys.stderr)
        sys.exit(1)
