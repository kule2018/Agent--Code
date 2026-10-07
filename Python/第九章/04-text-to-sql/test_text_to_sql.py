"""离线测试：真实 DuckDB 查询、进程限制与 DeepSeek HTTP Mock，不发送付费请求。"""

import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import duckdb

import dataset as dataset_module
import model as model_module
import query_runner
import text_to_sql
from dataset import _products, load_dataset, prepare_dataset
from model import API_URL, EXPLANATION_INSTRUCTIONS, INSTRUCTIONS, create_ai_provider, parse_decision, post_json
from query_runner import QueryError, execute_query
from replay import COMPARISON_SQL, PRODUCT_SQL, REGION_SQL, REGIONS, SCENARIOS, create_replay_provider
from text_to_sql import answer_question


def completion(value, *, finish_reason="stop"):
    return {"choices": [{"finish_reason": finish_reason, "message": {
        "content": json.dumps(value, ensure_ascii=False, allow_nan=False),
    }}]}


class TextToSqlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="python-text-to-sql-")
        cls.root = Path(cls.temporary.name)
        cls.dataset = prepare_dataset(cls.root / "data")
        cls.database_path = Path(cls.dataset["databasePath"])
        cls.original_hash = hashlib.sha256(cls.database_path.read_bytes()).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def tearDown(self):
        # 每项查询、拒绝和异常测试后都确认主数据集未被改写。
        self.assertEqual(hashlib.sha256(self.database_path.read_bytes()).hexdigest(), self.original_hash)

    def run_sql(self, sql, **options):
        return execute_query(self.database_path, sql, **options)

    def replay(self, name):
        return answer_question(SCENARIOS[name]["question"], self.dataset, create_replay_provider(name))

    def test_01_context_and_version(self):
        context = self.dataset["context"]
        self.assertEqual(context["rowCount"], 6)
        self.assertEqual(len(context["schemas"]["products"]), 3)
        self.assertEqual(context["version"], "457f9fcb6e2fc41a327eae9c22a636b28f1d8edb3df129a61a3ead4b60086494")
        self.assertNotIn("samples", context)
        self.assertNotIn("databasePath", context)
        self.assertEqual(context["dateRange"], {"start": "2026-08-03", "end": "2026-09-18"})
        current = json.loads((self.root / "data" / "current.json").read_text(encoding="utf-8"))
        self.assertEqual(current, {"datasetId": "sales-demo", "version": context["version"]})

    def test_02_region_amounts(self):
        self.assertEqual(self.run_sql(REGION_SQL)["rows"], [
            {"region": "华东", "sales_amount": "1599.00"},
            {"region": "华南", "sales_amount": "798.00"},
        ])

    def test_03_comparison_and_zero_denominator(self):
        rows = self.run_sql(COMPARISON_SQL)["rows"]
        self.assertEqual(rows, [
            {"region": "华东", "august_amount": "2799.50", "september_amount": "1599.00",
             "change_amount": "-1200.50", "change_percent": -42.88},
            {"region": "华南", "august_amount": "1200.00", "september_amount": "798.00",
             "change_amount": "-402.00", "change_percent": -33.5},
        ])
        self.assertIsNone(self.run_sql("SELECT SUM(paid_amount) / NULLIF(0, 0) AS ratio FROM sales")["rows"][0]["ratio"])

    def test_04_product_join(self):
        rows = self.run_sql(PRODUCT_SQL)["rows"]
        self.assertEqual(rows, [
            {"product_name": "全自动咖啡机", "august_amount": "3600.50", "september_amount": "1200.00",
             "change_amount": "-2400.50", "absolute_change": "2400.50"},
            {"product_name": "保温杯", "august_amount": "399.00", "september_amount": "1197.00",
             "change_amount": "798.00", "absolute_change": "798.00"},
        ])

    def test_05_orders_lines_and_net(self):
        rows = self.run_sql("SELECT COUNT(*) AS lines, COUNT(DISTINCT order_id) AS orders, "
                            "SUM(paid_amount - refund_amount) AS net FROM sales")["rows"]
        self.assertEqual(rows, [{"lines": "6", "orders": "5", "net": "6097.50"}])

    def test_06_missing_month_is_null(self):
        result = self.run_sql("SELECT SUM(CASE WHEN sold_at < DATE '2026-08-01' THEN paid_amount END) AS july FROM sales")
        self.assertEqual(result["rows"], [{"july": None}])

    def test_07_clarifications_do_not_execute(self):
        for name in ("clarify", "coverage"):
            with self.subTest(name=name):
                report = answer_question(SCENARIOS[name]["question"], self.dataset, create_replay_provider(name),
                                         lambda *_: self.fail("追问不能执行 SQL"))
                self.assertEqual(report["status"], "clarify")
                self.assertEqual(report["attempts"], [])

    def test_08_empty_result(self):
        report = self.replay("empty")
        self.assertEqual(report["status"], "empty")
        self.assertEqual(report["result"]["rows"], [])
        self.assertIn("不代表销售额为 0", report["answer"])

    def test_09_real_binder_error_and_one_repair(self):
        report = self.replay("repair")
        self.assertEqual(report["status"], "answered")
        self.assertEqual(len(report["attempts"]), 2)
        self.assertIn("Binder Error:", report["attempts"][0]["error"])
        self.assertEqual(report["result"]["rows"][0]["sales_amount"], "1599.00")

    def test_10_second_failure_stops(self):
        errors = []
        bad_sql = "SELECT SUM(unknown_amount) FROM sales"
        def decide(_question, _context, previous_error):
            errors.append(previous_error)
            return {**REGIONS, "sql": bad_sql}
        provider = SimpleNamespace(mode="test", decide=decide,
                                   explain=lambda *_: self.fail("失败查询不能解读"))
        report = answer_question("查询销售额", self.dataset, provider)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(len(errors), 2)
        self.assertIsNone(errors[0])
        self.assertEqual(errors[1]["sql"], bad_sql)
        self.assertIn("Binder Error:", errors[1]["error"])

    def test_11_forbidden_queries(self):
        forbidden = [
            "DELETE FROM sales", "SELECT * FROM sales; DROP TABLE products", "SELECT * FROM sales_raw",
            "SELECT * FROM read_csv_auto('/tmp/private.csv')",
            "WITH x AS (SELECT * FROM sales) SELECT * FROM x",
            "SELECT * FROM (SELECT * FROM sales) AS x", "SELECT random() FROM sales",
            "SELECT * FROM sales UNION ALL SELECT * FROM sales",
            "SELECT SUM(paid_amount) OVER () FROM sales", "SELECT COUNT(*) FROM main.sales_raw",
            "SELECT (SELECT COUNT(*) FROM sales) FROM sales", "SELECT 1",
            "SELECT s.line_id FROM sales s JOIN products p ON s.product_id = p.product_id "
            "JOIN products p2 ON s.product_id = p2.product_id",
        ]
        for sql in forbidden:
            with self.subTest(sql=sql), self.assertRaises(QueryError) as raised:
                self.run_sql(sql)
            self.assertTrue(str(raised.exception).startswith("POLICY:"))
            self.assertFalse(raised.exception.repairable)

    def test_12_policy_does_not_retry(self):
        calls = []
        def decide(*args):
            calls.append(args)
            return {**REGIONS, "sql": "DELETE FROM sales"}
        report = answer_question("删除销售表", self.dataset, SimpleNamespace(mode="test", decide=decide))
        self.assertEqual(report["status"], "failed")
        self.assertEqual(len(calls), 1)

    def test_13_semicolon_and_comments(self):
        self.assertEqual(self.run_sql("/* 教学查询 */ SELECT ';' AS text, COUNT(*) AS n FROM sales;")["rows"],
                         [{"text": ";", "n": "6"}])

    def test_14_row_limit_and_timeout(self):
        limited = self.run_sql("SELECT * FROM sales ORDER BY source_row", max_rows=1)
        self.assertEqual(len(limited["rows"]), 1)
        self.assertTrue(limited["truncated"])
        with self.assertRaisesRegex(QueryError, "超时") as raised:
            self.run_sql(REGION_SQL, timeout_ms=1)
        self.assertFalse(raised.exception.repairable)

    def test_15_truncation_skips_summary(self):
        provider = create_replay_provider("regions")
        provider.explain = lambda *_: self.fail("截断结果不能概括全部")
        report = answer_question("按区域统计", self.dataset, provider,
                                 lambda *_: {"rows": [{"region": "华东"}], "truncated": True})
        self.assertEqual(report["status"], "needs_narrowing")

    def test_16_explanation_failure_keeps_results(self):
        provider = create_replay_provider("regions")
        def explain(*_):
            raise RuntimeError("模拟 API 故障")
        provider.explain = explain
        report = answer_question("按区域统计", self.dataset, provider)
        self.assertEqual(report["status"], "explanation_failed")
        self.assertEqual(len(report["result"]["rows"]), 2)

    def test_17_bad_decision_and_missing_key(self):
        provider = SimpleNamespace(mode="test", decide=lambda *_: {"sql": "SELECT 1"})
        with self.assertRaises(ValueError):
            answer_question("统计", self.dataset, provider)
        with self.assertRaisesRegex(ValueError, "DEEPSEEK_API_KEY"):
            create_ai_provider({})

    def test_18_pending_or_mismatched_profile(self):
        file = self.database_path.with_name("profile.json")
        original = file.read_bytes()
        try:
            for changes in ({"status": "needs_review"}, {"version": "0" * 64}):
                file.write_text(json.dumps({**json.loads(original), **changes}), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "尚未通过检查"):
                    load_dataset(self.root / "data")
        finally:
            file.write_bytes(original)

    def test_19_output_byte_limit(self):
        # 六条记录各返回 4000 个中文字符，字节数超限，但输入仍低于 12000 字符。
        with self.assertRaisesRegex(QueryError, "64 KiB") as raised:
            self.run_sql("SELECT '" + "中" * 4000 + "' AS text FROM sales")
        self.assertFalse(raised.exception.repairable)

    def test_20_child_environment_and_reaping(self):
        created = []
        original = subprocess.Popen
        def start(*args, **kwargs):
            self.assertEqual(set(kwargs["env"]) - {"PATH", "SystemRoot"}, set())
            worker = original(*args, **kwargs)
            created.append(worker)
            return worker
        with patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-test-key", "PYTHONPATH": "not-inherited"}), \
                patch.object(query_runner.subprocess, "Popen", side_effect=start):
            self.run_sql(REGION_SQL)
            with self.assertRaises(QueryError):
                self.run_sql(REGION_SQL, timeout_ms=1)
        self.assertEqual(len(created), 2)
        self.assertTrue(all(worker.poll() is not None for worker in created))

    def test_21_max_rows_validation(self):
        for value in (0, 101, -1, 1.5, True, "1", None):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "maxRows"):
                self.run_sql(REGION_SQL, max_rows=value)

    def test_22_syntax_error_is_repairable(self):
        with self.assertRaises(QueryError) as raised:
            self.run_sql("SELECT FROM sales")
        self.assertTrue(raised.exception.repairable)
        self.assertTrue(str(raised.exception).startswith("SQL:"))

    def test_23_sql_length_and_whitespace(self):
        for value in ("", "  ", None, "SELECT '" + "🙂" * 6000 + "' FROM sales"):
            with self.subTest(value=str(value)[:20]), self.assertRaisesRegex(QueryError, "POLICY:") as raised:
                self.run_sql(value)
            self.assertFalse(raised.exception.repairable)

    def test_24_question_utf16_boundary(self):
        for value in ("", "  ", "x" * 2001, "🙂" * 1001, None):
            with self.subTest(value=str(value)[:20]), self.assertRaisesRegex(ValueError, "2000"):
                answer_question(value, self.dataset, create_replay_provider("regions"))
        report = answer_question("🙂" * 1000, self.dataset, create_replay_provider("clarify"))
        self.assertEqual(report["status"], "clarify")

    def test_25_model_decision_schema_and_extra_fields(self):
        self.assertEqual(parse_decision({**REGIONS, "extra": "去掉"}), REGIONS)
        self.assertEqual(parse_decision({"action": "clarify", "question": "?", "extra": 1}),
                         {"action": "clarify", "question": "?"})
        for value in (None, [], {"action": "other"}, {**REGIONS, "metric": ""},
                      {**REGIONS, "sql": "🙂" * 6001}, {"action": "clarify", "question": 1}):
            with self.subTest(value=str(value)[:80]), self.assertRaises(ValueError):
                parse_decision(value)

    def test_26_ai_request_contract_and_previous_error(self):
        requests = []
        def request(url, body, key, **options):
            requests.append((url, body, key, options))
            return completion(REGIONS)
        provider = create_ai_provider({"DEEPSEEK_API_KEY": "fake-key"}, request_json=request)
        provider.decide("查询", self.dataset["context"])
        previous = {"sql": "SELECT unknown FROM sales", "error": "Binder Error: unknown"}
        provider.decide("查询", self.dataset["context"], previous)
        self.assertEqual(provider.mode, "AI / deepseek-flash")
        for url, body, key, options in requests:
            self.assertEqual(url, API_URL)
            self.assertEqual(key, "fake-key")
            self.assertEqual(options, {"timeout": 60})
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertEqual(body["response_format"], {"type": "json_object"})
            self.assertEqual(body["temperature"], 0)
            self.assertEqual(body["max_tokens"], 2500)
            self.assertEqual(body["messages"][0], {"role": "system", "content": INSTRUCTIONS})
            self.assertEqual(body["messages"][1]["role"], "user")
        first = json.loads(requests[0][1]["messages"][1]["content"])
        self.assertEqual(first, {"question": "查询", "dataset": self.dataset["context"]})
        self.assertEqual(json.loads(requests[1][1]["messages"][1]["content"])["previousError"], previous)

    def test_27_ai_explanation_uses_real_result(self):
        requests = []
        def request(_url, body, *_args, **_options):
            requests.append(body)
            return completion({"answer": "结果仅代表样本。", "extra": "去掉"})
        provider = create_ai_provider({"DEEPSEEK_API_KEY": "fake-key", "DEEPSEEK_MODEL": "custom-model"}, request_json=request)
        result = self.run_sql(REGION_SQL)
        self.assertEqual(provider.explain("查询", self.dataset["context"], REGIONS, result), "结果仅代表样本。")
        self.assertEqual(requests[0]["model"], "custom-model")
        self.assertEqual(requests[0]["messages"][0]["content"], EXPLANATION_INSTRUCTIONS)
        self.assertEqual(json.loads(requests[0]["messages"][1]["content"]), {
            "question": "查询", "rules": self.dataset["context"]["rules"], "decision": REGIONS, "result": result,
        })

    def test_28_incomplete_or_invalid_model_response(self):
        values = [{}, {"choices": []}, {"choices": [{"message": None}]},
                  completion(REGIONS, finish_reason="length"),
                  {"choices": [{"finish_reason": "stop", "message": {"content": "not JSON"}}]},
                  {"choices": [{"finish_reason": "stop", "message": {"content": "{\"action\": NaN}"}}]}]
        for value in values:
            with self.subTest(value=value):
                provider = create_ai_provider({"DEEPSEEK_API_KEY": "fake-key"}, request_json=lambda *_a, **_k: value)
                with self.assertRaises(ValueError):
                    provider.decide("查询", self.dataset["context"])

    def test_29_answer_schema(self):
        for value in ({"answer": ""}, {"answer": "🙂" * 2501}, {"answer": 1}, [], {}):
            with self.subTest(value=str(value)[:60]):
                provider = create_ai_provider({"DEEPSEEK_API_KEY": "fake-key"},
                                              request_json=lambda *_a, **_k: completion(value))
                with self.assertRaises(ValueError):
                    provider.explain("查询", self.dataset["context"], REGIONS, {"rows": [], "truncated": False})

    def test_30_model_request_error_is_not_retried_or_fabricated(self):
        calls = []
        def request(*_args, **_kwargs):
            calls.append(1)
            raise RuntimeError("模拟 API 断开")
        provider = create_ai_provider({"DEEPSEEK_API_KEY": "fake-key"}, request_json=request)
        with self.assertRaisesRegex(RuntimeError, "API 断开"):
            answer_question("查询", self.dataset, provider)
        self.assertEqual(calls, [1])

    def test_31_repair_can_switch_to_clarification(self):
        answers = iter([{**REGIONS, "sql": "SELECT unknown FROM sales"}, {"action": "clarify", "question": "请确认指标"}])
        report = answer_question("查询", self.dataset, SimpleNamespace(mode="test", decide=lambda *_: next(answers)))
        self.assertEqual(report["status"], "clarify")
        self.assertEqual(len(report["attempts"]), 1)

    def test_32_load_missing_or_invalid_current(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaisesRegex(ValueError, "prepare"):
                load_dataset(root)
            for value in ({"datasetId": "../sales-demo", "version": "a" * 64},
                          {"datasetId": "sales-demo", "version": "../bad"}, [], {}):
                (root / "current.json").write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "版本配置无效"):
                    load_dataset(root)

    def test_33_invalid_data_blocks_query(self):
        with tempfile.TemporaryDirectory() as folder:
            imported = prepare_dataset(folder)
            connection = duckdb.connect(imported["databasePath"])
            connection.execute("UPDATE sales SET is_valid = NULL WHERE source_row = 4")
            connection.close()
            with self.assertRaisesRegex(ValueError, "待核对明细"):
                load_dataset(folder)

    def test_34_product_validation(self):
        for rows in ([], [("P01", "咖啡机", "电器"), ("P01", "杯子", "百货")],
                     [("P01", " ", "电器")], [(1, "咖啡机", "电器")]):
            sheet = {"A1": {"v": "商品编号"}, "B1": {"v": "商品名称"}, "C1": {"v": "品类"}}
            for index, row in enumerate(rows, 2):
                sheet.update({f"{column}{index}": {"v": value} for column, value in zip("ABC", row)})
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "唯一商品编号"):
                _products({"Sheets": {"商品信息": sheet}})

    def test_35_product_transaction_does_not_publish_on_failure(self):
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(dataset_module, "_products", return_value=[{"商品编号": "P99", "商品名称": "未知", "品类": "样本"}]):
            with self.assertRaisesRegex(ValueError, "没有对应商品"):
                prepare_dataset(folder)
            self.assertFalse((Path(folder) / "current.json").exists())
            database = next(Path(folder).glob("sales-demo/*/data.duckdb"))
            connection = duckdb.connect(str(database), read_only=True)
            try:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM sales").fetchone()[0], 6)
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_name='products'").fetchone()[0], 0)
            finally:
                connection.close()

    def test_36_report_saved_without_keys(self):
        report = self.replay("repair")
        with tempfile.TemporaryDirectory() as folder, patch.object(text_to_sql, "PROJECT_DIR", Path(folder)), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            path = text_to_sql.print_and_save(report)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), report)
            self.assertTrue(path.read_bytes().endswith(b"\n"))
            self.assertRegex(path.name, r"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}\.json$")
            self.assertIn("第 2 次查询", output.getvalue())
            self.assertIn("1599.00", output.getvalue())

    def test_37_cli_default_demo_and_status_codes(self):
        with patch.object(text_to_sql, "load_dataset", return_value=self.dataset), \
                patch.object(text_to_sql, "print_and_save") as save:
            self.assertEqual(text_to_sql.main(["demo"]), 0)
            self.assertEqual(save.call_args[0][0]["question"], SCENARIOS["regions"]["question"])
            for status in ("failed", "explanation_failed", "empty", "clarify", "needs_narrowing"):
                with patch.object(text_to_sql, "answer_question", return_value={"status": status}):
                    self.assertEqual(text_to_sql.main(["demo", "regions"]), 1 if status in {"failed", "explanation_failed"} else 0)
        with self.assertRaisesRegex(ValueError, "用法"):
            text_to_sql.main([])

    def test_38_replay_name_and_exhaustion(self):
        with self.assertRaisesRegex(ValueError, "未知演示名"):
            create_replay_provider("missing")
        provider = create_replay_provider("regions")
        decision = provider.decide("", {})
        decision["sql"] = "外部修改"
        self.assertEqual(SCENARIOS["regions"]["decisions"][0]["sql"], REGION_SQL)
        with self.assertRaisesRegex(ValueError, "演示决策已用完"):
            provider.decide("", {})

    def test_39_native_json_scalar_types(self):
        result = self.run_sql("SELECT source_row, line_id, sold_at, paid_amount, is_valid, "
                              "CAST('9007199254740993' AS BIGINT) AS big, CAST('NaN' AS DOUBLE) AS special "
                              "FROM sales ORDER BY source_row LIMIT 1")
        self.assertEqual(result["rows"], [{"source_row": 4, "line_id": "0001", "sold_at": "2026-08-03",
                                          "paid_amount": "2400.50", "is_valid": True,
                                          "big": "9007199254740993", "special": "NaN"}])

    def test_40_actual_default_100_row_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / "many.duckdb"
            connection = duckdb.connect(str(database))
            connection.execute("CREATE TABLE sales (n INTEGER)")
            connection.executemany("INSERT INTO sales VALUES (?)", [(n,) for n in range(101)])
            connection.close()
            result = execute_query(database, "SELECT n FROM sales ORDER BY n")
            self.assertEqual(len(result["rows"]), 100)
            self.assertEqual(result["rows"][-1], {"n": 99})
            self.assertTrue(result["truncated"])

    def test_43_interval_and_nested_integer_precision(self):
        result = self.run_sql("SELECT CAST('1 year 2 months 3 days 04:05:06' AS INTERVAL) AS span, "
                              "CAST('[9007199254740993, 2]' AS BIGINT[]) AS items FROM sales LIMIT 1")
        self.assertEqual(result["rows"], [{"span": {"months": 14, "days": 3, "micros": "14706000000"},
                                          "items": ["9007199254740993", "2"]}])

    def test_44_nanosecond_timestamp_and_timezone_without_extra_dependency(self):
        result = self.run_sql("SELECT CAST('2026-01-01 01:02:03.123456789' AS TIMESTAMP_NS) AS stamp, "
                              "CAST('2026-01-01 00:00:00+00' AS TIMESTAMPTZ) AS zoned FROM sales LIMIT 1")
        self.assertEqual(result["rows"][0]["stamp"], "2026-01-01 01:02:03.123456789")
        self.assertEqual(datetime.fromisoformat(result["rows"][0]["zoned"]).astimezone(timezone.utc),
                         datetime(2026, 1, 1, tzinfo=timezone.utc))

    def test_45_cli_in_independent_tree_from_other_working_directory(self):
        # 仅复制已知源码和样本到临时目录；不枚举或复制任何环境文件。
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lesson = root / "第九章" / "04-text-to-sql"
            previous = lesson.parent / "03-table-import"
            lesson.mkdir(parents=True)
            (previous / "samples").mkdir(parents=True)
            for name in ("dataset.py", "model.py", "replay.py", "query_runner.py", "query_worker.py", "text_to_sql.py"):
                shutil.copyfile(dataset_module.PROJECT_DIR / name, lesson / name)
            for name in ("table_parser.py", "import_data.py", "samples/sales-clean.xlsx"):
                shutil.copyfile(dataset_module.IMPORT_DIR / name, previous / name)
            def cli(*args):
                return subprocess.run([sys.executable, "-B", str(lesson / "text_to_sql.py"), *args], cwd=root,
                                      env={"PATH": os.environ.get("PATH", "")}, text=True,
                                      capture_output=True, timeout=15)
            prepared = cli("prepare")
            self.assertEqual(prepared.returncode, 0, prepared.stderr)
            self.assertIn("销售明细：6 条；商品：2 个", prepared.stdout)
            for name in SCENARIOS:
                result = cli("demo", name)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Replay / 预设 SQL，未调用模型", result.stdout)
            reports = [json.loads(file.read_text(encoding="utf-8")) for file in (lesson / "outputs").glob("*.json")]
            self.assertEqual(len(reports), 7)
            self.assertEqual({report["status"] for report in reports}, {"answered", "clarify", "empty"})
            failed = cli("ask", "查询销售额")
            self.assertEqual(failed.returncode, 1)
            self.assertIn("DEEPSEEK_API_KEY", failed.stderr)

    def test_46_mock_model_repair_then_explanation(self):
        responses = iter([completion({**REGIONS, "sql": "SELECT SUM(unknown_amount) FROM sales"}),
                          completion(REGIONS), completion({"answer": "已导入的 9 月记录中，华东金额为 1599.00 元。"})])
        requests = []
        def request(_url, body, *_args, **_kwargs):
            requests.append(body)
            return next(responses)
        provider = create_ai_provider({"DEEPSEEK_API_KEY": "fake-key"}, request_json=request)
        report = answer_question("按区域统计未扣退款销售额", self.dataset, provider)
        self.assertEqual(report["status"], "answered")
        self.assertEqual(len(report["attempts"]), 2)
        self.assertEqual(len(requests), 3)
        second = json.loads(requests[1]["messages"][1]["content"])
        self.assertEqual(second["previousError"], {"sql": report["attempts"][0]["decision"]["sql"],
                                                 "error": report["attempts"][0]["error"]})
        explanation = json.loads(requests[2]["messages"][1]["content"])
        self.assertEqual(explanation["result"], report["result"])


class HttpMockTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.status = 200
        self.body = completion(REGIONS)
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                owner.requests.append({"path": self.path, "headers": dict(self.headers),
                                       "body": json.loads(self.rfile.read(int(self.headers["Content-Length"])) )})
                self.send_response(owner.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(owner.body, ensure_ascii=False).encode("utf-8"))
            def log_message(self, *_args):
                pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/chat/completions"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)

    def test_41_local_http_headers_and_json(self):
        with patch.object(model_module, "API_URL", self.url):
            provider = create_ai_provider({"DEEPSEEK_API_KEY": "fake-local-key"})
            self.assertEqual(provider.decide("查询", {"rules": []}), REGIONS)
        request = self.requests[0]
        self.assertEqual(request["path"], "/chat/completions")
        self.assertEqual(request["headers"]["Authorization"], "Bearer fake-local-key")
        self.assertEqual(request["headers"]["Content-Type"], "application/json")
        self.assertEqual(json.loads(request["body"]["messages"][1]["content"]), {"question": "查询", "dataset": {"rules": []}})

    def test_42_http_errors_no_retry_or_key_leak(self):
        for status in (401, 429, 500):
            self.status = status
            with self.subTest(status=status), self.assertRaisesRegex(RuntimeError, f"HTTP {status}") as raised:
                post_json(self.url, {"test": "值"}, "fake-secret")
            self.assertNotIn("fake-secret", str(raised.exception))
        self.assertEqual(len(self.requests), 3)


if __name__ == "__main__":
    unittest.main()
