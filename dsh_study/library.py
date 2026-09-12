"""把已存 Canvas 资料整理成浏览目录，并安全显示正文。

供 app.py 调用 load_library / public_library / find_resource / render_body。
只读来源内的 state/materials/；不会读取凭证、联网或修改学习记录。
"""

from __future__ import annotations

import copy
import html
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlsplit, urlunsplit


_SECRET_QUERY = re.compile(
    r"^(?:access_token|token|auth|authorization|signature|sig|verifier|jwt|"
    r"secure_params|awsaccesskeyid|googleaccessid|x-amz-.*|x-goog-.*|oauth_.*)$", re.I
)
_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"}


def safe_url(value, base=""):
    """仅保留可公开跳转的 HTTP(S) 地址；签名下载地址不进入浏览器。"""
    if not isinstance(value, str) or not value:
        return None
    value = value.strip()
    if any(ord(c) < 32 or ord(c) == 127 for c in unquote(value)) or "\\" in unquote(value):
        return None
    try:
        url = urlsplit(urljoin(base, value))
        if url.scheme.lower() not in {"http", "https"} or not url.hostname or url.username or url.password:
            return None
        if any(_SECRET_QUERY.match(key) for key, _ in parse_qsl(url.query)):
            return None
        return urlunsplit((url.scheme.lower(), url.netloc, url.path, url.query, url.fragment))
    except ValueError:
        return None


def _read_json(path, fallback, errors):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(fallback, (dict, list)) and not isinstance(data, type(fallback)):
            raise ValueError("Unexpected snapshot shape")
        return data
    except FileNotFoundError:
        errors.append(f"缺少 {path.name}，这部分资料尚未保存。")
    except (OSError, ValueError):
        errors.append(f"无法读取 {path.name}；保留其他可用资料。")
    return copy.deepcopy(fallback)


def _array(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _snapshot(root):
    # This project never discovers a legacy raw/ tree or learner history.
    return {"version": 1, "updated_at": None, "snapshot": False, "courses": [],
            "errors": ["No material manifest yet; refresh the configured source."], "changes": []}


def load_library(root):
    """优先读取新同步清单；没有清单时提供诚实标注的旧快照。"""
    root = Path(root).resolve()
    manifest = root / "state" / "materials" / "manifest.json"
    if manifest.is_file():
        errors = []
        result = _read_json(manifest, None, errors)
        if not isinstance(result, dict) or result.get("version") != 1 or not isinstance(result.get("courses"), list):
            result = _snapshot(root)
            result["errors"].extend(errors or ["同步清单格式不正确，当前显示上次保存的快照。"])
        else:
            result.setdefault("snapshot", False)
            result.setdefault("updated_at", None)
            result.setdefault("errors", [])
            result.setdefault("changes", [])
    else:
        result = _snapshot(root)
    # 缓存文件必须真实存在，且只允许读取专用资料目录内的文件。
    cache = (root / "state" / "materials" / "files").resolve()
    for course in _array(result.get("courses")):
        for resource in _array(course.get("resources")):
            resource["html_url"] = safe_url(resource.get("html_url"))
            path = resource.get("local_path")
            if path:
                try:
                    resolved = (root / path).resolve()
                    valid = cache.is_relative_to(root) and resolved.is_relative_to(cache) and resolved.is_file()
                except (OSError, ValueError, TypeError):
                    valid = False
                if not valid:
                    resource.pop("local_path", None)
                    if resource.get("type") == "file":
                        resource["status"] = "missing"
                        resource["error"] = "本地缓存文件不存在，请刷新重新下载。"
    return result


def public_library(library):
    """浏览目录使用白名单，避免原始 API 字段、正文或本机路径外泄。"""
    result = {key: copy.deepcopy(library.get(key)) for key in
              ("version", "updated_at", "snapshot", "snapshot_at") if key in library}
    for name in ("errors", "changes"):
        result[name] = [entry for entry in library.get(name, []) if isinstance(entry, str)]
    result["courses"] = []
    for course in _array(library.get("courses")):
        output = {key: copy.deepcopy(course.get(key)) for key in ("key", "id", "name")}
        output["errors"] = [entry for entry in course.get("errors", []) if isinstance(entry, str)]
        output["modules"] = []
        for module in _array(course.get("modules")):
            group = {"id": module.get("id"), "name": module.get("name"), "items": []}
            for item in _array(module.get("items")):
                exposed = {key: item.get(key) for key in ("id", "title", "type", "resource_id")}
                exposed["html_url"] = safe_url(item.get("html_url"))
                group["items"].append(exposed)
            output["modules"].append(group)
        output["resources"] = []
        for resource in _array(course.get("resources")):
            exposed = {key: resource.get(key) for key in
                       ("id", "type", "title", "content_type", "updated_at", "status", "error", "change") if key in resource}
            exposed["html_url"] = safe_url(resource.get("html_url"))
            exposed["has_file"] = bool(resource.get("local_path"))
            exposed["has_body"] = isinstance(resource.get("body_html"), str)
            exposed["related_resources"] = [rid for rid in resource.get("related_resources", []) if isinstance(rid, str)]
            output["resources"].append(exposed)
        result["courses"].append(output)
    return result


def find_resource(library, course_key, resource_id):
    """精确按课程和资料 ID 查找；没有则返回 None。"""
    for course in _array(library.get("courses")):
        if str(course.get("key")) == str(course_key):
            return next((r for r in _array(course.get("resources")) if str(r.get("id")) == str(resource_id)), None)
    return None


def _route(kind, key, rid):
    return "/api/" + kind + "?" + urlencode({"course": key, "id": rid})


class _BodyParser(HTMLParser):
    _allowed = set("a abbr b blockquote br caption code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i ins li ol p pre s small span strong sub summary sup table tbody td tfoot th thead tr u ul".split())
    _discard = set("script style iframe frame frameset form object embed applet svg math template noscript audio video canvas textarea select button".split())
    _void = set("area base br col embed hr img input link meta param source track wbr".split())

    def __init__(self, library, course, resource):
        super().__init__(convert_charrefs=True)
        self.library = library
        self.course = course
        self.resource = resource
        self.output = []
        self.blocked = []
        self.open_tags = []
        self.base = safe_url(resource.get("html_url")) or safe_url(course.get("html_url")) or ""
        if not self.base:
            self.base = next((safe_url(r.get("html_url")) for r in _array(course.get("resources")) if safe_url(r.get("html_url"))), "")
        self.hosts = {urlsplit(url).netloc.lower() for c in _array(library.get("courses"))
                      for r in _array(c.get("resources")) if (url := safe_url(r.get("html_url")))}

    def cached_target(self, value):
        if not isinstance(value, str):
            return None
        # 签名链接不公开，但可以根据 Canvas 的文件 ID 找到已缓存副本。
        try:
            url = urlsplit(urljoin(self.base, value))
        except ValueError:
            return None
        if url.scheme not in {"http", "https"} or url.netloc.lower() not in self.hosts:
            return None
        path = unquote(url.path)
        course_id = None
        match = re.search(r"/(?:api/v1/)?courses/([^/]+)/(pages|files|assignments|discussion_topics|modules/items)/([^/]+)", path)
        if match:
            course_id, kind, item_id = match.groups()
        else:
            match = re.fullmatch(r"/(?:api/v1/)?files/(\d+)(?:/.*)?", path)
            if not match:
                return None
            kind, item_id = "files", match[1]
        for course in _array(self.library.get("courses")):
            if course_id is not None and str(course.get("id")) != course_id:
                continue
            rid = {"pages": "page:", "files": "file:", "assignments": "assignment:", "discussion_topics": "announcement:"}.get(kind, "") + item_id
            if kind == "modules/items":
                rid = next((i.get("resource_id") for m in _array(course.get("modules")) for i in _array(m.get("items")) if str(i.get("id")) == item_id), None)
            target = find_resource(self.library, course.get("key"), rid)
            if target and (target.get("local_path") or isinstance(target.get("body_html"), str)):
                route = "file" if target.get("type") == "file" else "body"
                return target, _route(route, course.get("key"), target["id"])
        return None

    def handle_starttag(self, tag, attrs):
        if self.blocked:
            if tag not in self._void:
                self.blocked.append(tag)
            return
        if tag in self._discard:
            if tag not in self._void:
                self.blocked.append(tag)
            return
        attrs = dict(attrs)
        if tag == "img":
            target = self.cached_target(attrs.get("src")) or self.cached_target(attrs.get("data-api-endpoint"))
            if target and target[0].get("type") == "file" and target[0].get("content_type", "").split(";")[0].lower() in _IMAGE_TYPES:
                self.output.append('<img src="' + html.escape(target[1], quote=True) + '" alt="' + html.escape(attrs.get("alt") or "", quote=True) + '">')
            else:
                self.output.append("<span>[图片未缓存" + ("：" + html.escape(attrs["alt"]) if attrs.get("alt") else "") + "]</span>")
            return
        if tag not in self._allowed:
            return
        clean = []
        if tag == "a":
            target = self.cached_target(attrs.get("href"))
            href = target[1] if target else safe_url(attrs.get("href"), self.base)
            if href:
                clean += [("href", href), ("target", "_blank"), ("rel", "noreferrer noopener")]
        for name in ("title", "lang", "dir"):
            if attrs.get(name) and (name != "dir" or attrs[name] in {"ltr", "rtl", "auto"}):
                clean.append((name, attrs[name]))
        if tag in {"td", "th"}:
            for name in ("colspan", "rowspan"):
                if attrs.get(name, "").isdigit() and 0 < int(attrs[name]) <= 100:
                    clean.append((name, attrs[name]))
        self.output.append("<" + tag + "".join(" " + name + '="' + html.escape(value, quote=True) + '"' for name, value in clean) + ">")
        if tag not in self._void:
            self.open_tags.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self._void:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.blocked:
            if tag in self.blocked:
                self.blocked = self.blocked[:len(self.blocked) - 1 - self.blocked[::-1].index(tag)]
            return
        if tag in self.open_tags:
            index = len(self.open_tags) - 1 - self.open_tags[::-1].index(tag)
            for closing in reversed(self.open_tags[index:]):
                self.output.append("</" + closing + ">")
            self.open_tags = self.open_tags[:index]

    def handle_data(self, data):
        if not self.blocked:
            self.output.append(html.escape(data, quote=False))

    def finish(self):
        self.close()
        self.output.extend("</" + tag + ">" for tag in reversed(self.open_tags))
        return "".join(self.output)


def render_body(library, course_key, resource_id):
    """返回完整、安全的 HTML；不存在的资料抛 KeyError，供服务端返回 404。"""
    resource = find_resource(library, course_key, resource_id)
    if resource is None:
        raise KeyError("资料不存在")
    course = next(c for c in _array(library.get("courses")) if str(c.get("key")) == str(course_key))
    parser = _BodyParser(library, course, resource)
    parser.feed(resource.get("body_html") or "")
    body = parser.finish()
    warning = ""
    if resource.get("status") in {"missing", "error", "stale", "removed"}:
        labels = {"missing": "此资料尚未缓存。", "error": "本次获取失败。", "stale": "更新未成功，当前显示上次保存的内容。", "removed": "老师已移除此资料，当前显示之前保存的版本。"}
        warning = "<p><strong>" + labels[resource["status"]] + "</strong> " + html.escape(str(resource.get("error") or "")) + "</p>"
    if resource.get("type") == "file" and resource.get("local_path"):
        body = '<p><a href="' + html.escape(_route("file", course_key, resource_id), quote=True) + '" target="_blank" rel="noreferrer noopener">打开已保存的文件</a></p>'
    elif not body:
        body = "<p>此资料没有可显示的正文。</p>"
    source = safe_url(resource.get("html_url"))
    source_link = '<p><a href="' + html.escape(source, quote=True) + '" target="_blank" rel="noreferrer noopener">在 Canvas 或来源网站查看</a></p>' if source else ""
    title = html.escape(str(resource.get("title") or "课程资料"))
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + title + '</title></head><body><h1>' + title + "</h1>" + warning + body + source_link + "</body></html>"
