"""真实 Docker 集成验证：需要事先构建本节 Python 镜像，只清理本次临时容器。"""

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build_image import IMAGE_NAME
from execution_demo import make_task
from dataset import prepare_dataset
from sandbox import docker, run_sandbox, validate_result


ROWS = [{"region": "华东", "sales_amount": "1599.00"}, {"region": "华南", "sales_amount": "798.00"}]


class DockerExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 不自动启动 Docker 或构建镜像；环境未准备时明确失败，不能用 Mock 冒充集成验证。
        docker(["image", "inspect", IMAGE_NAME])
        cls.temporary = tempfile.TemporaryDirectory(prefix="python-restricted-data-")
        cls.dataset = prepare_dataset(cls.temporary.name)
        cls.database = Path(cls.dataset["databasePath"])
        cls.original_hash = hashlib.sha256(cls.database.read_bytes()).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), self.original_hash)

    def run_task(self, name, **options):
        return run_sandbox(make_task(name, ROWS), database_path=self.database, **options)

    def assert_clean(self, report):
        self.assertTrue(report["cleanedUp"])
        self.assertEqual(docker(["ps", "-aq", "--filter", f"name=^/{report['containerName']}$"]), "")

    def test_01_real_sql_and_actual_configuration(self):
        report = self.run_task("sql")
        self.assertEqual(report["status"], "completed", report)
        self.assertEqual(report["result"]["rows"], ROWS)
        execution = report["execution"]
        self.assertEqual(execution["network"], "none")
        self.assertTrue(execution["readOnly"])
        self.assertEqual(execution["user"], "1000:1000")
        self.assertEqual(execution["memoryBytes"], 256 * 1024 * 1024)
        self.assertEqual(execution["nanoCpus"], 1000000000)
        self.assertEqual(execution["pidsLimit"], 64)
        self.assertEqual([mount for mount in execution["mounts"] if mount["destination"] == "/input"],
                         [{"destination": "/input", "writable": False}])
        self.assert_clean(report)

    def test_02_real_code_amount_shares(self):
        report = self.run_task("code")
        self.assertEqual(report["status"], "completed", report)
        self.assertEqual([row["share_percent"] for row in report["result"]["rows"]], ["66.71", "33.29"])
        self.assert_clean(report)

    def test_03_reject_tables_files_and_writes(self):
        for name in ("sql-table", "sql-file", "sql-write"):
            with self.subTest(name=name):
                report = self.run_task(name)
                self.assertEqual(report["status"], "rejected", report)
                self.assertIn("POLICY:", report["error"])
                self.assert_clean(report)

    def test_04_host_probe_invisible_and_input_read_only(self):
        read = self.run_task("read-host")
        self.assertEqual(read["status"], "failed", read)
        self.assertIn("ENOENT", read["error"])
        self.assert_clean(read)
        write = self.run_task("write-input")
        self.assertEqual(write["status"], "failed", write)
        self.assertRegex(write["error"], "EROFS|EACCES")
        self.assert_clean(write)

    def test_05_no_external_network(self):
        report = self.run_task("network")
        self.assertEqual(report["status"], "failed", report)
        self.assertEqual(report["execution"]["network"], "none")
        self.assertRegex(report["error"], "ENETUNREACH|EHOSTUNREACH")
        self.assert_clean(report)

    def test_06_no_host_environment_or_database_for_code(self):
        code = """import os
from pathlib import Path
def analyze(rows):
    return {'rows': [{'secret': os.environ.get('COURSE_RUNTIME_SENTINEL'),
                      'hasDatabase': Path('/input/data.duckdb').exists(), 'uid': os.getuid()}]}
"""
        with patch.dict(os.environ, {"COURSE_RUNTIME_SENTINEL": "host-only"}):
            report = run_sandbox({"kind": "code", "rows": ROWS, "code": code})
        self.assertEqual(report["status"], "completed", report)
        self.assertEqual(report["result"]["rows"], [{"secret": None, "hasDatabase": False, "uid": 1000}])
        self.assert_clean(report)

    def test_07_timeout_removes_entire_container(self):
        report = self.run_task("timeout", timeout_ms=1500)
        self.assertEqual(report["status"], "timeout", report)
        self.assert_clean(report)

    def test_08_output_limit_and_invalid_result(self):
        limited = self.run_task("output")
        self.assertEqual(limited["status"], "output_limit", limited)
        self.assert_clean(limited)
        invalid = run_sandbox({"kind": "code", "rows": ROWS,
                               "code": "def analyze(rows):\n    return {'answer': '没有 rows'}\n"})
        self.assertEqual(invalid["status"], "invalid_result", invalid)
        self.assert_clean(invalid)
        with self.assertRaisesRegex(ValueError, "截断"):
            validate_result({"rows": [], "truncated": True})

    def test_09_oom_is_detected_and_cleaned(self):
        code = """def analyze(rows):
    buffers = []
    for _ in range(64):
        buffers.append(bytearray(b'x' * (8 * 1024 * 1024)))
    return {'rows': [{'count': len(buffers)}]}
"""
        report = run_sandbox({"kind": "code", "rows": [], "code": code})
        self.assertEqual(report["status"], "resource_limit", report)
        self.assert_clean(report)

    def test_10_async_analysis(self):
        code = """import asyncio
async def analyze(rows):
    await asyncio.sleep(0.01)
    return {'rows': [{'count': len(rows)}]}
"""
        report = run_sandbox({"kind": "code", "rows": ROWS, "code": code})
        self.assertEqual(report["status"], "completed", report)
        self.assertEqual(report["result"]["rows"], [{"count": 2}])
        self.assert_clean(report)


if __name__ == "__main__":
    unittest.main()
