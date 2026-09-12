"""Controlled end-to-end HTTP tests. No school network or real credentials."""

import base64
import hashlib
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

from dsh_study.backend import StudyBackend, StudyError
from dsh_study.material_sync import run_sync, write_json
from dsh_study.server import StudyServer
from test_material_sync import FakeCanvas


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.token = "synthetic-api-token-for-controlled-tests"
        (self.root / ".env").write_text("STUDY_API_TOKEN=" + self.token + "\n", encoding="utf-8")
        self.origin = self.root / "input"
        self.origin.mkdir()
        (self.origin / "lesson.md").write_text("# 本地合成课件\n苹果共 12 个。", encoding="utf-8")
        (self.origin / "example.pdf").write_bytes(b"%PDF-1.4\nsynthetic\n%%EOF")
        (self.origin / ".env").write_text("NEVER_IMPORT=private", encoding="utf-8")
        self.config = {"sources": [
            {"id": "personal", "type": "local", "name": "合成来源", "path": "input", "course_id": "personal", "course_name": "个人示例"},
            {"id": "school", "type": "canvas", "name": "Canvas 合成来源"},
        ]}
        write_json(self.root / "sources.local.json", self.config)
        self.server = StudyServer(self.root, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.opener = build_opener(ProxyHandler({}))

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        for thread in self.server.backend.threads.values():
            thread.join(timeout=5)

    def request(self, route, payload=None, authorized=True, headers=None, method=None):
        extra = {"Authorization": "Bearer " + self.token} if authorized else {}
        if payload is not None:
            extra["Content-Type"] = "application/json"
        extra.update(headers or {})
        request = Request(self.url + route, data=None if payload is None else json.dumps(payload).encode("utf-8"), headers=extra, method=method)
        try:
            response = self.opener.open(request, timeout=10)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, dict(response.headers), response.read()

    def call(self, operation, arguments=None):
        status, _, body = self.request("/api/call", {"operation": operation, "arguments": arguments or {}})
        self.assertEqual(status, 200, body)
        envelope = json.loads(body)
        self.assertTrue(envelope["ok"])
        return envelope["result"]

    def finish_job(self, job):
        self.server.backend.threads[job["job_id"]].join(timeout=5)
        status = self.call("status", {"job_id": job["job_id"]})
        self.assertNotEqual(status["status"], "running")
        return status

    def import_and_catalog(self):
        status = self.finish_job(self.call("import_local", {"source_id": "personal"}))
        self.assertEqual(status["status"], "completed", status)
        return self.call("catalog", {"source_id": "personal", "course_id": "personal"})

    def test_health_is_minimal_and_every_material_route_requires_token(self):
        status, _, body = self.request("/health", authorized=False)
        health = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(health["project_root"], str(self.root.resolve()))
        self.assertNotIn(self.token, body.decode())
        for route, payload in (("/api/file", None), ("/api/call", {"operation": "sources"})):
            with self.subTest(route=route):
                status, _, body = self.request(route, payload, authorized=False)
                self.assertEqual(status, 401)
                self.assertEqual(json.loads(body)["error"]["code"], "unauthorized")
        status, _, _ = self.request("/api/call", {"operation": "sources"}, headers={"Origin": "https://other.example"})
        self.assertEqual(status, 403)

    def test_local_import_directory_read_and_binary_representation(self):
        sources = self.call("sources")
        self.assertEqual({s["source_id"] for s in sources["sources"]}, {"personal", "school"})
        self.assertNotIn("path", json.dumps(sources))
        initial = self.call("courses", {"source_id": "personal"})
        self.assertEqual(initial["courses"][0]["status"], "unsynced")
        catalog = self.import_and_catalog()
        self.assertEqual(catalog["total"], 2)
        self.assertTrue(all(r["new"] and r["available"] for r in catalog["resources"]))
        self.assertNotIn("NEVER_IMPORT", json.dumps(catalog))
        resources = {r["title"]: r for r in catalog["resources"]}
        text = resources["lesson.md"]
        result = self.call("read", {k: text[k] for k in ("source_id", "course_id", "resource_id")})
        self.assertEqual(result["text"], (self.origin / "lesson.md").read_bytes().decode("utf-8"))
        self.assertTrue(result["text_available"])
        self.assertEqual(result["representation"], "utf8_text")
        self.assertEqual(base64.b64decode(result["base64"]), (self.origin / "lesson.md").read_bytes())
        binary = resources["example.pdf"]
        result = self.call("read", {k: binary[k] for k in ("source_id", "course_id", "resource_id")})
        self.assertFalse(result["text_available"])
        self.assertEqual(result["extraction_status"], "parser_required")
        self.assertNotIn("text", result)
        self.assertEqual(result["checksum"], hashlib.sha256(base64.b64decode(result["base64"])).hexdigest())

    def test_local_update_unchanged_removal_and_failed_refresh_preserve_cache(self):
        first = self.import_and_catalog()
        unchanged = self.import_and_catalog()
        self.assertTrue(all(r["change"] is None for r in unchanged["resources"]))
        (self.origin / "lesson.md").write_text("Updated synthetic input", encoding="utf-8")
        (self.origin / "example.pdf").unlink()
        changed = self.import_and_catalog()
        resources = {r["title"]: r for r in changed["resources"]}
        self.assertEqual(resources["lesson.md"]["change"], "updated")
        self.assertEqual(resources["example.pdf"]["status"], "removed")
        self.assertTrue(resources["example.pdf"]["available"])
        args = {k: resources["example.pdf"][k] for k in ("source_id", "course_id", "resource_id")}
        self.assertTrue(self.call("read", args)["stale"])
        before = (self.root / "state/sources/personal/state/materials/manifest.json").read_bytes()
        self.origin.rename(self.root / "offline")
        job = self.finish_job(self.call("refresh", {"source_id": "personal"}))
        self.assertEqual(job["status"], "failed")
        self.assertEqual((self.root / "state/sources/personal/state/materials/manifest.json").read_bytes(), before)
        self.assertTrue(self.call("read", args)["available"])

    def test_file_range_suffix_head_and_invalid_ranges(self):
        catalog = self.import_and_catalog()
        resource = next(r for r in catalog["resources"] if r["title"] == "example.pdf")
        route = "/api/file?" + urlencode({k: resource[k] for k in ("source_id", "course_id", "resource_id")})
        expected = (self.origin / "example.pdf").read_bytes()
        status, headers, data = self.request(route, headers={"Range": "bytes=2-8"})
        self.assertEqual((status, data), (206, expected[2:9]))
        self.assertEqual(headers["Content-Range"], f"bytes 2-8/{len(expected)}")
        self.assertIn("attachment", headers["Content-Disposition"])
        status, _, data = self.request(route, headers={"Range": "bytes=-5"})
        self.assertEqual((status, data), (206, expected[-5:]))
        status, headers, data = self.request(route, method="HEAD")
        self.assertEqual((status, data), (200, b""))
        self.assertEqual(int(headers["Content-Length"]), len(expected))
        for value in ("bytes=9999-", "bytes=0-1,3-4", "bytes=-0", "bytes=8-2"):
            status, headers, _ = self.request(route, headers={"Range": value})
            self.assertEqual(status, 416)
            self.assertEqual(headers["Content-Range"], f"bytes */{len(expected)}")

    def test_canvas_fallback_reaches_http_catalog_read_and_strict_utf8_slices(self):
        api = FakeCanvas()
        with patch.object(self.server.backend, "canvas", return_value=api):
            courses = self.call("courses", {"source_id": "school", "live": True})
            self.assertEqual(courses["courses"][0]["course_id"], "1")
            job = self.finish_job(self.call("refresh", {"source_id": "school", "course_id": "1"}))
        self.assertEqual(job["status"], "partial")
        catalog = self.call("catalog", {"source_id": "school", "course_id": "1", "limit": 2})
        self.assertGreater(catalog["total"], 2)
        self.assertEqual(catalog["next_offset"], 2)
        args = {"source_id": "school", "course_id": "1", "resource_id": "page:lecture"}
        body = self.call("read", args)
        self.assertIn("说明正文", body["text"])
        self.assertEqual(body["representation"], "canvas_html_text")
        cut = self.call("read", {**args, "max_bytes": 1})
        self.assertFalse(cut["text_available"])
        self.assertNotIn("text", cut)
        self.assertEqual(base64.b64decode(cut["base64"]), body["text"].encode("utf-8")[:1])
        args["resource_id"] = "file:11"
        result = self.call("read", {**args, "max_bytes": 5})
        self.assertEqual(base64.b64decode(result["base64"]), api.file_bytes(11)[:5])
        self.assertEqual(result["next_offset"], 5)
        self.assertEqual(result["extraction_status"], "parser_required")
        self.assertTrue(any("文件列表不可用" in error for error in catalog["errors"]))

    def test_manifest_path_escape_and_source_traversal_are_rejected(self):
        catalog = self.import_and_catalog()
        resource = catalog["resources"][0]
        path = self.root / "state/sources/personal/state/materials/manifest.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest["courses"][0]["resources"][0]["local_path"] = str(self.root / ".env")
        write_json(path, manifest)
        args = {k: resource[k] for k in ("source_id", "course_id", "resource_id")}
        status, _, body = self.request("/api/call", {"operation": "read", "arguments": args})
        self.assertEqual(status, 409)
        self.assertNotIn(self.token, body.decode())
        status, _, _ = self.request("/api/call", {"operation": "catalog", "arguments": {"source_id": "../personal"}})
        self.assertEqual(status, 404)

    def test_course_selection_does_not_mark_untouched_course_stale(self):
        api = FakeCanvas()
        cache = self.root / "standalone"
        run_sync(cache, api)
        manifest_path = cache / "state/materials/manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        untouched = {"id": 2, "key": "course-2", "name": "Untouched", "status": "ready", "resources": []}
        manifest["courses"].append(untouched)
        write_json(manifest_path, manifest)
        result = run_sync(cache, api, course_ids=["1"])
        self.assertEqual(next(c for c in result["courses"] if c["id"] == 2), untouched)
        self.assertTrue(any(c["id"] == 1 for c in result["courses"]))

    def test_interrupted_jobs_are_visible_after_restart(self):
        job = {"job_id": "old", "source_id": "personal", "status": "running", "started_at": "2026-01-01"}
        write_json(self.root / "state/jobs/old.json", job)
        replacement = StudyBackend(self.root)
        self.assertEqual(replacement.call("status", {"job_id": "old"})["status"], "interrupted")
        self.assertIn("缓存保留", replacement.call("status", {"job_id": "old"})["error"])

    def test_concurrent_refresh_reuses_job_and_agent_cannot_pass_import_path(self):
        entered, release = threading.Event(), threading.Event()
        original = self.server.backend.import_local
        def controlled_import(source, progress):
            entered.set()
            self.assertTrue(release.wait(5))
            return original(source, progress)
        with patch.object(self.server.backend, "import_local", side_effect=controlled_import):
            first = self.call("import_local", {"source_id": "personal"})
            self.assertTrue(entered.wait(5))
            second = self.call("refresh", {"source_id": "personal"})
            self.assertEqual(first["job_id"], second["job_id"])
            self.assertFalse(second["started"])
            release.set()
            self.assertEqual(self.finish_job(first)["status"], "completed")
        status, _, body = self.request("/api/call", {"operation": "import_local", "arguments": {"source_id": "personal", "path": str(self.root / ".env")}})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"]["code"], "invalid_arguments")

    def test_custom_canvas_env_field_names_and_source_filter(self):
        (self.root / ".env").write_text("STUDY_API_TOKEN=" + self.token + "\nEXAMPLE_URL=https://canvas.example.edu\nEXAMPLE_TOKEN=synthetic-canvas-token\n", encoding="utf-8")
        source = {"id": "example", "type": "canvas", "base_url_env": "EXAMPLE_URL", "token_env": "EXAMPLE_TOKEN", "course_ids": ["2"]}
        self.config["sources"].append(source)
        write_json(self.root / "sources.local.json", self.config)
        client = self.server.backend.canvas(source)
        self.assertEqual(client.base, "https://canvas.example.edu")
        self.assertEqual(client.token, "synthetic-canvas-token")
        with patch.object(self.server.backend, "canvas", return_value=FakeCanvas()):
            self.assertEqual(self.call("courses", {"source_id": "example", "live": True})["courses"], [])
        status, _, _ = self.request("/api/call", {"operation": "refresh", "arguments": {"source_id": "example", "course_id": "1"}})
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
