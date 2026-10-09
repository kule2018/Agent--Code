"""真实容器到 HTML 的集成验证，需事先准备 Docker 和 Python 05 镜像。"""

import contextlib
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import chart_report
from build_image import IMAGE_NAME
from dataset import prepare_dataset
from sandbox import docker


class DockerChartReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 不自动启动服务或构建镜像；缺少环境时明确失败，不用 Mock 冒充验证。
        docker(["image", "inspect", IMAGE_NAME])
        cls.temporary = tempfile.TemporaryDirectory(prefix="docker-chart-tests-")
        cls.root = Path(cls.temporary.name)
        cls.dataset = prepare_dataset(cls.root / "data")
        cls.database = Path(cls.dataset["databasePath"])
        cls.database_hash = hashlib.sha256(cls.database.read_bytes()).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_report(self, options=None):
        with patch.object(chart_report, "PROJECT_DIR", self.root / "reports"), \
                patch.object(chart_report, "load_dataset", return_value=self.dataset), \
                contextlib.redirect_stdout(io.StringIO()):
            result = chart_report.main(options)
        for run in result["report"]["executions"].values():
            self.assertEqual(run["status"], "completed")
            self.assertTrue(run["cleanedUp"])
            self.assertEqual(run["execution"]["network"], "none")
            self.assertTrue(run["execution"]["readOnly"])
            self.assertEqual(docker(["ps", "-aq", "--filter", f"name=^/{run['containerName']}$"]), "")
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), self.database_hash)
        output = Path(result["output"])
        self.assertEqual(json.loads((output / "report.json").read_text()), result["report"])
        self.assertEqual({file.name for file in output.iterdir()}, {"report.json", "report.html", "data.duckdb", "source.xlsx"})
        return result

    def test_default_report(self):
        result = self.run_report()
        self.assertEqual(result["report"]["rows"], [{"region": "华东", "sales_amount": "1599.00"}, {"region": "华南", "sales_amount": "798.00"}])
        self.assertEqual(len(result["report"]["details"]), 3)
        self.assertIn("<svg", (Path(result["output"]) / "report.html").read_text())

    def test_august(self):
        result = self.run_report({"month": "2026-08"})
        self.assertEqual([row["sales_amount"] for row in result["report"]["rows"]], ["2799.50", "1200.00"])

    def test_region_and_empty(self):
        east = self.run_report({"region": "华东"})
        self.assertEqual([row["source_row"] for row in east["report"]["details"]], [7, 9])
        empty = self.run_report({"region": "西北"})
        self.assertEqual(empty["report"]["rows"], [])
        html = (Path(empty["output"]) / "report.html").read_text()
        self.assertNotIn("<svg", html)
        self.assertIn("无法据此判断销售额为 0", html)


if __name__ == "__main__":
    unittest.main()
