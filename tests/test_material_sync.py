"""受控验证 Canvas 完整资料路径；python -m unittest discover -s tests。

不访问学校、不读取真实 .env：模拟列表权限失败、正文附件、文件替换与断网。
"""

import copy
import hashlib
import io
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from dsh_study.canvas import Canvas, CanvasError, public_addresses
from dsh_study.material_sync import process_alive, run_sync, sync_lock, write_json


class FakeCanvas:
    """以可观察调用记录证明从模块找到页面，再从页面取得二进制附件。"""
    base = "https://canvas.example.edu"

    def __init__(self):
        self.requests, self.calls, self.downloads = 0, [], []
        self.module_file = 11
        self.file_revision = "first"
        self.page_text = '<p>说明正文</p><a href="/courses/1/pages/details">细则</a>'
        self.announcement = "上课地点 A"
        self.failures = {}
        self.front_page = None
        self.file_options = {}
        self.lists = {
            "/api/v1/courses": [{"id": 1, "course_code": "SYNTHETIC_COURSE", "name": "Financial Accounting", "term": {"start_at": "2026-07-01"}}],
            "/api/v1/courses/1/modules": [{"id": 100, "name": "第一周", "items": [{"id": -1, "type": "File", "content_id": 999}]}],
            "/api/v1/courses/1/assignments": [{"id": 31, "name": "报告说明", "description": '<a href="/files/13/download">评分说明</a>', "updated_at": "2026-09-01"}],
        }

    def list(self, path, params=None):
        self.requests += 1
        self.calls.append(("list", path, params))
        if path in self.failures:
            raise CanvasError(self.failures[path])
        if path.endswith("/pages"):
            raise CanvasError(404)
        if path.endswith("/files"):
            raise CanvasError(403)
        if path == "/api/v1/announcements":
            return [{"id": 21, "title": "课程通知", "message": self.announcement, "updated_at": "2026-09-01"}]
        if path == "/api/v1/courses/1/modules/100/items":
            return [{"id": 101, "title": "讲义页", "type": "Page", "page_url": "lecture"},
                    {"id": 102, "title": "第一周.pdf", "type": "File", "content_id": self.module_file},
                    {"id": 103, "title": "小测", "type": "Quiz", "content_id": 999, "html_url": self.base + "/courses/1/quizzes/999"}]
        return copy.deepcopy(self.lists[path])

    def get(self, path, params=None):
        self.requests += 1
        self.calls.append(("get", path, params))
        if path in self.failures:
            raise CanvasError(self.failures[path])
        if path.endswith("/front_page"):
            if self.front_page is None:
                raise CanvasError(404)
            return copy.deepcopy(self.front_page), {}
        if path.endswith("/pages/lecture"):
            return {"title": "讲义页", "body": self.page_text, "updated_at": "2026-09-01",
                    "html_url": self.base + "/courses/1/pages/lecture"}, {}
        if path.endswith("/pages/details"):
            return {"title": "细则", "body": '<a href="/courses/1/files/12/download?verifier=PRIVATE">附件</a>'
                    '<img src="/api/v1/files/14"><a href="/courses/1/pages/lecture">返回</a>'
                    '<a href="https://evil.example/files/987/download">外站</a>', "updated_at": "2026-09-01"}, {}
        if path.startswith("/api/v1/files/"):
            identity = int(path.rsplit("/", 1)[1])
            data = self.file_bytes(identity)
            return {"id": identity, "display_name": f"资料 {identity}.pdf", "filename": f"{identity}.pdf", "content-type": "application/pdf",
                    "url": f"https://storage.example.edu/{identity}?Signature=PRIVATE", "size": len(data),
                    "updated_at": self.file_revision, **self.file_options}, {}
        raise CanvasError(404)

    def file_bytes(self, identity):
        return b"%PDF-1.4\n" + str(identity).encode() + self.file_revision.encode() + b"\n%%EOF"

    def download_file(self, metadata, path):
        if "download" in self.failures:
            raise CanvasError(0, message="文件下载中断或无法保存，旧文件已保留。")
        data = self.file_bytes(metadata["id"])
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(data)
        self.downloads.append(metadata["id"])
        return {"checksum": hashlib.sha256(data).hexdigest(), "size": len(data), "content_type": "application/pdf"}


class MaterialSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.api = FakeCanvas()

    def tearDown(self):
        self.temp.cleanup()

    def sync(self):
        manifest = run_sync(self.root, self.api)
        self.assertEqual(manifest, json.loads((self.root / "state/materials/manifest.json").read_text(encoding="utf-8")))
        return manifest, {r["id"]: r for r in manifest["courses"][0]["resources"]}

    def test_permissions_fallback_fetches_recursive_pages_and_real_file_bytes(self):
        manifest, resources = self.sync()
        for identity in (11, 12, 13, 14):
            resource = resources[f"file:{identity}"]
            self.assertEqual(resource["status"], "ready")
            self.assertEqual((self.root / resource["local_path"]).read_bytes(), self.api.file_bytes(identity))
        self.assertIn("file:12", resources["page:details"]["related_resources"])
        self.assertEqual(resources["page:lecture"]["status"], "ready")
        paths = [path for _, path, _ in self.api.calls]
        self.assertNotIn("/api/v1/files/999", paths)  # 没有误信内嵌截断条目。
        self.assertFalse(any("quizzes" in path or "987" in path for path in paths))
        self.assertEqual(paths.count("/api/v1/courses/1/pages/lecture"), 1)
        self.assertTrue(any("文件列表不可用" in error for error in manifest["errors"]))
        announcement_params = [params for _, path, params in self.api.calls if path == "/api/v1/announcements"][0]
        self.assertEqual(announcement_params["start_date"], "2026-07-01")
        self.assertFalse((self.root / "student").exists())

    def test_file_and_body_edits_detected_and_unchanged_files_not_downloaded(self):
        _, first = self.sync()
        old_path = self.root / first["file:11"]["local_path"]
        old_bytes = old_path.read_bytes()
        self.api.downloads.clear()
        _, unchanged = self.sync()
        self.assertEqual(self.api.downloads, [])
        self.assertIsNone(unchanged["file:11"]["change"])
        self.api.file_revision = "replacement"
        self.api.announcement = "上课地点 B"  # 时间戳不变也要检测正文变化。
        _, updated = self.sync()
        self.assertEqual(updated["announcement:21"]["change"], "updated")
        self.assertEqual(updated["file:11"]["change"], "updated")
        self.assertNotEqual(updated["file:11"]["local_path"], first["file:11"]["local_path"])
        self.assertEqual(old_path.read_bytes(), old_bytes)
        self.assertEqual((self.root / updated["file:11"]["local_path"]).read_bytes(), self.api.file_bytes(11))

    def test_relative_page_and_attachment_links_use_the_document_url(self):
        self.api.page_text = '<p>讲义</p><a href="details">同目录细则</a><a href="../files/16/download">上级附件</a>'
        _, resources = self.sync()
        self.assertIn("page:details", resources["page:lecture"]["related_resources"])
        self.assertIn("file:16", resources["page:lecture"]["related_resources"])
        self.assertEqual(resources["page:details"]["status"], "ready")
        self.assertEqual((self.root / resources["file:16"]["local_path"]).read_bytes(), self.api.file_bytes(16))

    def test_corrupted_cache_is_redownloaded_even_when_metadata_is_unchanged(self):
        _, resources = self.sync()
        cached = self.root / resources["file:11"]["local_path"]
        cached.write_bytes(b"corrupted cached bytes")
        self.api.downloads.clear()
        _, repaired = self.sync()
        self.assertIn(11, self.api.downloads)
        self.assertEqual((self.root / repaired["file:11"]["local_path"]).read_bytes(), self.api.file_bytes(11))
        self.assertEqual(repaired["file:11"]["checksum"], hashlib.sha256(self.api.file_bytes(11)).hexdigest())

    def test_front_page_discovers_content_absent_from_modules_and_page_list(self):
        self.api.front_page = {"page_id": 51, "url": "welcome", "title": "课程首页", "body": '<a href="../files/16/download">首页附件</a>',
                               "html_url": self.api.base + "/courses/1/pages/welcome"}
        _, resources = self.sync()
        self.assertEqual(resources["page:welcome"]["status"], "ready")
        self.assertEqual(resources["page:welcome"]["sources"], ["front_page"])
        self.assertIn("file:16", resources["page:welcome"]["related_resources"])
        self.assertEqual((self.root / resources["file:16"]["local_path"]).read_bytes(), self.api.file_bytes(16))
        self.assertFalse(any(path.endswith("/pages/welcome") for _, path, _ in self.api.calls))

    def test_course_without_front_page_does_not_report_normal_404_as_failure(self):
        manifest, _ = self.sync()
        self.assertFalse(any("首页" in message for message in manifest["errors"]))

    def test_wiki_front_page_failure_is_visible_and_retains_old_body(self):
        self.api.lists["/api/v1/courses"][0]["default_view"] = "wiki"
        first_failure, _ = self.sync()
        self.assertTrue(any("首页未能读取" in message for message in first_failure["errors"]))
        self.api.front_page = {"page_id": 51, "url": "welcome", "title": "课程首页", "body": "首页正文"}
        _, first = self.sync()
        self.api.failures["/api/v1/courses/1/front_page"] = 403
        failed_manifest, failed = self.sync()
        self.assertEqual(failed["page:welcome"]["status"], "stale")
        self.assertEqual(failed["page:welcome"]["body_html"], first["page:welcome"]["body_html"])
        self.assertTrue(any("首页未能读取" in message for message in failed_manifest["errors"]))

    def test_hidden_file_with_a_valid_download_url_is_downloaded(self):
        self.api.file_options = {"hidden_for_user": True, "locked_for_user": False}
        _, resources = self.sync()
        self.assertEqual(resources["file:11"]["status"], "ready")
        self.assertIn(11, self.api.downloads)
        self.api.file_options["downloadable"] = False
        self.api.downloads.clear()
        _, denied = self.sync()
        self.assertEqual(denied["file:11"]["status"], "stale")
        self.assertEqual(self.api.downloads, [])

    def test_local_cache_omits_default_reading_subscription_and_progress_fields(self):
        self.api.lists["/api/v1/courses/1/modules"][0].update(state="completed", completed_at="2026-09-01")
        self.api.lists["/api/v1/courses/1/assignments"][0]["has_submitted_submissions"] = True
        original_list = self.api.list
        def list_with_personal_state(path, params=None):
            result = original_list(path, params)
            if path == "/api/v1/announcements":
                result[0].update(read_state="read", unread_count=0, subscribed=True)
            if path.endswith("/modules/100/items"):
                result[0]["completion_requirement"] = {"completed": True, "type": "must_view"}
            return result
        with patch.object(self.api, "list", side_effect=list_with_personal_state):
            _, resources = self.sync()
        cache = self.root / "state/materials/raw/course-1"
        assignments = json.loads((cache / "assignments.json").read_text(encoding="utf-8"))
        modules = json.loads((cache / "modules.json").read_text(encoding="utf-8"))
        items = json.loads((cache / "module-100.json").read_text(encoding="utf-8"))
        announcements = json.loads((cache / "announcements.json").read_text(encoding="utf-8"))
        self.assertNotIn("has_submitted_submissions", assignments[0])
        self.assertNotIn("state", modules[0])
        self.assertNotIn("completed_at", modules[0])
        self.assertNotIn("completion_requirement", items[0])
        self.assertTrue(all(key not in announcements[0] for key in ("read_state", "unread_count", "subscribed")))
        self.assertEqual(resources["assignment:31"]["status"], "ready")
        self.assertEqual(resources["page:lecture"]["status"], "ready")

    def test_replaced_module_file_and_removed_page_link_mark_old_resources_removed(self):
        self.sync()
        self.api.module_file = 15
        self.api.page_text = "<p>已删去附件和细则链接</p>"
        manifest, resources = self.sync()
        self.assertEqual(resources["file:11"]["status"], "removed")
        self.assertEqual(resources["file:15"]["change"], "new")
        self.assertEqual(resources["page:details"]["status"], "removed")
        self.assertEqual(resources["file:12"]["status"], "removed")
        self.assertTrue(any("顺序或内容" in change for change in manifest["changes"]))
        self.assertTrue((self.root / resources["file:11"]["local_path"]).is_file())

    def test_fetch_and_download_failures_preserve_previous_body_and_binary(self):
        _, first = self.sync()
        old_path = self.root / first["file:11"]["local_path"]
        data = old_path.read_bytes()
        self.api.file_revision = "new-revision"
        self.api.failures["download"] = 0
        self.api.failures["/api/v1/courses/1/pages/lecture"] = 403
        self.api.failures["/api/v1/courses/1/modules/100/items"] = 403
        _, failed = self.sync()
        self.assertEqual(failed["file:11"]["status"], "stale")
        self.assertEqual(failed["page:lecture"]["status"], "stale")
        self.assertEqual(failed["page:lecture"]["body_html"], first["page:lecture"]["body_html"])
        self.assertEqual(failed["file:11"]["local_path"], first["file:11"]["local_path"])
        self.assertEqual(old_path.read_bytes(), data)
        self.assertNotEqual(failed["file:12"]["status"], "removed")

    def test_announcement_closed_for_comments_retains_readable_body(self):
        announcement = {"id": 21, "title": "Synthetic announcement", "message": "<p>Synthetic body</p>", "locked_for_user": True, "lock_info": {"can_view": True}, "comments_disabled": True}
        self.assertTrue(announcement["locked_for_user"])
        self.assertTrue(announcement["lock_info"]["can_view"])
        self.assertTrue(announcement["comments_disabled"])
        original_list = self.api.list
        with patch.object(self.api, "list", side_effect=lambda path, params=None:
                          [copy.deepcopy(announcement)] if path == "/api/v1/announcements" else original_list(path, params)):
            _, resources = self.sync()
        resource = resources[f"announcement:{announcement['id']}"]
        self.assertEqual(resource["status"], "ready")
        self.assertEqual(resource["body_html"], announcement["message"])

    def test_assignment_closed_for_submissions_keeps_returned_description(self):
        assignment = self.api.lists["/api/v1/courses/1/assignments"][0]
        assignment.update(locked_for_user=True, lock_info={"can_view": True}, lock_explanation="Assignment is closed for submissions.")
        _, resources = self.sync()
        self.assertEqual(resources["assignment:31"]["status"], "ready")
        self.assertEqual(resources["assignment:31"]["body_html"], assignment["description"])

    def test_explicit_view_denial_without_body_does_not_create_ready_empty_assignment(self):
        assignment = self.api.lists["/api/v1/courses/1/assignments"][0]
        assignment.update(locked_for_user=True, lock_info={"can_view": False}, description=None)
        _, resources = self.sync()
        self.assertNotEqual(resources["assignment:31"]["status"], "ready")
        self.assertIn("未授权", resources["assignment:31"]["error"])

    def test_course_request_failure_leaves_manifest_untouched(self):
        self.sync()
        before = (self.root / "state/materials/manifest.json").read_bytes()
        self.api.failures["/api/v1/courses"] = 401
        with self.assertRaises(CanvasError):
            self.sync()
        self.assertEqual((self.root / "state/materials/manifest.json").read_bytes(), before)
        self.assertFalse((self.root / "state/materials/sync.lock").exists())

    def test_lock_rejects_overlap_and_recovers_confirmed_dead_process(self):
        directory = self.root / "state/materials"
        with sync_lock(directory):
            with self.assertRaises(CanvasError):
                with sync_lock(directory):
                    self.fail("overlapping lock")
        write_json(directory / "sync.lock", {"pid": 12345})
        with patch("dsh_study.material_sync.process_alive", return_value=False):
            with sync_lock(directory):
                self.assertEqual(json.loads((directory / "sync.lock").read_text())["pid"], os.getpid())
        self.assertTrue(process_alive(os.getpid()))


class FakeResponse(io.BytesIO):
    def __init__(self, data=b"%PDF-1.4\n%%EOF", headers=None):
        super().__init__(data)
        self.headers = headers or {"Content-Type": "application/pdf", "Content-Length": str(len(data))}


class CanvasTransportTests(unittest.TestCase):
    def make_canvas(self):
        api = Canvas.__new__(Canvas)
        api.base, api.host, api.token = "https://canvas.example.edu", "canvas.example.edu", "SYNTHETIC_TOKEN"
        api.requests, api.last_headers = 0, {}
        return api

    def test_download_redirect_drops_authorization_and_partial_download_is_not_installed(self):
        api = self.make_canvas()
        requests = []
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                if len(requests) == 1:
                    raise HTTPError(request.full_url, 302, "redirect", {"Location": "https://storage.example.edu/file?Signature=PRIVATE"}, io.BytesIO())
                return FakeResponse()
        api.opener = Opener()
        with tempfile.TemporaryDirectory() as temp, patch("dsh_study.canvas.public_addresses", return_value=["8.8.8.8"]):
            path = Path(temp) / "file.pdf"
            result = api.download_file({"url": api.base + "/files/1/download", "content-type": "application/pdf", "size": 14}, path)
            self.assertEqual(path.read_bytes(), b"%PDF-1.4\n%%EOF")
            self.assertEqual(requests[0].get_header("Authorization"), "Bearer SYNTHETIC_TOKEN")
            self.assertIsNone(requests[1].get_header("Authorization"))
            original = path.read_bytes()
            with self.assertRaises(CanvasError):
                api.download_file({"url": "https://storage.example.edu/file?Signature=PRIVATE", "size": 100}, path)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(Path(temp).glob("*.part")), [])

    def test_api_redirect_cannot_leak_token(self):
        api = self.make_canvas()
        requests = []
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                raise HTTPError(request.full_url, 302, "redirect", {"Location": "https://evil.example/api/v1/courses?secret=PRIVATE"}, io.BytesIO())
        api.opener = Opener()
        with patch("dsh_study.canvas.public_addresses", return_value=["8.8.8.8"]), self.assertRaises(CanvasError) as error:
            api.get("/api/v1/courses")
        self.assertEqual(len(requests), 1)
        self.assertNotIn("PRIVATE", str(error.exception))
        self.assertNotIn("SYNTHETIC_TOKEN", str(error.exception))

    def test_hidden_file_download_defers_to_server_and_explicit_restrictions(self):
        api = self.make_canvas()
        metadata = {"url": api.base + "/files/1/download", "hidden_for_user": True,
                    "locked_for_user": False, "size": 14, "content-type": "application/pdf"}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "file.pdf"
            with patch.object(api, "_open", return_value=FakeResponse()) as download:
                api.download_file(metadata, path)
                download.assert_called_once()
            self.assertEqual(path.read_bytes(), b"%PDF-1.4\n%%EOF")
            for restriction in ({"downloadable": False}, {"locked_for_user": True}):
                with self.subTest(restriction=restriction), patch.object(api, "_open") as download:
                    with self.assertRaises(CanvasError):
                        api.download_file({**metadata, **restriction}, path)
                    download.assert_not_called()
            with patch.object(api, "_open", side_effect=CanvasError(403)):
                with self.assertRaises(CanvasError):
                    api.download_file(metadata, path)
            self.assertEqual(path.read_bytes(), b"%PDF-1.4\n%%EOF")

    def test_long_windows_destination_uses_short_temporary_file_and_real_atomic_replace(self):
        api = self.make_canvas()
        metadata = {"url": api.base + "/files/1/download", "size": 14, "content-type": "application/pdf"}
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            filename = "lesson-" + "x" * 80 + ".pdf"
            # 实际最终路径为 225 字符；旧临时命名会增至 263，超过 Windows 传统上限。
            padding = 225 - len(str(base)) - len(filename) - 2
            if padding < 1:
                self.skipTest("Temporary root is too long to construct the controlled path fixture")
            directory = base / ("d" * padding)
            directory.mkdir()
            destination = directory / filename
            self.assertEqual(len(str(destination)), 225)
            self.assertGreater(len(str(destination)) + len("." + "x" * 32 + ".part"), 259)
            destination.write_bytes(b"old version")
            original_replace = os.replace
            seen = []
            def checked_replace(source, target):
                self.assertLessEqual(len(str(source)), 259)
                self.assertEqual(Path(source).parent, destination.parent)
                self.assertEqual(Path(source).read_bytes(), b"%PDF-1.4\n%%EOF")
                seen.append(Path(source))
                return original_replace(source, target)
            with patch.object(api, "_open", return_value=FakeResponse()), patch("dsh_study.canvas.os.replace", side_effect=checked_replace):
                api.download_file(metadata, destination)
            self.assertEqual(len(seen), 1)
            self.assertEqual(destination.read_bytes(), b"%PDF-1.4\n%%EOF")
            self.assertFalse(seen[0].exists())
            self.assertEqual(list(directory.glob("*.part")), [])

    def test_pagination_fetches_all_pages_and_rejects_cross_origin_next(self):
        api = self.make_canvas()
        pages = [([{"id": 1}], {"link": '<https://canvas.example.edu/api/v1/courses?page=2>; rel="next"'}), ([{"id": 2}], {})]
        with patch.object(api, "get", side_effect=pages) as get:
            self.assertEqual(api.list("/api/v1/courses"), [{"id": 1}, {"id": 2}])
            self.assertEqual(get.call_count, 2)
        with self.assertRaises(CanvasError):
            api.get("https://evil.example/api/v1/courses")

    def test_private_and_local_download_targets_are_rejected(self):
        for url, address in (("https://127.0.0.1/file", "127.0.0.1"), ("https://localhost/file", "::1"),
                             ("https://metadata.example/file", "169.254.169.254"), ("https://internal.example/file", "10.0.0.1")):
            with self.subTest(url=url), patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]):
                with self.assertRaises(CanvasError):
                    public_addresses(url)
        with self.assertRaises(CanvasError):
            public_addresses("http://storage.example.edu/file")


if __name__ == "__main__":
    unittest.main()
