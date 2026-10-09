"""真实样本在临时目录导入/只读查询；此测试不证明 Docker 隔离。"""

import asyncio
import hashlib
import tempfile
import unittest
from pathlib import Path

from sandbox_check import check, prepare_dataset
from query_worker import run_read_only_query


class SampleTests(unittest.TestCase):
    def test_original_sample_amounts_and_read_only_database(self):
        with tempfile.TemporaryDirectory(prefix="streaming-data-test-") as root:
            dataset = prepare_dataset(Path(root))
            database = Path(dataset["databasePath"])
            before = hashlib.sha256(database.read_bytes()).hexdigest()
            packets = asyncio.run(check(dataset, execute=run_read_only_query))
            self.assertEqual(hashlib.sha256(database.read_bytes()).hexdigest(), before)
            query = next(p["data"] for p in packets if p["event"] == "query.result")
            self.assertEqual(query["metric"], "未扣退款销售额")
            self.assertEqual(query["scope"], "2026 年 9 月已导入记录")
            self.assertEqual(dataset["context"]["rowCount"], 6)


if __name__ == "__main__":
    unittest.main()
