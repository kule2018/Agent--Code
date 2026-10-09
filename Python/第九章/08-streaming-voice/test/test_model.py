"""Mock HTTP 验证完整 JSON、SSE 跨块、取消和 TTS；不访问真实接口。"""

import asyncio
import json
import unittest

import httpx2 as httpx

from server.model import AnalysisModel
from server.turn import CancelSignal, TurnCancelled
from server.tts import synthesize


ENV = {"DEEPSEEK_API_KEY": "fake-deepseek-key"}
SPEECH_ENV = {"DASHSCOPE_API_KEY": "fake-speech-key", "DASHSCOPE_BASE_URL": "https://test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"}
DECISION = {"action": "query", "sql": "SELECT 1", "metric": "测试", "scope": "测试"}


class BytesStream(httpx.AsyncByteStream):
    def __init__(self, data, pause=None):
        self.data, self.pause, self.closed = data, pause, False

    async def __aiter__(self):
        # 每 3 个字节切一次，特意让 UTF-8 中文与 SSE 分隔符跨网络块。
        for offset in range(0, len(self.data), 3):
            yield self.data[offset:offset + 3]
        if self.pause:
            self.pause.set()
            await asyncio.Event().wait()

    async def aclose(self):
        self.closed = True


def factory(handler, options=None):
    def create(**kwargs):
        if options is not None:
            options.append(kwargs)
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs)
    return create


def sse(events, *, done=True):
    return (": heartbeat\r\n\r\n" + "".join("data: " + json.dumps(e, ensure_ascii=False) + "\r\n\r\n" for e in events)
            + ("data: [DONE]\r\n\r\n" if done else "")).encode()


class ModelTests(unittest.IsolatedAsyncioTestCase):
    async def test_decision_and_true_sse_payloads_headers_and_utf8_chunks(self):
        requests, options, streams = [], [], []
        def handler(request):
            self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
            self.assertEqual(request.headers["Authorization"], "Bearer fake-deepseek-key")
            body = json.loads(request.content)
            requests.append(body)
            if not body.get("stream"):
                return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({**DECISION, "ignored": 1})}}]})
            stream = BytesStream(sse([{"choices": [{"delta": {"content": "华东"}, "finish_reason": None}]},
                                     {"choices": [{"delta": {"content": "1599元。"}, "finish_reason": None}]},
                                     {"choices": [{"delta": {}, "finish_reason": "stop"}]}]))
            streams.append(stream)
            return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=stream)
        model, signal = AnalysisModel(ENV, client_factory=factory(handler, options)), CancelSignal()
        decision = await model.decide("问题", {}, signal)
        self.assertEqual(decision, DECISION)
        self.assertEqual([p async for p in model.explain("问题", {"rules": ["只看样本"]}, decision, {"rows": []}, signal)], ["华东", "1599元。"])
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]["response_format"], {"type": "json_object"})
        self.assertEqual(requests[0]["max_tokens"], 2000)
        self.assertEqual(requests[1]["max_tokens"], 1000)
        self.assertNotIn("response_format", requests[1])
        self.assertEqual(json.loads(requests[1]["messages"][1]["content"]), {"question": "问题", "rules": ["只看样本"], "decision": decision, "result": {"rows": []}})
        for request in requests:
            self.assertEqual(request["model"], "deepseek-flash")
            self.assertEqual(request["thinking"], {"type": "disabled"})
            self.assertEqual(request["temperature"], 0)
        self.assertTrue(streams[0].closed)
        self.assertTrue(all(o == {"timeout": 60, "follow_redirects": False, "trust_env": False} for o in options))

    async def test_incomplete_decision_or_bad_schema_is_rejected_without_retry(self):
        cases = ({"finish_reason": "length", "message": {"content": "{}"}},
                 {"finish_reason": "stop", "message": {"content": ""}},
                 {"finish_reason": "stop", "message": {"content": '{"action":"query","sql":"SELECT 1"}'}},
                 {"finish_reason": "stop", "message": {"content": "not JSON"}})
        for choice in cases:
            calls = []
            def handler(request):
                calls.append(1)
                return httpx.Response(200, json={"choices": [choice]})
            with self.subTest(choice=choice), self.assertRaises(ValueError):
                await AnalysisModel(ENV, client_factory=factory(handler)).decide("问题", {}, CancelSignal())
            self.assertEqual(calls, [1])

    async def test_missing_stop_marks_partial_answer_incomplete(self):
        for reason in (None, "length"):
            stream = BytesStream(sse([{"choices": [{"delta": {"content": "部分回答"}, "finish_reason": reason}]}]))
            model = AnalysisModel(ENV, client_factory=factory(lambda _: httpx.Response(200, stream=stream)))
            parts = []
            with self.assertRaisesRegex(ValueError, "回答未完整生成"):
                async for part in model.explain("问题", {}, DECISION, {}, CancelSignal()):
                    parts.append(part)
            self.assertEqual(parts, ["部分回答"])
            self.assertTrue(stream.closed)

    async def test_cancel_while_sse_waits_closes_stream(self):
        waiting = asyncio.Event()
        stream = BytesStream(sse([{"choices": [{"delta": {"content": "部分"}}]}], done=False), waiting)
        model = AnalysisModel(ENV, client_factory=factory(lambda _: httpx.Response(200, stream=stream)))
        signal = CancelSignal()
        iterator = model.explain("问题", {}, DECISION, {}, signal)
        self.assertEqual(await anext(iterator), "部分")
        task = asyncio.create_task(anext(iterator))
        await waiting.wait()
        signal.abort()
        with self.assertRaises(TurnCancelled):
            await task
        self.assertTrue(stream.closed)

    async def test_precancel_and_http_errors_never_retry(self):
        calls = []
        def handler(request):
            calls.append(1)
            return httpx.Response(429, json={"error": {"message": "fake limit"}})
        signal = CancelSignal()
        signal.abort()
        model = AnalysisModel(ENV, client_factory=factory(handler))
        with self.assertRaises(TurnCancelled):
            await model.decide("问题", {}, signal)
        with self.assertRaises(TurnCancelled):
            await anext(model.explain("问题", {}, DECISION, {}, signal))
        self.assertEqual(calls, [])
        with self.assertRaises(httpx.HTTPStatusError):
            await model.decide("问题", {}, CancelSignal())
        self.assertEqual(calls, [1])
        with self.assertRaisesRegex(ValueError, "DEEPSEEK_API_KEY"):
            AnalysisModel({})


class TtsTests(unittest.IsolatedAsyncioTestCase):
    async def test_original_tts_payload_and_signed_https_url(self):
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(200, json={"output": {"audio": {"url": "http://test.oss-cn-beijing.aliyuncs.com/a.wav?Signature=fake%2Bvalue"}}})
        url = await synthesize("原始回答", CancelSignal(), env=SPEECH_ENV, client_factory=factory(handler))
        self.assertEqual(url, "https://test.oss-cn-beijing.aliyuncs.com/a.wav?Signature=fake%2Bvalue")
        self.assertEqual(str(calls[0].url), "https://test.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation")
        self.assertEqual(calls[0].headers["Authorization"], "Bearer fake-speech-key")
        self.assertEqual(json.loads(calls[0].content), {"model": "qwen3-tts-flash", "input": {"text": "原始回答", "voice": "Cherry", "language_type": "Chinese"}})

    async def test_text_limits_and_bad_audio_urls_or_provider_errors(self):
        for text in ("", "\ufeff ", "😀" * 601):
            with self.assertRaisesRegex(ValueError, "1 到 600"):
                await synthesize(text, CancelSignal(), env={}, client_factory=lambda **_: self.fail("不应发请求"))
        cases = ((200, {}, "没有返回音频地址"),
                 (200, {"output": {"audio": {"url": "https://evil.test/a.wav"}}}, "非预期音频地址"),
                 (401, {"error": {"message": "fake unauthorized"}}, "401：fake unauthorized"),
                 (200, {"code": "Failed", "message": "fake failure"}, "200：fake failure"))
        for status, body, message in cases:
            calls = []
            def handler(request):
                calls.append(1)
                return httpx.Response(status, json=body)
            with self.subTest(status=status), self.assertRaisesRegex(ValueError, message):
                await synthesize("回答", CancelSignal(), env=SPEECH_ENV, client_factory=factory(handler))
            self.assertEqual(calls, [1])

    async def test_cancel_during_tts_aborts_transport(self):
        entered, closed = asyncio.Event(), asyncio.Event()
        async def handler(request):
            try:
                entered.set()
                await asyncio.Event().wait()
            finally:
                closed.set()
        signal = CancelSignal()
        task = asyncio.create_task(synthesize("回答", signal, env=SPEECH_ENV, client_factory=factory(handler)))
        await entered.wait()
        signal.abort()
        with self.assertRaises(TurnCancelled):
            await task
        self.assertTrue(closed.is_set())


if __name__ == "__main__":
    unittest.main()
