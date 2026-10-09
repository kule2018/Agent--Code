"""使用固定 Provider 和 Fake SQL 执行器验证分析，不连接模型或 Docker。"""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import analysis
from dataset import prepare_dataset
from query_runner import execute_query


DATASET = {"databasePath": "/fake/data.duckdb", "context": {"datasetId": "sales-demo", "version": "a" * 64}}
DECISION = {"action": "query", "sql": "SELECT region, SUM(paid_amount) AS total FROM sales GROUP BY region",
            "metric": "未扣退款销售额", "scope": "已导入记录"}
ROWS = [{"region": "华东", "total": "1599.00"}]


def provider(*, decision=DECISION, answer="华东已导入记录销售额为 1599 元。"):
    return SimpleNamespace(mode="fake", decide=lambda *_: decision,
                           explain=lambda *_: answer)


class AnalysisTests(unittest.TestCase):
    def test_answered_dto_uses_exact_sql_and_real_rows(self):
        calls = []
        def execute(path, sql):
            calls.append((path, sql))
            return {"rows": ROWS, "truncated": False}
        result = analysis.analyze("各区域销售额？", dataset=DATASET, provider=provider(), execute=execute)
        self.assertEqual(calls, [(DATASET["databasePath"], DECISION["sql"])])
        self.assertEqual(list(result), ["status", "answer", "speechText", "sql", "rows", "warning", "datasetId", "version", "metric", "scope"])
        self.assertEqual(result["status"], "answered")
        self.assertEqual(result["rows"], ROWS)
        self.assertEqual(result["sql"], DECISION["sql"])
        self.assertEqual(result["speechText"], result["answer"])
        self.assertEqual(result["metric"], DECISION["metric"])
        self.assertEqual(result["scope"], DECISION["scope"])
        self.assertEqual(result["version"], DATASET["context"]["version"])
        self.assertIn("不外推完整月度业绩", result["warning"])

    def test_clarify_does_not_execute_sql(self):
        with patch("analysis.execute_in_sandbox") as execute:
            result = analysis.analyze("销售怎么样？", dataset=DATASET,
                                      provider=provider(decision={"action": "clarify", "question": "请补充时间和指标。"}))
            execute.assert_not_called()
        self.assertEqual(result["status"], "clarify")
        self.assertEqual(result["speechText"], "请补充时间和指标。")
        for key in ("sql", "warning", "metric", "scope"):
            self.assertEqual(result[key], "")
        self.assertEqual(result["rows"], [])

    def test_empty_and_truncated_results_do_not_generate_explanation(self):
        for rows, truncated, expected in (([], False, "empty"), (ROWS, True, "needs_narrowing")):
            with self.subTest(expected=expected):
                fake = provider()
                fake.explain = lambda *_: self.fail("不应调用解读模型")
                result = analysis.analyze("问题", dataset=DATASET, provider=fake,
                                          execute=lambda *_: {"rows": rows, "truncated": truncated})
                self.assertEqual(result["status"], expected)
                self.assertEqual(result["rows"], rows)
                self.assertEqual(result["speechText"], result["answer"])

    def test_failed_sandbox_is_not_retried(self):
        with patch("analysis.run_sandbox", return_value={"status": "failed", "cleanedUp": True, "error": "容器执行超时"}) as sandbox:
            result = analysis.analyze("问题", dataset=DATASET, provider=provider())
        self.assertEqual(sandbox.call_count, 1)
        self.assertEqual(result["status"], "failed")
        self.assertIn("容器执行超时", result["answer"])
        self.assertEqual(result["rows"], [])
        self.assertIn("没有完整完成", result["speechText"])

    def test_explanation_failure_keeps_successful_sql_rows(self):
        fake = provider()
        fake.explain = lambda *_: (_ for _ in ()).throw(RuntimeError("fake model error"))
        result = analysis.analyze("问题", dataset=DATASET, provider=fake,
                                  execute=lambda *_: {"rows": ROWS, "truncated": False})
        self.assertEqual(result["status"], "explanation_failed")
        self.assertEqual(result["rows"], ROWS)
        self.assertEqual(result["sql"], DECISION["sql"])
        self.assertIn("没有完整完成", result["speechText"])

    def test_short_long_and_failed_speech_policy(self):
        self.assertEqual(analysis.select_speech_text({"status": "answered", "answer": "😀" * 500}), "😀" * 500)
        for text in ("字" * 501, "😀" * 501):
            self.assertIn("回答较长", analysis.select_speech_text({"status": "answered", "answer": text}))
        for state in ("failed", "explanation_failed"):
            self.assertIn("没有完整完成", analysis.select_speech_text({"status": state, "answer": "不要误读失败信息"}))

    def test_sandbox_contract_requires_success_and_cleanup(self):
        with patch("analysis.run_sandbox", return_value={"status": "completed", "cleanedUp": True, "result": {"rows": ROWS}}) as sandbox:
            self.assertEqual(analysis.execute_in_sandbox("/fake/db", "SELECT 1"), {"rows": ROWS, "truncated": False})
            sandbox.assert_called_once_with({"kind": "sql", "sql": "SELECT 1"}, database_path="/fake/db")
        for execution in ({"status": "completed", "cleanedUp": False, "result": {"rows": ROWS}},
                          {"status": "failed", "cleanedUp": True}):
            with patch("analysis.run_sandbox", return_value=execution), self.assertRaisesRegex(RuntimeError, "容器清理未完成"):
                analysis.execute_in_sandbox("/fake/db", "SELECT 1")

    def test_default_dependencies_are_created_only_when_analyzing(self):
        with patch("analysis.load_dataset", return_value=DATASET) as load, \
                patch("analysis.create_ai_provider", return_value=provider()) as create, \
                patch("analysis.execute_in_sandbox", return_value={"rows": ROWS, "truncated": False}) as execute:
            result = analysis.analyze("问题")
        load.assert_called_once_with()
        create.assert_called_once_with()
        execute.assert_called_once()
        self.assertEqual(result["status"], "answered")

    def test_real_sample_database_with_injected_local_executor(self):
        # 验证实际样本、字段名和十进制金额；这是本地 SQL 检查，不冒充 Docker 检查。
        with tempfile.TemporaryDirectory(prefix="voice-sample-test-") as root:
            dataset = prepare_dataset(Path(root))
            sql = "SELECT region, SUM(paid_amount) AS sales_amount FROM sales WHERE sold_at >= DATE '2026-09-01' AND sold_at < DATE '2026-10-01' GROUP BY region ORDER BY sales_amount DESC"
            result = analysis.analyze("九月各区域销售额？", dataset=dataset,
                                      provider=provider(decision={**DECISION, "sql": sql}), execute=execute_query)
        self.assertEqual(result["status"], "answered")
        self.assertEqual(result["rows"], [{"region": "华东", "sales_amount": "1599.00"},
                                        {"region": "华南", "sales_amount": "798.00"}])
        self.assertEqual(result["version"], "457f9fcb6e2fc41a327eae9c22a636b28f1d8edb3df129a61a3ead4b60086494")


if __name__ == "__main__":
    unittest.main()
