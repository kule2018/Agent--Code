"""离线测试：这里的 reading 是人工构造数据，不是视觉模型的实测输出。"""

import base64
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager, redirect_stdout
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import URLError

import image_understanding as lesson


READING = {
    "title": "销售经营看板",
    "period": "2026-09-01 至 2026-09-30",
    "metric": "销售额",
    "value": "128.60",
    "unit": "万元",
    "scope": "全部区域，已支付订单实付金额，未扣除退款",
    "evidence": ["统计周期：2026-09-01 至 2026-09-30", "销售额", "128.60", "万元", "未扣除退款"],
    "uncertainties": [],
}


def completion(data=None, reason="stop", usage=None):
    response = {
        "choices": [{
            "finish_reason": reason,
            "message": {"role": "assistant", "content": json.dumps(
                READING if data is None else data, ensure_ascii=False
            )},
        }],
    }
    if usage is not None:
        response["usage"] = usage
    return response


@contextmanager
def local_api(payload, status=200):
    """只监听回环地址，不调用外部服务，也不依赖用户的 API Key。"""
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.append({
                "method": self.command,
                "path": self.path,
                "headers": dict(self.headers),
                "body": json.loads(body),
            })
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload if isinstance(payload, bytes) else json.dumps(
                payload, ensure_ascii=False
            ).encode("utf-8"))

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/compatible-mode/v1", received
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class ImageUnderstandingTests(unittest.TestCase):
    def setUp(self):
        self.image = lesson.load_image(lesson.SAMPLES["clear"])

    def test_png_hash_base64_and_request_fields(self):
        data = lesson.SAMPLES["clear"].read_bytes()
        self.assertEqual(self.image["mimeType"], "image/png")
        self.assertEqual(self.image["byteLength"], len(data))
        self.assertEqual(self.image["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(base64.b64decode(self.image["dataUrl"].split(",", 1)[1]), data)
        request = lesson.build_request(self.image, "qwen3-vl-flash")
        self.assertEqual(set(request), {
            "model", "enable_thinking", "temperature", "max_tokens", "response_format", "messages"
        })
        self.assertIs(request["enable_thinking"], False)
        self.assertEqual(request["temperature"], 0)
        self.assertEqual(request["max_tokens"], 2048)
        self.assertEqual(request["response_format"], {"type": "json_object"})
        message = request["messages"][0]
        self.assertEqual(message["role"], "user")
        self.assertEqual(message["content"][0], {"type": "text", "text": lesson.EXTRACTION_PROMPT})
        self.assertEqual(message["content"][1], {
            "type": "image_url", "image_url": {"url": self.image["dataUrl"]}
        })
        self.assertNotIn(str(lesson.SAMPLES["clear"]), json.dumps(request))

    def test_samples_are_distinct_pngs(self):
        image = lesson.load_image(lesson.SAMPLES["incomplete"])
        self.assertEqual(image["mimeType"], "image/png")
        self.assertNotEqual(image["sha256"], self.image["sha256"])

    def test_jpeg_and_webp_detected_by_header_not_extension(self):
        # 只验证案例采用的文件头检测，不把这些短字节声称为可解码图片。
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "renamed.data"
            for data, mime in (
                (b"\xff\xd8\xff\xe0fake", "image/jpeg"),
                (b"RIFF\x00\x00\x00\x00WEBPfake", "image/webp"),
            ):
                with self.subTest(mime=mime):
                    file.write_bytes(data)
                    self.assertEqual(lesson.load_image(file)["mimeType"], mime)

    def test_reject_fake_empty_oversize_directory_and_missing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "fake.png"
            for data, message in ((b"not an image", "文件头"), (b"", "非空"),
                                  (b"\x00" * (lesson.MAX_IMAGE_BYTES + 1), "5 MiB")):
                with self.subTest(message=message):
                    file.write_bytes(data)
                    with self.assertRaisesRegex(ValueError, message):
                        lesson.load_image(file)
            with self.assertRaisesRegex(ValueError, "非空"):
                lesson.load_image(directory)
            with self.assertRaises(FileNotFoundError):
                lesson.load_image(Path(directory) / "missing.png")

    def test_exact_five_mib_is_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "boundary.png"
            file.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * (lesson.MAX_IMAGE_BYTES - 8))
            self.assertEqual(lesson.load_image(file)["byteLength"], lesson.MAX_IMAGE_BYTES)

    def test_complete_information_only_marked_extracted(self):
        result = lesson.prepare_agent_input(lesson.parse_reading(completion()))
        self.assertEqual(result["status"], "extracted")
        self.assertEqual(result["confirmationQuestions"], [])
        self.assertEqual(result["reading"]["value"], "128.60")
        self.assertEqual(set(result), {"status", "reading", "confirmationQuestions"})

    def test_null_fields_create_ordered_confirmation_questions(self):
        reading = {**READING, "period": None, "value": None, "unit": None}
        result = lesson.prepare_agent_input(lesson.parse_reading(completion(reading)))
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertEqual(result["confirmationQuestions"], [
            "请补充或确认统计时间。", "请补充或确认图中数值。", "请补充或确认数值单位。"
        ])

    def test_uncertainty_deduplication_preserves_order(self):
        reading = {**READING, "period": None, "uncertainties": [
            "请补充或确认统计时间。", "图中两处统计口径不一致", "图中两处统计口径不一致"
        ]}
        result = lesson.prepare_agent_input(reading)
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertEqual(result["confirmationQuestions"], [
            "请补充或确认统计时间。", "图中两处统计口径不一致"
        ])

    def test_no_evidence_requires_manual_check(self):
        result = lesson.prepare_agent_input({**READING, "evidence": []})
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertEqual(result["confirmationQuestions"], ["未提供图中文字摘录，请人工核对图片。"])

    def test_schema_trims_strings_without_converting_amount(self):
        raw = {**READING, "value": " 128.60 ", "evidence": ["\n销售额\t"]}
        parsed = lesson.parse_reading(completion(raw))
        self.assertEqual(parsed["value"], "128.60")
        self.assertEqual(parsed["evidence"], ["销售额"])
        self.assertEqual(raw["value"], " 128.60 ")

    def test_schema_rejects_missing_unknown_wrong_type_and_blank(self):
        bad_readings = []
        for key in (*lesson.FIELD_NAMES, "evidence", "uncertainties"):
            missing = deepcopy(READING)
            del missing[key]
            bad_readings.append(missing)
        bad_readings.extend([
            {**READING, "extra": "猜测"}, {**READING, "value": 128.6},
            {**READING, "unit": " "}, {**READING, "title": True},
            {**READING, "evidence": "销售额"}, {**READING, "evidence": [1]},
            {**READING, "uncertainties": None}, {**READING, "uncertainties": ["\n"]},
            [], "not an object", 123,
        ])
        for raw in bad_readings:
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, "字段不符合"):
                lesson.parse_reading(completion(raw))

    def test_reject_incomplete_refused_and_malformed_responses(self):
        responses = [
            completion(reason="length"), completion(reason="content_filter"),
            {"choices": []}, {}, None, {"choices": [None]},
            {"choices": [{"finish_reason": "stop", "message": {"content": ""}}]},
            {"choices": [{"finish_reason": "stop", "message": {"content": None, "refusal": "拒绝"}}]},
        ]
        for response in responses:
            with self.subTest(response=response), self.assertRaisesRegex(ValueError, "完整正文"):
                lesson.parse_reading(response)

    def test_reject_markdown_invalid_json_and_nonstandard_constants(self):
        for content in ("```json {} ```", "{", '{"value": NaN}', '{"value": Infinity}'):
            response = {"choices": [{"finish_reason": "stop", "message": {"content": content}}]}
            with self.subTest(content=content), self.assertRaisesRegex(ValueError, "有效 JSON"):
                lesson.parse_reading(response)

    def test_inspect_retains_usage_and_missing_usage_is_null(self):
        for usage in (None, {"total_tokens": 123}):
            client = Mock()
            client.create_completion.return_value = completion(usage=usage)
            result = lesson.inspect_dashboard(client, self.image, lesson.DEFAULT_MODEL)
            client.create_completion.assert_called_once_with(lesson.build_request(self.image, lesson.DEFAULT_MODEL))
            self.assertEqual(result["usage"], usage)
            self.assertEqual(result["status"], "extracted")

    def test_real_http_transport_on_local_mock(self):
        with local_api(completion(usage={"total_tokens": 123})) as (base_url, received):
            client = lesson.VisionClient("local-test-only", base_url + "/")
            result = lesson.inspect_dashboard(client, self.image, lesson.DEFAULT_MODEL)
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["method"], "POST")
        self.assertEqual(received[0]["path"], "/compatible-mode/v1/chat/completions")
        self.assertEqual(received[0]["headers"]["Authorization"], "Bearer local-test-only")
        self.assertEqual(received[0]["headers"]["Content-Type"], "application/json")
        self.assertEqual(received[0]["body"], lesson.build_request(self.image, lesson.DEFAULT_MODEL))
        self.assertEqual(result["usage"], {"total_tokens": 123})
        self.assertEqual(client.timeout, 60)

    def test_http_error_has_status_no_secret_and_no_retry(self):
        with local_api({"error": "invalid key"}, status=401) as (base_url, received):
            client = lesson.VisionClient("local-test-only", base_url)
            with self.assertRaisesRegex(RuntimeError, "HTTP 401") as error:
                client.create_completion(lesson.build_request(self.image, lesson.DEFAULT_MODEL))
        self.assertEqual(len(received), 1)
        self.assertNotIn("local-test-only", str(error.exception))

    def test_http_invalid_json_is_rejected(self):
        with local_api(b"not JSON") as (base_url, received):
            with self.assertRaisesRegex(RuntimeError, "有效 JSON"):
                lesson.VisionClient("local-test-only", base_url).create_completion({})
        self.assertEqual(len(received), 1)

    def test_timeout_and_network_errors_are_not_retried(self):
        client = lesson.VisionClient("local-test-only", "https://example.invalid/compatible-mode/v1")
        for error in (TimeoutError("test timeout"), URLError("test network")):
            with self.subTest(error=error), patch.object(lesson, "urlopen", side_effect=error) as send:
                with self.assertRaisesRegex(RuntimeError, "网络"):
                    client.create_completion({})
                self.assertEqual(send.call_count, 1)
                self.assertEqual(send.call_args.kwargs["timeout"], 60)

    def test_preview_works_without_key_from_different_working_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            process = subprocess.run(
                [sys.executable, str(lesson.PROJECT_DIR / "image_understanding.py"), "request"],
                cwd=directory,
                env={"PYTHONDONTWRITEBYTECODE": "1", "VISION_MODEL": "preview-model"},
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertIn('"model": "preview-model"', process.stdout)
            self.assertIn("<已省略图片编码>", process.stdout)
            self.assertNotIn(self.image["dataUrl"], process.stdout)
            self.assertNotIn("正在调用", process.stdout)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_preview_does_not_create_client_or_output(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(lesson, "VisionClient") as client, \
                patch.object(lesson, "save_result") as save, redirect_stdout(io.StringIO()):
            lesson.main(["request", str(lesson.SAMPLES["incomplete"])])
        client.assert_not_called()
        save.assert_not_called()

    def test_bad_mode_and_missing_configuration_fail_before_network(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(lesson, "VisionClient") as client, \
                redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "可用命令"):
                lesson.main(["unknown"])
            with self.assertRaisesRegex(ValueError, "DASHSCOPE_API_KEY"):
                lesson.main([])
        client.assert_not_called()

    def test_base_url_placeholders_and_wrong_endpoints_fail_before_network(self):
        for base_url in (
            "https://{WorkspaceId}.example/compatible-mode/v1",
            "https://你的空间.example/compatible-mode/v1",
            "http://example.invalid/compatible-mode/v1",
            "https://example.invalid/compatible-mode/v1/chat/completions",
            "https:///compatible-mode/v1", "not-a-url",
        ):
            with self.subTest(base_url=base_url), patch.dict(os.environ, {
                "DASHSCOPE_API_KEY": "local-test-only", "DASHSCOPE_BASE_URL": base_url
            }, clear=True), patch.object(lesson, "VisionClient") as client, redirect_stdout(io.StringIO()):
                with self.assertRaises(ValueError):
                    lesson.main(["clear"])
                client.assert_not_called()

    def test_main_saves_mock_response_with_source_metadata(self):
        # 入口看到的是假配置；客户端注入本地 HTTP。产物只写到临时目录。
        reading = {**READING, "period": None, "value": None, "unit": None}
        with tempfile.TemporaryDirectory() as directory, local_api(
            completion(reading, usage={"total_tokens": 123})
        ) as (base_url, received):
            client = lesson.VisionClient("local-test-only", base_url)
            stdout = io.StringIO()
            with patch.dict(os.environ, {
                "DASHSCOPE_API_KEY": "local-test-only",
                "DASHSCOPE_BASE_URL": "https://example.invalid/compatible-mode/v1/",
            }, clear=True), patch.object(lesson, "VisionClient", return_value=client) as constructor, \
                    patch.object(lesson, "PROJECT_DIR", Path(directory)), \
                    patch.object(lesson.time, "time_ns", return_value=1_234_567_890_000_000), \
                    redirect_stdout(stdout):
                lesson.main(["incomplete"])
            file = Path(directory) / "outputs/incomplete-1234567890.json"
            document = json.loads(file.read_text(encoding="utf-8"))
            self.assertEqual(list(file.parent.iterdir()), [file])
            self.assertTrue(file.read_bytes().endswith(b"\n"))
            self.assertEqual(document["source"], {
                "file": "dashboard-incomplete.png",
                "sha256": lesson.load_image(lesson.SAMPLES["incomplete"])["sha256"],
            })
            self.assertEqual(document["model"], lesson.DEFAULT_MODEL)
            self.assertEqual(document["question"], lesson.QUESTION)
            self.assertEqual(document["status"], "needs_confirmation")
            self.assertEqual(document["reading"], reading)
            self.assertEqual(document["usage"], {"total_tokens": 123})
            self.assertEqual(len(document["confirmationQuestions"]), 3)
            constructor.assert_called_once_with(
                "local-test-only", "https://example.invalid/compatible-mode/v1/", timeout=60
            )
            self.assertIn("无法确认", stdout.getvalue())
            self.assertIn(str(file), stdout.getvalue())
            self.assertEqual(len(received), 1)

    def test_invalid_response_does_not_save_results(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Mock()
            client.create_completion.return_value = completion(reason="length")
            with patch.dict(os.environ, {
                "DASHSCOPE_API_KEY": "local-test-only",
                "DASHSCOPE_BASE_URL": "https://example.invalid/compatible-mode/v1",
            }, clear=True), patch.object(lesson, "VisionClient", return_value=client), \
                    patch.object(lesson, "PROJECT_DIR", Path(directory)), redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "完整正文"):
                    lesson.main([])
            self.assertFalse((Path(directory) / "outputs").exists())


if __name__ == "__main__":
    unittest.main()
