"""离线验证：可信固定 SQL 查真实临时数据，Mock 容器协议；不证明 Docker 隔离。"""

import contextlib
import copy
import hashlib
import io
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

import chart_report
from chart_report import cents, create_queries, verify_evidence
from dataset import prepare_dataset
from query_worker import run_read_only_query
from report_view import conclusion, create_chart_option, escape, render_report
from sandbox import validate_result


SPEC = {"type": "bar", "x": "region", "y": "sales_amount"}
ROWS = [{"region": "华东", "sales_amount": "1599.00"}, {"region": "华南", "sales_amount": "798.00"}]
DETAILS = [
    {"source_row": 7, "line_id": "0004", "sold_at": "2026-09-05", "region": "华东", "paid_amount": "1200.00"},
    {"source_row": 8, "line_id": "0005", "sold_at": "2026-09-11", "region": "华南", "paid_amount": "798.00"},
    {"source_row": 9, "line_id": "0006", "sold_at": "2026-09-18", "region": "华东", "paid_amount": "399.00"},
]


def report_fixture(rows=None, details=None):
    queries = create_queries()
    return {
        "reportId": "test-report", "createdAt": "2026-10-08T00:00:00.000Z", "question": "核对销售额",
        "filters": queries["filters"], "dataset": {"sourceFile": "sales-clean.xlsx", "sheet": "销售明细",
        "table": "sales", "version": "a" * 64}, "metric": {"expression": "SUM(paid_amount)", "unit": "元"},
        "sql": queries["summary"], "detailSql": queries["details"], "chartSpec": SPEC.copy(),
        "rows": copy.deepcopy(ROWS if rows is None else rows),
        "details": copy.deepcopy(DETAILS if details is None else details),
    }


def svg_element(html):
    start = html.index("<svg")
    end = html.index("</svg>", start) + len("</svg>")
    return ET.fromstring(html[start:end])


class QueryAndEvidenceTests(unittest.TestCase):
    def test_01_same_filters_and_year_rollover(self):
        query = create_queries("2026-12", "华东")
        self.assertEqual(query["filters"], {"month": "2026-12", "start": "2026-12-01", "end": "2027-01-01", "region": "华东"})
        for sql in (query["summary"], query["details"]):
            self.assertIn("sold_at >= DATE '2026-12-01'", sql)
            self.assertIn("sold_at < DATE '2027-01-01'", sql)
            self.assertIn("region = '华东'", sql)
        self.assertEqual(create_queries("2024-02")["filters"]["end"], "2024-03-01")

    def test_02_invalid_month_and_sql_injection(self):
        for value in (None, 202609, "2026-13", "2026-00", "2026-9", "1999-09", "２026-09", "2026-09\n", "2026-09'; DELETE FROM sales"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "月份"):
                create_queries(value)

    def test_03_region_allowlist(self):
        for value in ("", "华北", 1, "华东' OR true"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "区域"):
                create_queries("2026-09", value)
        for value in (None, "华东", "华南", "西北"):
            self.assertEqual(create_queries("2026-09", value)["filters"]["region"], value)

    def test_04_integer_cents_and_safe_range(self):
        self.assertEqual(cents("0.10") + cents("0.20"), cents("0.30"))
        self.assertEqual(cents("90071992547409.91"), 9007199254740991)
        with self.assertRaisesRegex(ValueError, "绘图范围"):
            cents("90071992547409.92")

    def test_05_bad_amounts(self):
        for value in (None, 1, True, "-1.00", "1", "1.0", "1.001", "NaN", "1e3", "１.00", " 1.00", "1.00\n"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "两位小数"):
                cents(value)

    def test_06_valid_and_empty_evidence(self):
        verify_evidence(ROWS, DETAILS)
        verify_evidence([], [])
        verify_evidence([{"region": "小额", "sales_amount": "0.30"}], [
            {"source_row": 1, "line_id": "a", "region": "小额", "paid_amount": "0.10"},
            {"source_row": 2, "line_id": "b", "region": "小额", "paid_amount": "0.20"},
        ])

    def test_07_amount_mismatch_and_missing_detail(self):
        bad = copy.deepcopy(ROWS)
        bad[0]["sales_amount"] = "1600.00"
        for rows, details in ((bad, DETAILS), (ROWS, DETAILS[:2])):
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "合计与图表金额不一致"):
                verify_evidence(rows, details)

    def test_08_duplicate_detail_and_bad_source_row(self):
        with self.assertRaisesRegex(ValueError, "重复明细"):
            verify_evidence(ROWS, DETAILS + [DETAILS[0]])
        for source in (None, 0, -1, 1.5, True, "7"):
            bad = copy.deepcopy(DETAILS)
            bad[0]["source_row"] = source
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "原始行号"):
                verify_evidence(ROWS, bad)
        for line_id in (None, "", 1):
            bad = copy.deepcopy(DETAILS)
            bad[0]["line_id"] = line_id
            with self.subTest(line_id=line_id), self.assertRaisesRegex(ValueError, "原始行号"):
                verify_evidence(ROWS, bad)

    def test_09_region_mismatch_and_duplicate_summary(self):
        for rows, details in ((ROWS, []), ([], DETAILS), (ROWS + [ROWS[0]], DETAILS),
                              ([{**ROWS[0], "region": "西北"}, ROWS[1]], DETAILS)):
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "区域不一致|合计与图表金额不一致"):
                verify_evidence(rows, details)


class ChartAndViewTests(unittest.TestCase):
    def test_10_mapping_uses_original_rows(self):
        option = create_chart_option(SPEC, ROWS)
        self.assertIs(option["dataset"]["source"], ROWS)
        self.assertEqual(option["series"][0]["encode"], {"x": "region", "y": "sales_amount"})
        self.assertEqual(option["series"][0]["label"]["formatter"]({"data": ROWS[0]}), "1599.00")

    def test_11_reject_free_configuration_and_data(self):
        for spec in (None, {}, {**SPEC, "y": "profit"}, {**SPEC, "data": [9000]}, {**SPEC, "type": "line"}, {**SPEC, "x": "date"}):
            with self.subTest(spec=spec), self.assertRaisesRegex(ValueError, "图表配置无效"):
                create_chart_option(spec, ROWS)

    def test_12_chart_data_types_and_utf16_lengths(self):
        for rows in (None, {}, ROWS * 11, [None], [{"region": "", "sales_amount": "1.00"}],
                     [{"region": "🙂" * 21, "sales_amount": "1.00"}], [{"region": "区域", "sales_amount": 1}],
                     [{"region": "区域", "sales_amount": "NaN"}], [{"region": "区域", "sales_amount": "9" * 400 + ".00"}]):
            with self.subTest(rows=str(rows)[:40]), self.assertRaisesRegex(ValueError, "图表数据无效"):
                create_chart_option(SPEC, rows)
        create_chart_option(SPEC, [{"region": "🙂" * 20, "sales_amount": "1.00"}] * 20)

    def test_13_empty_single_highest_and_ties(self):
        self.assertIn("无法据此判断销售额为 0", conclusion([]))
        self.assertEqual(conclusion(ROWS[:1]), "本次已导入记录中，华东未扣退款销售额为 1599.00 元。")
        self.assertIn("华东未扣退款销售额最高，为 1599.00 元", conclusion(list(reversed(ROWS))))
        self.assertIn("华东、华南", conclusion([ROWS[0], {**ROWS[1], "sales_amount": "1599.00"}]))

    def test_14_real_svg_has_actual_values_and_ratio(self):
        html = render_report(report_fixture())
        svg = svg_element(html)
        namespace = {"svg": "http://www.w3.org/2000/svg"}
        rects = svg.findall(".//svg:rect", namespace)
        self.assertEqual(len(rects), 2)
        self.assertAlmostEqual(float(rects[0].get("height")) / float(rects[1].get("height")), 1599 / 798, places=4)
        text = [node.text for node in svg.findall(".//svg:text", namespace)]
        self.assertIn("1599.00", text)
        self.assertIn("798.00", text)
        self.assertIn("华东", text)
        self.assertEqual(svg.get("viewBox"), "0 0 800 300")
        self.assertNotIn("<script", html)
        self.assertNotIn("<iframe", html)
        self.assertNotIn("https://", html)

    def test_15_report_has_equations_sql_and_downloads(self):
        html = render_report(report_fixture())
        for value in ('href="#evidence-0"', 'href="#evidence-1"', 'id="evidence-0"',
                      'href="source.xlsx"', 'href="report.json"', "1200.00 + 399.00 = 1599.00", "798.00 = 798.00",
                      "Excel 行号", "2026-09-05", "0004", "SUM(paid_amount)", "a" * 64, "不代表完整月度业绩"):
            self.assertIn(value, html)

    def test_16_empty_report_has_no_old_chart_or_zero_inference(self):
        render_report(report_fixture())
        html = render_report(report_fixture([], []))
        self.assertNotIn("<svg", html)
        self.assertNotIn("1599.00", html)
        self.assertIn("无法据此判断销售额为 0", html)
        self.assertIn("不绘制零值柱状图", html)

    def test_17_html_and_svg_escape_data(self):
        report = report_fixture()
        report["question"] = '<script>alert("x")</script>'
        report["dataset"]["sourceFile"] = '销售<&>"\'.xlsx'
        report["details"][0]["line_id"] = '<img src=x onerror="alert(1)">'
        report["rows"][0]["region"] = '<script>alert(1)</script>'
        report["details"][0]["region"] = report["rows"][0]["region"]
        html = render_report(report)
        self.assertNotIn("<script", html)
        self.assertNotIn("<img", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertIn("&lt;img", html)
        svg_element(html)
        self.assertEqual(escape('&<>"\''), "&amp;&lt;&gt;&quot;&#39;")

    def test_18_zero_is_different_from_missing(self):
        report = report_fixture([{"region": "华东", "sales_amount": "0.00"}], [])
        svg = svg_element(render_report(report))
        rect = svg.find(".//{http://www.w3.org/2000/svg}rect")
        self.assertEqual(float(rect.get("height")), 0)
        self.assertIn("销售额为 0.00 元", conclusion(report["rows"]))


class ReportPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source_temporary = tempfile.TemporaryDirectory(prefix="chart-source-tests-")
        cls.dataset = prepare_dataset(Path(cls.source_temporary.name) / "data")
        cls.database = Path(cls.dataset["databasePath"])
        cls.source = cls.database.parent / "source.xlsx"
        cls.database_hash = hashlib.sha256(cls.database.read_bytes()).hexdigest()
        cls.source_hash = hashlib.sha256(cls.source.read_bytes()).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.source_temporary.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="chart-output-tests-")
        self.root = Path(self.temporary.name)
        self.calls = []

    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), self.database_hash)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.source_hash)
        self.temporary.cleanup()

    def fake_sandbox(self, task, *, database_path):
        # 仅验证课程维护的固定 SQL，不是应用在 Docker 不可用时的执行路径。
        allowed = [query[key] for options in ({}, {"month": "2026-08"}, {"region": "华东"}, {"region": "西北"})
                   for query in [create_queries(**options)] for key in ("summary", "details")]
        self.assertEqual(task["kind"], "sql")
        self.assertIn(task["sql"], allowed)
        self.assertNotEqual(Path(database_path), self.database)
        self.calls.append((task.copy(), Path(database_path)))
        result = validate_result(run_read_only_query(database_path, task["sql"]))
        return {"jobId": f"mock-job-{len(self.calls)}", "status": "completed", "kind": "sql",
                "result": result, "cleanedUp": True, "elapsedMs": 1, "execution": {"verification": "mock-not-docker"}}

    def run_report(self, options=None, executor=None):
        with patch.object(chart_report, "PROJECT_DIR", self.root), \
                patch.object(chart_report, "load_dataset", return_value=self.dataset), \
                patch.object(chart_report, "run_sandbox", side_effect=executor or self.fake_sandbox), \
                contextlib.redirect_stdout(io.StringIO()):
            return chart_report.main(options)

    def assert_no_half_report(self):
        self.assertEqual(list((self.root / "outputs").iterdir()), [])

    def test_19_default_report_files_hashes_and_real_rows(self):
        result = self.run_report()
        report, output = result["report"], Path(result["output"])
        self.assertEqual({file.name for file in output.iterdir()}, {"report.json", "report.html", "data.duckdb", "source.xlsx"})
        self.assertEqual(report["rows"], ROWS)
        self.assertEqual(report["details"], DETAILS)
        self.assertEqual(report["dataset"]["version"], "457f9fcb6e2fc41a327eae9c22a636b28f1d8edb3df129a61a3ead4b60086494")
        self.assertEqual(report["dataset"]["sourceHash"], self.source_hash)
        self.assertEqual(report["dataset"]["databaseHash"], self.database_hash)
        self.assertEqual((output / "source.xlsx").read_bytes(), self.source.read_bytes())
        self.assertEqual(json.loads((output / "report.json").read_text()), report)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][1], self.calls[1][1])
        self.assertEqual(self.calls[0][1], output / "data.duckdb")
        self.assertEqual(report["executions"]["details"]["execution"]["verification"], "mock-not-docker")
        svg_element((output / "report.html").read_text())

    def test_20_august_report(self):
        report = self.run_report({"month": "2026-08"})["report"]
        self.assertEqual(report["rows"], [{"region": "华东", "sales_amount": "2799.50"}, {"region": "华南", "sales_amount": "1200.00"}])
        self.assertEqual([row["source_row"] for row in report["details"]], [4, 5, 6])

    def test_21_filtered_region(self):
        report = self.run_report({"region": "华东"})["report"]
        self.assertEqual(report["rows"], ROWS[:1])
        self.assertEqual([row["source_row"] for row in report["details"]], [7, 9])
        self.assertIn("华东的未扣退款销售额", report["question"])

    def test_22_missing_region_is_not_zero(self):
        result = self.run_report({"region": "西北"})
        self.assertEqual(result["report"]["rows"], [])
        self.assertEqual(result["report"]["details"], [])
        html = (Path(result["output"]) / "report.html").read_text()
        self.assertNotIn("<svg", html)
        self.assertIn("无法据此判断销售额为 0", html)

    def test_23_invalid_options_do_not_load_or_query(self):
        for options in ({"y": "profit"}, {"month": "2026-13"}, {"region": "华东' OR true"}):
            with self.subTest(options=options), patch.object(chart_report, "load_dataset") as load, \
                    patch.object(chart_report, "run_sandbox") as run, self.assertRaises(ValueError):
                chart_report.main(options)
            load.assert_not_called()
            run.assert_not_called()

    def test_24_wrong_source_profile_fails_before_outputs(self):
        with patch.object(chart_report.json, "loads", return_value={"sourceCopy": "outside.xlsx", "importOptions": {"sheet": "销售明细"}}), \
                self.assertRaisesRegex(ValueError, "需要 04 导入"):
            self.run_report()
        self.assertFalse((self.root / "outputs").exists())

    def test_25_source_hash_mismatch_cleans_report_before_queries(self):
        profile = json.loads((self.database.parent / "profile.json").read_text())
        profile["sourceHash"] = "0" * 64
        with patch.object(chart_report.json, "loads", return_value=profile), \
                self.assertRaisesRegex(ValueError, "原文件副本与导入版本不一致"):
            self.run_report()
        self.assertEqual(self.calls, [])
        self.assert_no_half_report()

    def test_26_summary_failure_stops_and_cleans(self):
        calls = []
        def fail(task, **_):
            calls.append(task)
            return {"status": "rejected", "error": "POLICY: 拒绝"}
        with self.assertRaisesRegex(RuntimeError, "汇总查询失败"):
            self.run_report(executor=fail)
        self.assertEqual(len(calls), 1)
        self.assert_no_half_report()

    def test_27_detail_failure_cleans(self):
        def fail_details(task, **options):
            if "source_row" in task["sql"]:
                return {"status": "timeout", "error": "超时"}
            return self.fake_sandbox(task, **options)
        with self.assertRaisesRegex(RuntimeError, "明细查询失败"):
            self.run_report(executor=fail_details)
        self.assert_no_half_report()

    def test_28_mismatched_evidence_cleans(self):
        def changed(task, **options):
            response = self.fake_sandbox(task, **options)
            if "source_row" in task["sql"]:
                response["result"]["rows"][0]["paid_amount"] = "0.01"
            return response
        with self.assertRaisesRegex(ValueError, "合计与图表金额不一致"):
            self.run_report(executor=changed)
        self.assert_no_half_report()

    def test_29_truncation_cannot_become_evidence(self):
        def truncated(*_, **__):
            validate_result({"rows": DETAILS[:1], "truncated": True})
        with self.assertRaisesRegex(ValueError, "截断"):
            self.run_report(executor=truncated)
        self.assert_no_half_report()

    def test_30_render_failure_removes_json_and_copies(self):
        with patch.object(chart_report, "render_report", side_effect=RuntimeError("绘图失败")), \
                self.assertRaisesRegex(RuntimeError, "绘图失败"):
            self.run_report()
        self.assert_no_half_report()

    def test_31_docker_unavailable_never_falls_back(self):
        def unavailable(*_, **__):
            raise RuntimeError("Docker 不可达")
        with self.assertRaisesRegex(RuntimeError, "Docker 不可达"):
            self.run_report(executor=unavailable)
        self.assertEqual(self.calls, [])
        self.assert_no_half_report()

    def test_32_new_report_never_overwrites_previous_success(self):
        first = self.run_report()
        original = (Path(first["output"]) / "report.json").read_bytes()
        second = self.run_report({"region": "华东"})
        self.assertNotEqual(first["output"], second["output"])
        self.assertEqual((Path(first["output"]) / "report.json").read_bytes(), original)
        with patch.object(chart_report, "render_report", side_effect=RuntimeError("绘图失败")), self.assertRaises(RuntimeError):
            self.run_report()
        self.assertEqual({file.name for file in (self.root / "outputs").iterdir()},
                         {first["report"]["reportId"], second["report"]["reportId"]})

    def test_33_output_write_failure_cleans(self):
        original = Path.write_text
        def fail_write(file, *args, **kwargs):
            if file.name == "report.html":
                raise OSError("磁盘写入失败")
            return original(file, *args, **kwargs)
        with patch.object(Path, "write_text", fail_write), self.assertRaisesRegex(OSError, "磁盘写入失败"):
            self.run_report()
        self.assert_no_half_report()


if __name__ == "__main__":
    unittest.main()
