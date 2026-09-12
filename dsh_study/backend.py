"""Configured sources, material operations, and bounded Agent reads."""

from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import json
import mimetypes
import os
import re
import threading
import uuid
from html.parser import HTMLParser
from pathlib import Path

from .canvas import Canvas, CanvasError, MAX_FILE_BYTES, load_env
from .library import _BodyParser, load_library, safe_url
from .material_sync import file_name, now, read_json, run_sync, safe_error, sync_lock, write_json

ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
TEXT_TYPES = {"application/json", "application/xml", "application/yaml", "application/javascript"}


class StudyError(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.status = code, status
        super().__init__(message)


def bounded_int(value, default, minimum, maximum):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise StudyError("invalid_arguments", f"整数参数必须在 {minimum} 至 {maximum} 之间。")
    return value


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in {"br", "p", "div", "li", "tr", "h1", "h2", "h3", "pre"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"p", "div", "li", "tr", "h1", "h2", "h3", "pre"}:
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)


class StudyBackend:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.token = load_env(self.root / ".env").get("STUDY_API_TOKEN", "")
        if len(self.token) < 24 or any(ord(c) < 33 or ord(c) > 126 for c in self.token):
            raise StudyError("not_configured", "根 .env 需要至少 24 位可打印 ASCII STUDY_API_TOKEN。")
        self.job_lock = threading.Lock()
        self.jobs = {}
        self.threads = {}
        self.sources_config()  # Reject invalid configuration before listening.
        for path in (self.root / "state" / "jobs").glob("*.json"):
            job = read_json(path, {})
            if isinstance(job, dict) and job.get("job_id") == path.stem:
                if job.get("status") == "running":
                    job.update(status="interrupted", error="后端进程已退出；缓存保留，可再次刷新。", finished_at=now())
                    write_json(path, job)
                self.jobs[path.stem] = job

    def authorized(self, header):
        return isinstance(header, str) and hmac.compare_digest(header.encode(), ("Bearer " + self.token).encode())

    def sources_config(self):
        try:
            config = json.loads((self.root / "sources.local.json").read_text(encoding="utf-8-sig"))
            rows = config["sources"]
            if not isinstance(rows, list):
                raise ValueError()
            result = {}
            for source in rows:
                if not isinstance(source, dict) or not isinstance(source.get("id"), str) or not ID.fullmatch(source["id"]):
                    raise ValueError()
                if source["id"] in result or source.get("type") not in {"canvas", "local"}:
                    raise ValueError()
                if source["type"] == "local":
                    if not isinstance(source.get("path"), str) or not source["path"]:
                        raise ValueError()
                    cid = source.get("course_id", "local")
                    if not isinstance(cid, str) or not ID.fullmatch(cid):
                        raise ValueError()
                    source["course_id"] = cid
                    source["course_name"] = source.get("course_name") or source.get("name") or cid
                else:
                    ids = source.get("course_ids")
                    if ids is not None and (not isinstance(ids, list) or any(not str(cid).isdigit() for cid in ids)):
                        raise ValueError()
                    for name in ("base_url_env", "token_env"):
                        if name in source and (not isinstance(source[name], str) or not re.fullmatch(r"[A-Z][A-Z0-9_]*", source[name])):
                            raise ValueError()
                result[source["id"]] = source
            return result
        except (OSError, ValueError, KeyError, TypeError):
            raise StudyError("not_configured", "sources.local.json 缺失或格式不正确，请参考 sources.example.json。") from None

    def source(self, source_id):
        source = self.sources_config().get(source_id) if isinstance(source_id, str) else None
        if source is None:
            raise StudyError("source_not_found", "来源不存在，请先调用 sources。", 404)
        return source

    def source_root(self, source):
        path = (self.root / "state" / "sources" / source["id"]).resolve()
        if not path.is_relative_to((self.root / "state" / "sources").resolve()):
            raise StudyError("unsafe_path", "来源缓存路径无效。")
        return path

    def canvas(self, source):
        return Canvas(self.root / ".env", source.get("base_url_env", "CANVAS_BASE_URL"), source.get("token_env", "CANVAS_API_TOKEN"))

    @staticmethod
    def source_info(source):
        return {"source_id": source["id"], "name": source.get("name") or source["id"], "type": source["type"],
                "operations": ["courses", "catalog", "refresh", "status", "read"] + (["import_local"] if source["type"] == "local" else [])}

    def library(self, source):
        return load_library(self.source_root(source))

    def course_info(self, source, course):
        resources = course.get("resources", [])
        return {"source_id": source["id"], "source_type": source["type"], "course_id": str(course["id"]),
                "name": course.get("name") or str(course["id"]), "status": course.get("status", "unsynced"),
                "updated_at": course.get("updated_at"), "errors": course.get("errors", []), "resource_count": len(resources),
                "available_count": sum(bool(r.get("local_path") or isinstance(r.get("body_html"), str)) for r in resources)}

    def resource_info(self, source, course, resource):
        fields = ("type", "title", "content_type", "size", "checksum", "updated_at", "downloaded_at", "status", "error", "change", "related_resources", "sources")
        result = {key: copy.deepcopy(resource[key]) for key in fields if key in resource}
        result.update(source_id=source["id"], source_type=source["type"], course_id=str(course["id"]), resource_id=resource["id"],
                      source_name=source.get("name") or source["id"], html_url=safe_url(resource.get("html_url")),
                      available=bool(resource.get("local_path") or isinstance(resource.get("body_html"), str)),
                      stale=resource.get("status") in {"stale", "removed"}, new=resource.get("change") == "new",
                      has_body=isinstance(resource.get("body_html"), str), has_file=bool(resource.get("local_path")))
        mime = resource.get("content_type", "")
        body = isinstance(resource.get("body_html"), str)
        plain_file = mime.startswith("text/") or mime in TEXT_TYPES
        result.update(representation="canvas_html_text" if body else "utf8_candidate" if plain_file else "binary",
                      text_available=body, extraction_status="not_required" if body else "decode_required" if plain_file else "parser_required")
        return result

    def find(self, args):
        source = self.source(args.get("source_id"))
        course = next((c for c in self.library(source)["courses"] if str(c["id"]) == str(args.get("course_id"))), None)
        if course is None:
            raise StudyError("course_not_found", "课程未缓存，请先调用 courses 和 refresh。", 404)
        resource = next((r for r in course.get("resources", []) if r["id"] == args.get("resource_id")), None)
        if resource is None:
            raise StudyError("resource_not_found", "资料不存在，请从 catalog 获取 resource_id。", 404)
        return source, course, resource

    def file(self, args):
        source, course, resource = self.find(args)
        if not resource.get("local_path"):
            raise StudyError("unavailable", resource.get("error") or "该资料没有可用的本地文件。", 409)
        cache = (self.source_root(source) / "state/materials/files").resolve()
        path = (self.source_root(source) / resource["local_path"]).resolve()
        if not path.is_relative_to(cache) or not path.is_file():
            raise StudyError("unavailable", "文件缓存缺失或路径无效，请刷新。", 409)
        return path, self.resource_info(source, course, resource)

    def call(self, operation, args):
        if not isinstance(args, dict):
            raise StudyError("invalid_arguments", "arguments 必须是 JSON 对象。")
        allowed = {"sources": set(), "courses": {"source_id", "live"},
                   "catalog": {"source_id", "course_id", "offset", "limit"}, "refresh": {"source_id", "course_id"},
                   "status": {"source_id", "job_id"}, "read": {"source_id", "course_id", "resource_id", "offset", "max_bytes"},
                   "import_local": {"source_id"}}
        if operation not in allowed:
            raise StudyError("unknown_operation", "未知操作。")
        if set(args) - allowed[operation]:
            raise StudyError("invalid_arguments", "操作包含未支持的参数；本地导入只接受配置的 source_id。")
        if operation == "sources":
            return {"sources": [self.source_info(s) for s in self.sources_config().values()]}
        if operation == "status":
            with self.job_lock:
                jobs = copy.deepcopy(list(self.jobs.values()))
            if args.get("job_id"):
                job = next((j for j in jobs if j["job_id"] == args["job_id"]), None)
                if job is None:
                    raise StudyError("job_not_found", "刷新任务不存在。", 404)
                return job
            sources = [self.source(args["source_id"])] if args.get("source_id") else list(self.sources_config().values())
            return {"sources": [{**self.source_info(s), **{k: self.library(s).get(k) for k in ("updated_at", "errors", "changes")}} for s in sources],
                    "jobs": sorted((j for j in jobs if j["source_id"] in {s["id"] for s in sources}), key=lambda j: j["started_at"], reverse=True)[:20]}
        source = self.source(args.get("source_id"))
        if operation == "courses":
            library = self.library(source)
            courses = library["courses"]
            live = args.get("live", False)
            if not isinstance(live, bool):
                raise StudyError("invalid_arguments", "live 必须是布尔值。")
            if live and source["type"] == "canvas":
                cached = {str(c["id"]): c for c in courses}
                rows = self.canvas(source).list("/api/v1/courses", {"enrollment_state": "active", "include[]": ["term"]})
                courses = [{**cached.get(str(row["id"]), {}), **row} for row in rows if source.get("course_ids") is None or str(row["id"]) in {str(cid) for cid in source["course_ids"]}]
            if source["type"] == "local" and not courses:
                courses = [{"id": source["course_id"], "name": source["course_name"], "status": "unsynced"}]
            return {"source_id": source["id"], "live": bool(live and source["type"] == "canvas"),
                    "courses": [self.course_info(source, c) for c in courses], "errors": [] if live else library.get("errors", [])}
        if operation == "catalog":
            library = self.library(source)
            courses = [c for c in library["courses"] if not args.get("course_id") or str(c["id"]) == str(args["course_id"])]
            if args.get("course_id") and not courses:
                raise StudyError("course_not_found", "课程尚未缓存，请先刷新。", 404)
            resources = [self.resource_info(source, c, r) for c in courses for r in c.get("resources", [])]
            offset = bounded_int(args.get("offset"), 0, 0, 2**31 - 1)
            limit = bounded_int(args.get("limit"), 100, 1, 500)
            return {"source_id": source["id"], "updated_at": library.get("updated_at"), "errors": library.get("errors", []), "changes": library.get("changes", []),
                    "courses": [{**self.course_info(source, c), "modules": copy.deepcopy(c.get("modules", []))} for c in courses],
                    "resources": resources[offset:offset + limit], "total": len(resources), "offset": offset,
                    "next_offset": offset + limit if offset + limit < len(resources) else None}
        if operation in {"refresh", "import_local"}:
            if operation == "import_local" and source["type"] != "local":
                raise StudyError("invalid_source", "import_local 仅适用于配置的本地来源。")
            if source["type"] == "local" and args.get("course_id") not in (None, source["course_id"]):
                raise StudyError("course_not_found", "本地课程标识不匹配。", 404)
            course_ids = source.get("course_ids")
            if source["type"] == "canvas" and args.get("course_id") is not None:
                cid = str(args["course_id"])
                if not cid.isdigit() or (course_ids is not None and cid not in {str(c) for c in course_ids}):
                    raise StudyError("course_not_found", "课程不在该来源允许范围内。", 404)
                course_ids = [cid]
            return self.start_job(source, course_ids)
        if operation == "read":
            source, course, resource = self.find(args)
            result = self.resource_info(source, course, resource)
            offset = bounded_int(args.get("offset"), 0, 0, 2**63 - 1)
            maximum = bounded_int(args.get("max_bytes"), 65536, 1, 262144)
            if isinstance(resource.get("body_html"), str):
                # The sanitizer removes active HTML. No legacy webpage routes are exposed.
                parser = _BodyParser({"courses": []}, course, resource)
                parser.feed(resource["body_html"])
                safe_html = parser.finish()
                plain = PlainText()
                plain.feed(safe_html)
                data = "".join(plain.parts).strip().encode("utf-8")
                chunk = data[offset:offset + maximum]
                result.update(kind="body", encoding="utf-8", base64=base64.b64encode(chunk).decode("ascii"),
                              size=len(data), offset=offset, bytes_returned=len(chunk), next_offset=offset + len(chunk) if offset + len(chunk) < len(data) else None,
                              truncated=offset + len(chunk) < len(data))
                try:
                    result["text"] = chunk.decode("utf-8")
                except UnicodeError:
                    result.update(text_available=False, extraction_status="decode_required",
                                  text_note="此字节范围截断了 UTF-8 字符；请拼接 base64 字节后解码。")
                if offset == 0 and len(safe_html.encode("utf-8")) <= maximum:
                    result["safe_html"] = safe_html
                return result
            path, result = self.file(args)
            with path.open("rb") as stream:
                stream.seek(offset)
                chunk = stream.read(maximum)
            size = path.stat().st_size
            result.update(kind="file", encoding="base64", base64=base64.b64encode(chunk).decode("ascii"), size=size, offset=offset,
                          bytes_returned=len(chunk), next_offset=offset + len(chunk) if offset + len(chunk) < size else None, truncated=offset + len(chunk) < size)
            mime = result.get("content_type", "")
            if mime.startswith("text/") or mime in TEXT_TYPES:
                try:
                    result["text"] = chunk.decode("utf-8-sig")
                    result["text_encoding"] = "utf-8"
                    result.update(representation="utf8_text", text_available=True, extraction_status="not_required")
                except UnicodeError:
                    result["text_note"] = "此范围不是完整 UTF-8 文本；使用 base64 原始字节。"
            else:
                result["text_note"] = "提供原始文件字节；本后端不进行 PDF、Office、图片或音视频语义提取。"
            return result
        raise StudyError("unknown_operation", "未知操作。")

    def start_job(self, source, course_ids):
        with self.job_lock:
            current = next((j for j in self.jobs.values() if j["source_id"] == source["id"] and j["status"] == "running"), None)
            if current:
                return {**copy.deepcopy(current), "started": False}
            jid = uuid.uuid4().hex
            job = {"job_id": jid, "source_id": source["id"], "course_ids": course_ids, "status": "running", "started_at": now(), "message": "开始刷新资料。"}
            self.jobs[jid] = job
            self.save_job(job)
            thread = threading.Thread(target=self.run_job, args=(jid, copy.deepcopy(source), course_ids), daemon=True, name="study-refresh-" + source["id"])
            self.threads[jid] = thread
            initial = copy.deepcopy(job)
            thread.start()
            return {**initial, "started": True}

    def save_job(self, job):
        write_json(self.root / "state" / "jobs" / (job["job_id"] + ".json"), job)

    def run_job(self, jid, source, course_ids):
        def progress(message):
            with self.job_lock:
                self.jobs[jid]["message"] = message
        try:
            manifest = self.import_local(source, progress) if source["type"] == "local" else run_sync(self.source_root(source), self.canvas(source), progress, course_ids)
            summary = {"status": "partial" if manifest.get("errors") else "completed", "errors": manifest.get("errors", []),
                       "change_count": len(manifest.get("changes", [])), "course_count": len(manifest["courses"]),
                       "resource_count": sum(len(c.get("resources", [])) for c in manifest["courses"]), "api_requests": manifest.get("api_requests")}
        except Exception as exc:
            summary = {"status": "failed", "error": str(exc) if isinstance(exc, StudyError) else safe_error(exc)}
        with self.job_lock:
            self.jobs[jid].update(summary, finished_at=now())
            self.save_job(self.jobs[jid])

    def import_local(self, source, progress):
        origin = Path(source["path"])
        if not origin.is_absolute():
            origin = self.root / origin
        origin = origin.resolve()
        if origin == self.root or self.root.is_relative_to(origin) or not origin.is_dir():
            raise StudyError("invalid_import_path", "本地来源目录不存在，或范围过宽；配置专用课件子目录。")
        root = self.source_root(source)
        directory = root / "state/materials"
        with sync_lock(directory):
            previous = load_library(root)
            old = {r["id"]: r for c in previous["courses"] for r in c.get("resources", [])}
            resources, errors, changes = {}, [], []
            complete = True
            def walk_error(_):
                nonlocal complete
                complete = False
                errors.append("本地目录部分不可读；未确认的旧资料已保留。")
            for folder, subdirs, filenames in os.walk(origin, followlinks=False, onerror=walk_error):
                subdirs[:] = sorted(n for n in subdirs if not n.startswith(".") and not (Path(folder) / n).is_symlink())
                for name in sorted(filenames):
                    path = Path(folder) / name
                    if name.startswith(".") or name.lower() in {"credentials.json", "secrets.json"} or path.is_symlink():
                        continue
                    if not path.resolve().is_relative_to(origin):
                        continue
                    relative = path.relative_to(origin).as_posix()
                    rid = "local:" + hashlib.sha256(relative.encode("utf-8")).hexdigest()[:24]
                    progress("导入「" + relative + "」")
                    prior = old.get(rid, {})
                    temp = None
                    try:
                        digest, size = hashlib.sha256(), 0
                        temp = directory / "files" / (".import-" + uuid.uuid4().hex + ".part")
                        temp.parent.mkdir(parents=True, exist_ok=True)
                        before = path.stat()
                        if before.st_size > MAX_FILE_BYTES:
                            raise StudyError("too_large", "文件超过 2 GB，未导入。")
                        with path.open("rb") as stream, temp.open("wb") as output:
                            while chunk := stream.read(1024 * 1024):
                                size += len(chunk)
                                if size > MAX_FILE_BYTES:
                                    raise StudyError("too_large", "文件超过 2 GB，未导入。")
                                digest.update(chunk)
                                output.write(chunk)
                            output.flush()
                            os.fsync(output.fileno())
                        after = path.stat()
                        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or size != before.st_size:
                            raise StudyError("changed_during_import", "导入时文件发生变化；旧缓存保留，请重试。")
                        checksum = digest.hexdigest()
                        target = directory / "files" / (rid[6:18] + "-" + checksum[:12] + "-" + file_name(name))
                        os.replace(temp, target)
                        resource = {"id": rid, "type": "file", "title": relative, "content_type": mimetypes.guess_type(name)[0] or "application/octet-stream",
                                    "local_path": target.relative_to(root).as_posix(), "checksum": checksum, "fingerprint": checksum, "size": size,
                                    "downloaded_at": now(), "status": "ready", "sources": ["configured_local_directory"],
                                    "change": "new" if not prior else "updated" if prior.get("checksum") != checksum or prior.get("status") == "removed" else None}
                    except (OSError, StudyError) as exc:
                        message = str(exc) if isinstance(exc, StudyError) else "文件不可读或无法保存；旧缓存保留。"
                        errors.append(relative + "：" + message)
                        resource = copy.deepcopy(prior or {"id": rid, "type": "file", "title": relative})
                        resource.update(status="stale" if prior.get("local_path") else "error", error=message, change=None)
                    finally:
                        if temp is not None:
                            temp.unlink(missing_ok=True)
                    resources[rid] = resource
                    if resource.get("change"):
                        changes.append(resource["change"] + "：" + relative)
            for rid, prior in old.items():
                if rid not in resources:
                    resource = copy.deepcopy(prior)
                    resource.update(status="removed" if complete else "stale", error="已不在当前本地目录中，保留旧缓存。" if complete else "目录检查未完成，保留旧缓存。",
                                    change="removed" if complete and prior.get("status") != "removed" else None)
                    resources[rid] = resource
                    if resource.get("change"):
                        changes.append("removed：" + resource["title"])
            manifest = {"version": 1, "source": "local", "updated_at": now(), "changes": changes, "errors": errors,
                        "courses": [{"id": source["course_id"], "key": source["course_id"], "name": source["course_name"], "modules": [],
                                     "resources": list(resources.values()), "status": "partial" if errors else "ready", "updated_at": now(), "errors": errors}]}
            write_json(directory / "manifest.json", manifest)
            return manifest
