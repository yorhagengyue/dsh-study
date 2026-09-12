"""验证资料快照适配与不可信正文处理。用 python -m unittest discover -s tests 运行。"""

import json
from pathlib import Path
import sys
import tempfile
import unittest

from dsh_study.library import find_resource, load_library, public_library, render_body, safe_url


BASE = "https://canvas.example.edu"


def example_library(body="<p>课程正文</p>"):
    return {"version": 1, "updated_at": None, "snapshot": False, "errors": [], "changes": [], "courses": [
        {"key": "COURSE", "id": 12, "name": "课程", "errors": [],
         "modules": [{"id": 1, "name": "第一周", "items": [
             {"id": 99, "title": "页面", "type": "Page", "resource_id": "page:week-1", "html_url": BASE + "/courses/12/modules/items/99"}]}],
         "resources": [
             {"id": "announcement:1", "type": "announcement", "title": "公告", "body_html": body, "html_url": BASE + "/courses/12/discussion_topics/1", "status": "ready"},
             {"id": "page:week-1", "type": "page", "title": "第一周", "body_html": "<p>已保存页面</p>", "html_url": BASE + "/courses/12/pages/week-1", "status": "ready"},
             {"id": "assignment:30", "type": "assignment", "title": "作业说明", "body_html": "<p>只显示说明</p>", "html_url": BASE + "/courses/12/assignments/30", "status": "ready"},
             {"id": "file:44", "type": "file", "title": "课件.pdf", "local_path": "state/materials/files/44.pdf", "content_type": "application/pdf", "html_url": BASE + "/courses/12/files/44", "status": "ready"},
             {"id": "file:45", "type": "file", "title": "图表.png", "local_path": "state/materials/files/45.png", "content_type": "image/png", "html_url": BASE + "/courses/12/files/45", "status": "stale"},
             {"id": "file:46", "type": "file", "title": "未保存.pdf", "html_url": BASE + "/courses/12/files/46", "status": "missing"},
         ]}
    ]}


class BodySafetyTests(unittest.TestCase):
    def render(self, body):
        return render_body(example_library(body), "COURSE", "announcement:1")

    def test_scripts_forms_frames_and_event_attributes_are_removed(self):
        output = self.render('''<p onclick="steal()" style="background:url(https://tracker)">保留正文</p>
            <script>alert('bad')</script><style>body{display:none}</style>
            <iframe src="https://evil">frame-content</iframe>
            <form action="https://evil"><input name="secret"><button>提交</button>form-content</form>
            <object data="https://evil">object-content</object><svg onload="evil()"><script>x</script></svg>
            <math><mtext><table><mglyph><style><!--</style><img src=x onerror=evil()></table></mtext></math>
            <p>结尾</p>''')
        self.assertIn("保留正文", output)
        self.assertIn("结尾", output)
        for forbidden in ("onclick", "style=", "<script", "<iframe", "<form", "<input", "<button", "<object", "<svg", "<math", "onerror", "alert(", "form-content", "frame-content", "object-content"):
            self.assertNotIn(forbidden, output)

    def test_semantic_tables_lists_and_escaped_text_survive(self):
        output = self.render('<h2>目标</h2><ul><li><strong>理解</strong></li></ul><table><tr><td colspan="2" rowspan="999">A &amp; B &lt; C</td></tr></table>')
        self.assertIn('<h2>目标</h2>', output)
        self.assertIn('<strong>理解</strong>', output)
        self.assertIn('<td colspan="2">A &amp; B &lt; C</td>', output)
        self.assertNotIn("rowspan", output)

    def test_unsafe_links_have_no_href_and_external_links_are_isolated(self):
        output = self.render('''<a href="javascript:alert(1)">坏</a><a href="data:text/html,payload">坏</a>
            <a href="java&#x09;script:alert(1)">坏</a><a href="https://user:pass@evil.test">坏</a>
            <a href="https://example.org/info?q=course" ping="https://tracker" target="_top">来源</a>''')
        for forbidden in ("javascript", "data:text", "user:pass", "ping=", 'target="_top"'):
            self.assertNotIn(forbidden, output)
        self.assertIn('href="https://example.org/info?q=course" target="_blank" rel="noreferrer noopener"', output)

    def test_saved_canvas_links_use_local_body_and_file_routes(self):
        output = self.render('''<a href="/courses/12/pages/week-1">页面</a>
            <a href="/courses/12/assignments/30">作业</a>
            <a href="/courses/12/modules/items/99">模块页面</a>
            <a href="/files/44/download?verifier=private">课件</a>''')
        self.assertEqual(output.count('/api/body?course=COURSE&amp;id=page%3Aweek-1'), 2)
        self.assertIn('/api/body?course=COURSE&amp;id=assignment%3A30', output)
        self.assertIn('/api/file?course=COURSE&amp;id=file%3A44', output)
        self.assertNotIn("private", output)

    def test_unknown_host_is_not_mapped_by_its_canvas_shaped_path(self):
        output = self.render('<a href="https://other.example/courses/12/files/44">外站</a>')
        self.assertIn('href="https://other.example/courses/12/files/44"', output)
        self.assertNotIn('/api/file?', output)

    def test_missing_files_keep_safe_source_links(self):
        output = self.render('<a href="/courses/12/files/46">未缓存文件</a>')
        self.assertIn('href="' + BASE + '/courses/12/files/46"', output)
        self.assertNotIn('/api/file?', output)

    def test_only_cached_raster_images_are_loaded(self):
        output = self.render('''<img src="/courses/12/files/45/preview?verifier=private" onerror="alert(1)" alt="图表">
            <img src="https://tracker.example/pixel.png" alt="外链图">
            <img src="data:image/svg+xml,evil" alt="内嵌图">
            <img src="/courses/12/files/44/preview" alt="非图片">''')
        self.assertEqual(output.count("<img "), 1)
        self.assertIn('/api/file?course=COURSE&amp;id=file%3A45', output)
        self.assertEqual(output.count("图片未缓存"), 3)
        self.assertNotIn("tracker.example", output)
        self.assertNotIn("verifier", output)
        self.assertNotIn("onerror", output)

    def test_stale_content_remains_readable_with_warning(self):
        data = example_library()
        resource = find_resource(data, "COURSE", "announcement:1")
        resource["status"] = "stale"
        resource["error"] = "网络暂时不可用"
        output = render_body(data, "COURSE", "announcement:1")
        self.assertIn("当前显示上次保存的内容", output)
        self.assertIn("课程正文", output)
        self.assertRaises(KeyError, render_body, data, "OTHER", "announcement:1")

    def test_public_directory_excludes_private_and_body_fields(self):
        data = example_library()
        resource = find_resource(data, "COURSE", "file:44")
        resource["download_url"] = "https://storage.example/file?signature=PRIVATE"
        resource["private"] = {"token": "PRIVATE"}
        resource["html_url"] = "https://storage.example/file?X-Amz-Signature=PRIVATE"
        output = public_library(data)
        serialized = json.dumps(output)
        for forbidden in ("PRIVATE", "local_path", "body_html", "download_url", "state/materials"):
            self.assertNotIn(forbidden, serialized)
        self.assertTrue(find_resource(output, "COURSE", "file:44")["has_file"])
        self.assertTrue(find_resource(output, "COURSE", "announcement:1")["has_body"])
        self.assertIn("body_html", find_resource(data, "COURSE", "announcement:1"))

    def test_safe_url_rejects_control_chars_credentials_and_signed_urls(self):
        for value in ("file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "https://host/%0aheader", "https://host/\\evil", "https://user:pass@host/a", "https://host/a?access_token=SECRET", "https://host/a?X-Amz-Signature=SECRET"):
            self.assertIsNone(safe_url(value), value)
        self.assertEqual(safe_url("/courses/1", BASE), BASE + "/courses/1")


class LibraryLoadingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def write_json(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def snapshot(self):
        self.write_json("raw/COURSE/course.json", {"id": 12, "name": "课程"})
        self.write_json("raw/COURSE/announcements.json", [{"id": 1, "title": "公告", "message": "<p>已保存公告</p>", "html_url": BASE + "/courses/12/discussion_topics/1", "secret_raw_field": "PRIVATE"}])
        self.write_json("raw/COURSE/assignments.json", [{"id": 30, "name": "作业说明", "description": "<p>已保存说明</p>", "html_url": BASE + "/courses/12/assignments/30"}])
        self.write_json("raw/COURSE/modules.json", [{"id": 10, "name": "第一周", "items": [
            {"id": 99, "type": "Page", "title": "未保存页面", "page_url": "week-1", "html_url": BASE + "/courses/12/modules/items/99"},
            {"id": 100, "type": "File", "title": "未保存课件", "content_id": 44},
            {"id": 101, "type": "Assignment", "title": "作业说明", "content_id": 30},
            {"id": 102, "type": "ExternalTool", "title": "外部工具", "html_url": BASE + "/courses/12/external_tools/1"},
            {"id": 103, "type": "SubHeader", "title": "资料"},
        ]}])

    def test_manifest_is_preferred_and_only_real_cache_files_are_ready(self):
        self.snapshot()
        data = example_library()
        self.write_json("state/materials/manifest.json", data)
        file_path = self.root / "state/materials/files/44.pdf"
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(b"%PDF-1.4 test")
        loaded = load_library(self.root)
        self.assertFalse(loaded["snapshot"])
        self.assertEqual(find_resource(loaded, "COURSE", "file:44")["status"], "ready")
        self.assertEqual(find_resource(loaded, "COURSE", "file:45")["status"], "missing")
        self.assertNotIn("local_path", find_resource(loaded, "COURSE", "file:45"))

    def test_legacy_raw_history_is_never_discovered_without_a_manifest(self):
        self.snapshot()
        loaded = load_library(self.root)
        self.assertEqual(loaded["courses"], [])
        self.assertTrue(loaded["errors"])

    def test_paths_outside_cache_are_refused(self):
        data = example_library()
        outside = self.root / "private.txt"
        outside.write_text("PRIVATE", encoding="utf-8")
        find_resource(data, "COURSE", "file:44")["local_path"] = "private.txt"
        find_resource(data, "COURSE", "file:45")["local_path"] = str(outside)
        self.write_json("state/materials/manifest.json", data)
        loaded = load_library(self.root)
        self.assertFalse(find_resource(public_library(loaded), "COURSE", "file:44")["has_file"])
        self.assertFalse(find_resource(public_library(loaded), "COURSE", "file:45")["has_file"])


if __name__ == "__main__":
    unittest.main()
