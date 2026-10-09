"""HTTP 合同和内存状态验证；所有服务都是 Fake，不发付费请求。"""

import asyncio
import threading
import unittest
from uuid import UUID

import httpx2 as httpx
from fastapi.testclient import TestClient

from server import SECURITY_HEADERS, create_app
from speech import validate_audio


WEBM = bytes([0x1A, 0x45, 0xDF, 0xA3]) + bytes(28)
URL = "https://voice.oss-cn-beijing.aliyuncs.com/fake.wav"


def report(question):
    return {"status": "answered", "answer": f"页面回答：{question}", "speechText": f"朗读：{question}",
            "sql": "SELECT 1", "rows": [{"total": "1599.00"}], "warning": "只代表已导入记录",
            "datasetId": "sales-demo", "version": "a" * 64, "metric": "未扣退款销售额", "scope": "已导入记录"}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.clock = 1000
        def transcribe(audio, mime):
            validate_audio(audio, mime)
            self.calls.append(("asr", audio, mime))
            return "转写的原问题"
        def analyze(question):
            self.calls.append(("analyze", question))
            return report(question)
        def synthesize(text):
            self.calls.append(("tts", text))
            return URL
        self.services = {"transcribe": transcribe, "analyze": analyze, "synthesize": synthesize}
        self.app = create_app(self.services, now_ms=lambda: self.clock)
        self.client = TestClient(self.app, base_url="http://127.0.0.1:5185")
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def ask(self, question="问题"):
        response = self.client.post("/api/ask", json={"question": question})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["answerId"]

    def test_transcribe_only_then_submit_edited_text_and_speak_by_id(self):
        response = self.client.post("/api/transcribe", content=WEBM, headers={"content-type": "audio/webm;codecs=opus"})
        self.assertEqual(response.json(), {"text": "转写的原问题"})
        self.assertEqual([call[0] for call in self.calls], ["asr"])
        result = self.client.post("/api/ask", json={"question": "  用户修改后的问题  "}).json()
        UUID(result["answerId"])
        self.assertEqual(result, {**report("用户修改后的问题"), "answerId": result["answerId"]})
        for _ in range(2):
            response = self.client.post("/api/speak", json={"answerId": result["answerId"], "text": "恶意替换的朗读内容"})
            self.assertEqual(response.json(), {"audioUrl": URL})
        self.assertEqual(self.calls[1:], [("analyze", "用户修改后的问题"), ("tts", "朗读：用户修改后的问题")])

    def test_page_assets_security_headers_and_no_server_source(self):
        for path, text in (("/", "确认并分析"), ("/app.js", "onstop"), ("/style.css", "#ask"), ("/vendor/lucide.js", "createIcons")):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn(text, response.text)
                self.assertNotIn("fake-test-key", response.text)
                self.assertNotIn("x-powered-by", response.headers)
                for name, value in SECURITY_HEADERS.items():
                    self.assertEqual(response.headers[name], value)
        self.assertEqual(self.client.head("/").status_code, 200)
        self.assertEqual(self.client.get("/favicon.ico").status_code, 204)
        self.assertEqual(self.client.get("/server.py").status_code, 404)
        self.assertEqual(self.client.get("/docs").status_code, 404)
        self.assertEqual(self.client.get("/openapi.json").status_code, 404)
        self.assertEqual(self.calls, [])

    def test_host_and_origin_boundaries(self):
        for host in ("evil.test", "127.0.0.1.evil.test", "localhost.evil.test", "[::1]", "LOCALHOST"):
            with self.subTest(host=host):
                response = self.client.post("/api/ask", json={"question": "问题"}, headers={"host": host})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json(), {"error": "只接受本机访问。"})
        for origin in ("http://evil.test", "http://localhost:5185", "https://127.0.0.1:5185", "null"):
            with self.subTest(origin=origin):
                response = self.client.get("/", headers={"origin": origin})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json(), {"error": "不接受其他网站发起的请求。"})
        self.assertEqual(self.client.get("/", headers={"origin": "http://127.0.0.1:5185"}).status_code, 200)
        self.assertEqual(self.client.get("/", headers={"host": "localhost:5185", "origin": "http://localhost:5185"}).status_code, 200)
        self.assertEqual(self.calls, [])

    def test_invalid_question_types_and_utf16_length(self):
        for value in (None, "", " \ufeff ", [], {}, 123, "😀" * 1001, " " + "问" * 2000):
            with self.subTest(value_type=type(value).__name__):
                response = self.client.post("/api/ask", json={"question": value})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {"error": "请输入 1 到 2000 字符的问题。"})
        self.assertEqual(self.calls, [])
        self.ask("😀" * 1000)
        self.ask("\ufeff 问题 \ufeff")
        self.assertEqual(self.calls[-1], ("analyze", "问题"))

    def test_audio_size_and_format_errors_release_lock(self):
        for audio, mime, status in ((WEBM + bytes(2 * 1024 * 1024), "audio/webm", 413),
                                    (b"", "audio/ogg", 500), (WEBM, "audio/ogg", 500),
                                    (WEBM, "application/octet-stream", 500)):
            with self.subTest(mime=mime, status=status):
                response = self.client.post("/api/transcribe", content=audio, headers={"content-type": mime})
                self.assertEqual(response.status_code, status)
        self.assertEqual(self.calls, [])
        self.ask()

    def test_json_body_limits_bad_json_and_unknown_api(self):
        response = self.client.post("/api/ask", content=b" " * (16 * 1024 + 1), headers={"content-type": "application/json"})
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json(), {"error": "上传内容过大，请缩短录音。"})
        for body in (b'{"question":', b'"primitive"'):
            response = self.client.post("/api/ask", content=body, headers={"content-type": "application/json"})
            self.assertEqual(response.status_code, 500)
        for path in ("/api", "/api/unknown", "/api/ask"):
            self.assertEqual(self.client.get(path).json(), {"error": "接口不存在。"})
        self.assertEqual(self.calls, [])
        self.ask()

    def test_missing_invalid_and_foreign_answer_ids(self):
        identity = self.ask()
        for value in (None, "unknown", [], {}, 123):
            with self.subTest(value_type=type(value).__name__):
                response = self.client.post("/api/speak", json={"answerId": value})
                self.assertEqual(response.status_code, 410)
        with TestClient(create_app(self.services), base_url="http://localhost") as other:
            self.assertEqual(other.post("/api/speak", json={"answerId": identity}).status_code, 410)
        self.assertEqual(len(self.calls), 1)

    def test_cache_ttl_exactly_fifteen_minutes(self):
        identity = self.ask()
        self.clock += 15 * 60_000 - 1
        self.assertEqual(self.client.post("/api/speak", json={"answerId": identity}).status_code, 200)
        self.clock += 1
        self.assertEqual(self.client.post("/api/speak", json={"answerId": identity}).status_code, 410)
        self.assertEqual(sum(call[0] == "tts" for call in self.calls), 1)
        self.ask("新回答")
        self.assertEqual(self.client.post("/api/speak", json={"answerId": identity}).status_code, 410)

    def test_cache_capacity_and_fifo_not_lru(self):
        identities = [self.ask(str(index)) for index in range(10)]
        self.assertEqual(self.client.post("/api/speak", json={"answerId": identities[0]}).status_code, 200)
        self.ask("第十一条")
        self.assertEqual(self.client.post("/api/speak", json={"answerId": identities[0]}).status_code, 410)
        self.assertEqual(self.client.post("/api/speak", json={"answerId": identities[1]}).status_code, 200)

    def test_synthesis_failure_keeps_answer_and_can_manually_retry(self):
        identity = self.ask()
        calls = []
        def synthesize(text):
            calls.append(text)
            if len(calls) == 1:
                raise RuntimeError("fake TTS failed")
            return URL
        self.services["synthesize"] = synthesize
        failed = self.client.post("/api/speak", json={"answerId": identity})
        self.assertEqual(failed.status_code, 500)
        self.assertEqual(failed.json(), {"error": "fake TTS failed"})
        self.assertEqual(calls, ["朗读：问题"])
        for _ in range(2):
            self.assertEqual(self.client.post("/api/speak", json={"answerId": identity}).json(), {"audioUrl": URL})
        self.assertEqual(calls, ["朗读：问题", "朗读：问题"])

    def test_analysis_failure_releases_lock_without_answer_id(self):
        self.services["analyze"] = lambda *_: (_ for _ in ()).throw(RuntimeError("fake analysis failed"))
        failed = self.client.post("/api/ask", json={"question": "问题"})
        self.assertEqual(failed.status_code, 500)
        self.assertEqual(failed.json(), {"error": "fake analysis failed"})
        self.services["analyze"] = report
        self.ask()


class ConcurrentTests(unittest.IsolatedAsyncioTestCase):
    async def test_busy_request_returns_409_static_page_still_available(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def analyze(question):
            entered.set()
            await release.wait()
            return report(question)
        app = create_app({"analyze": analyze})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            task = asyncio.create_task(client.post("/api/ask", json={"question": "第一个"}))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                second = await client.post("/api/ask", json={"question": "第二个"})
                self.assertEqual(second.status_code, 409)
                self.assertEqual(second.json(), {"error": "上一次请求仍在处理，请稍后再试。"})
                self.assertEqual((await client.get("/")).status_code, 200)
            finally:
                release.set()
                response = await asyncio.wait_for(task, 2)
            self.assertEqual(response.status_code, 200)
            self.assertEqual((await client.post("/api/ask", json={"question": "下一个"})).status_code, 200)

    async def test_blocking_service_runs_in_thread_and_error_releases_lock(self):
        entered, release = threading.Event(), threading.Event()
        def analyze(question):
            entered.set()
            if not release.wait(3):
                raise RuntimeError("fake service timed out")
            raise RuntimeError("fake blocking failure")
        services = {"analyze": analyze}
        app = create_app(services)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            task = asyncio.create_task(client.post("/api/ask", json={"question": "问题"}))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                second = await asyncio.wait_for(client.post("/api/speak", json={"answerId": "unknown"}), 1)
                self.assertEqual(second.status_code, 409)
            finally:
                release.set()
                first = await asyncio.wait_for(task, 2)
            self.assertEqual(first.status_code, 500)
            services["analyze"] = report
            self.assertEqual((await client.post("/api/ask", json={"question": "新问题"})).status_code, 200)

    async def test_streamed_upload_is_bounded_before_any_service(self):
        calls = []
        app = create_app({"transcribe": lambda *_: calls.append("must not run")})
        async def stream():
            yield WEBM
            yield bytes(2 * 1024 * 1024)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            response = await client.post("/api/transcribe", content=stream(), headers={"content-type": "audio/webm"})
            self.assertEqual(response.status_code, 413)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
