"""假响应验证语音合同；不读取配置文件，不连接百炼、不使用真实 Key。"""

import base64
import io
import json
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

import speech


ENV = {"DASHSCOPE_API_KEY": "fake-test-key",
       "DASHSCOPE_BASE_URL": "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"}
WEBM = bytes([0x1A, 0x45, 0xDF, 0xA3]) + b"\x00" * 28
OGG = b"OggS" + b"\x00" * 28
AUDIO_URL = "http://voice.oss-cn-beijing.aliyuncs.com/a.wav?Expires=123&Signature=fake%2Bvalue"


class FakeResponse(io.BytesIO):
    def __init__(self, data, status=200):
        super().__init__(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        self.status = status


class SpeechTests(unittest.TestCase):
    def test_supported_audio_and_mime_parameters(self):
        self.assertEqual(speech.validate_audio(WEBM, "Audio/WebM;codecs=opus"), "audio/webm")
        self.assertEqual(speech.validate_audio(OGG, "audio/ogg"), "audio/ogg")
        self.assertEqual(speech.validate_audio(WEBM[:4] + bytes(2 * 1024 * 1024 - 4), "audio/webm"), "audio/webm")

    def test_audio_size_type_and_magic_errors(self):
        for data in (None, "not bytes", bytearray(WEBM), WEBM[:31], WEBM + bytes(2 * 1024 * 1024)):
            with self.subTest(data_type=type(data).__name__), self.assertRaisesRegex(ValueError, "录音为空或超过"):
                speech.validate_audio(data, "audio/webm")
        for data, mime in ((WEBM, "audio/ogg"), (OGG, "audio/webm"), (WEBM, None), (WEBM, "audio/mp3")):
            with self.subTest(mime=mime), self.assertRaisesRegex(ValueError, "WebM 或 Ogg"):
                speech.validate_audio(data, mime)

    def test_asr_exact_payload_and_trim(self):
        calls = []
        def request(url, body, key):
            calls.append((url, body, key))
            return {"choices": [{"message": {"content": "\ufeff  九月销售额是多少？  "}}]}
        result = speech.transcribe(WEBM, "audio/webm;codecs=opus", env=ENV, request_impl=request)
        self.assertEqual(result, "九月销售额是多少？")
        self.assertEqual(calls, [(ENV["DASHSCOPE_BASE_URL"] + "/chat/completions", {
            "model": "qwen3-asr-flash",
            "messages": [{"role": "user", "content": [{"type": "input_audio", "input_audio": {
                "data": "data:audio/webm;base64," + base64.b64encode(WEBM).decode("ascii")
            }}]}], "stream": False, "asr_options": {"enable_itn": False},
        }, "fake-test-key")])

    def test_invalid_audio_never_calls_request_or_needs_key(self):
        with patch("speech.request_json") as request:
            with self.assertRaisesRegex(ValueError, "录音为空"):
                speech.transcribe(b"", "audio/webm", env={}, request_impl=request)
            request.assert_not_called()

    def test_empty_and_non_text_asr_responses(self):
        for text in (None, "", " \n\ufeff ", []):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "没有识别到文字"):
                speech.transcribe(WEBM, "audio/webm", env=ENV,
                                  request_impl=lambda *_: {"choices": [{"message": {"content": text}}]})
        for response in ({}, {"choices": [None]}, {"choices": [{"message": None}]}):
            with self.subTest(response=response), self.assertRaisesRegex(ValueError, "没有识别到文字"):
                speech.transcribe(WEBM, "audio/webm", env=ENV, request_impl=lambda *_: response)

    def test_asr_utf16_limit_before_trimming(self):
        def call(text):
            return speech.transcribe(WEBM, "audio/webm", env=ENV,
                                     request_impl=lambda *_: {"choices": [{"message": {"content": text}}]})
        self.assertEqual(call("😀" * 1000), "😀" * 1000)
        for text in ("😀" * 1001, " " + "问" * 2000):
            with self.assertRaisesRegex(ValueError, "识别文字过长"):
                call(text)

    def test_missing_config_and_trusted_bases(self):
        for env in ({}, {"DASHSCOPE_API_KEY": "fake"}):
            with self.assertRaisesRegex(ValueError, "DASHSCOPE_API_KEY"):
                speech.configuration(env)
        for base in ("https://dashscope.aliyuncs.com/compatible-mode/v1/",
                     "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                     "https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
                     "https://DASHSCOPE.aliyuncs.com:443/compatible-mode/v1"):
            config = speech.configuration({**ENV, "DASHSCOPE_BASE_URL": base})
            self.assertTrue(config["base"].endswith("/compatible-mode/v1"))
            self.assertNotIn(":443", config["base"])

    def test_untrusted_base_is_rejected_before_key_is_sent(self):
        bases = ("http://dashscope.aliyuncs.com/compatible-mode/v1",
                 "https://example.com/compatible-mode/v1",
                 "https://dashscope.aliyuncs.com.evil.test/compatible-mode/v1",
                 "https://user@dashscope.aliyuncs.com/compatible-mode/v1",
                 "https://dashscope.aliyuncs.com:8888/compatible-mode/v1",
                 "https://dashscope.aliyuncs.com/api/v1",
                 ENV["DASHSCOPE_BASE_URL"] + "?secret=1",
                 ENV["DASHSCOPE_BASE_URL"] + "#frag",
                 ENV["DASHSCOPE_BASE_URL"] + "//")
        for base in bases:
            with self.subTest(base=base), patch("speech.request_json") as request:
                with self.assertRaisesRegex(ValueError, "真实兼容接口"):
                    speech.transcribe(WEBM, "audio/webm", env={**ENV, "DASHSCOPE_BASE_URL": base}, request_impl=request)
                request.assert_not_called()

    def test_tts_exact_payload_and_signed_https_url(self):
        calls = []
        def request(url, body, key):
            calls.append((url, body, key))
            return {"output": {"audio": {"url": AUDIO_URL}}}
        self.assertEqual(speech.synthesize("  已导入记录销售额为 1599 元。  ", env=ENV, request_impl=request),
                         AUDIO_URL.replace("http:", "https:", 1))
        self.assertEqual(calls, [("https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
                                 {"model": "qwen3-tts-flash", "input": {
                                     "text": "  已导入记录销售额为 1599 元。  ", "voice": "Cherry", "language_type": "Chinese"}}, "fake-test-key")])

    def test_tts_unicode_limit_not_utf16(self):
        request = lambda *_: {"output": {"audio": {"url": AUDIO_URL}}}
        speech.synthesize("😀" * 600, env=ENV, request_impl=request)
        # 显式 surrogate pair 也应与 JS [...text] 的一个码点一致。
        self.assertEqual(speech.character_count("\ud83d\ude00"), 1)
        for text in (None, "", "\ufeff ", "😀" * 601):
            with self.subTest(text_type=type(text).__name__), self.assertRaisesRegex(ValueError, "1 到 600"):
                speech.synthesize(text, env=ENV, request_impl=request)

    def test_missing_or_untrusted_audio_url(self):
        with self.assertRaisesRegex(ValueError, "没有返回音频地址"):
            speech.synthesize("回答", env=ENV, request_impl=lambda *_: {})
        for url in ("https://example.com/a.wav", "file:///a.wav", "https://oss-cn-beijing.aliyuncs.com/a.wav",
                    "https://x.oss-cn-beijing.aliyuncs.com.evil.test/a.wav",
                    "https://u:p@x.oss-cn-beijing.aliyuncs.com/a.wav",
                    "https://x.oss-cn-beijing.aliyuncs.com:8888/a.wav"):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "非预期音频地址"):
                speech.synthesize("回答", env=ENV, request_impl=lambda *_: {"output": {"audio": {"url": url}}})

    def test_standard_http_headers_body_timeout_and_redirect_policy(self):
        with patch("speech.build_opener") as build:
            build.return_value.open.return_value = FakeResponse({"ok": True})
            self.assertEqual(speech.request_json("https://example.invalid/api", {"text": "中文"}, "fake"), {"ok": True})
            request = build.return_value.open.call_args.args[0]
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.get_header("Authorization"), "Bearer fake")
            self.assertEqual(request.get_header("Content-type"), "application/json")
            self.assertEqual(json.loads(request.data), {"text": "中文"})
            self.assertEqual(build.return_value.open.call_args.kwargs, {"timeout": 60})
            handler = build.call_args.args[0]
            with self.assertRaisesRegex(ValueError, "重定向"):
                handler.redirect_request(request, None, 302, "Found", {}, "https://evil.test")

    def test_provider_http_errors_and_business_errors_do_not_retry(self):
        for status, body, detail in ((401, {"error": {"message": "invalid fake key"}}, "invalid fake key"),
                                     (200, {"code": "Failed", "message": "识别失败"}, "识别失败"),
                                     (502, {}, "请求失败")):
            with self.subTest(status=status), patch("speech.build_opener") as build:
                build.return_value.open.return_value = FakeResponse(body, status)
                with self.assertRaisesRegex(ValueError, f"语音服务 {status}：{detail}"):
                    speech.request_json("https://example.invalid/api", {}, "fake")
                self.assertEqual(build.return_value.open.call_count, 1)
        with patch("speech.build_opener") as build:
            build.return_value.open.side_effect = HTTPError("https://example.invalid/api", 429, "rate", {},
                                                          io.BytesIO(b'{"code":"RateLimit"}'))
            with self.assertRaisesRegex(ValueError, "429：RateLimit"):
                speech.request_json("https://example.invalid/api", {}, "fake")
            self.assertEqual(build.return_value.open.call_count, 1)

    def test_timeout_and_invalid_json_are_not_replaced_by_fake_results(self):
        with patch("speech.build_opener") as build:
            build.return_value.open.side_effect = TimeoutError("fake timeout")
            with self.assertRaisesRegex(TimeoutError, "fake timeout"):
                speech.request_json("https://example.invalid/api", {}, "fake")
            self.assertEqual(build.return_value.open.call_count, 1)
        with patch("speech.build_opener") as build:
            build.return_value.open.return_value = FakeResponse([])
            with self.assertRaisesRegex(ValueError, "有效 JSON 对象"):
                speech.request_json("https://example.invalid/api", {}, "fake")


if __name__ == "__main__":
    unittest.main()
