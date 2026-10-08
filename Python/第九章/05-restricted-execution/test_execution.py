"""离线验证宿主协议、输入边界、参数与清理；Mock 不代表 Docker 隔离已生效。"""

import contextlib
import importlib.util
import io
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_image
import execution_demo
import sandbox
from runtime.model import utf16_length


ROWS = [{"region": "华东", "sales_amount": "1599.00"}, {"region": "华南", "sales_amount": "798.00"}]
DETAILS = {
    "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Memory": 268435456,
                   "NanoCpus": 1000000000, "PidsLimit": 64},
    "Config": {"User": "1000:1000"},
    "Mounts": [{"Destination": "/input", "RW": False}], "State": {"OOMKilled": False},
}


class HostProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="restricted-host-tests-")
        self.root = Path(self.temporary.name)
        self.database = self.root / "source.duckdb"
        self.database.write_bytes(b"trusted-database-fixture")
        self.patch_root = patch.object(sandbox, "JOB_ROOT", self.root / "jobs")
        self.patch_root.start()
        self.calls = []
        self.input_directory = None

    def tearDown(self):
        self.patch_root.stop()
        self.temporary.cleanup()

    def fake_docker(self, args):
        self.calls.append(args)
        if args[0] == "create":
            mount = args[args.index("--mount") + 1]
            self.input_directory = Path(mount.split("source=", 1)[1].split(",target=", 1)[0])
            self.input_files = {file.name: file.read_bytes() for file in self.input_directory.iterdir()}
            self.assertEqual(self.input_directory.stat().st_mode & 0o777, 0o555)
            self.assertTrue(all(file.stat().st_mode & 0o777 == 0o444 for file in self.input_directory.iterdir()))
            return "container-fixture"
        if args[0] == "inspect":
            return json.dumps([DETAILS])
        if args[0] == "ps":
            return "container-fixture"
        if args[0] == "rm":
            return "container-fixture"
        self.fail(f"未预期的 Docker 调用：{args}")

    def mock_run(self, *, task=None, message=None, code=0, stopped=None, raw=None):
        task = task or {"kind": "sql", "sql": "SELECT * FROM sales"}
        message = message if message is not None else {"ok": True, "result": {"rows": ROWS}}
        output = {"stdout": json.dumps(message) if raw is None else raw, "stderr": "",
                  "exitCode": code, "stopped": stopped}
        with patch.object(sandbox, "docker", side_effect=self.fake_docker), \
                patch.object(sandbox, "start_and_collect", return_value=output) as start:
            report = sandbox.run_sandbox(task, database_path=self.database)
        self.assertEqual(start.call_count, 1)
        self.assertTrue(report["cleanedUp"])
        self.assertFalse(self.input_directory.parent.exists())
        return report

    def test_01_container_arguments_and_namespace(self):
        args = sandbox.container_args("course-analysis-test", self.root / "中文 路径")
        expected = {"--network": "none", "--user": "1000:1000", "--cap-drop": "ALL",
                    "--security-opt": "no-new-privileges=true", "--cpus": "1", "--memory": "256m",
                    "--memory-swap": "256m", "--pids-limit": "64", "--log-driver": "none"}
        for flag, value in expected.items():
            self.assertEqual(args[args.index(flag) + 1], value)
        self.assertIn("--read-only", args)
        self.assertIn("--init", args)
        self.assertEqual(args[-1], "agent-course-analysis-python:chapter9-05")
        self.assertNotIn("--env", args)
        self.assertNotIn("--privileged", args)
        self.assertEqual(args[args.index("--tmpfs") + 1], "/tmp:rw,noexec,nosuid,size=16m,mode=1777")
        with self.assertRaisesRegex(ValueError, "英文逗号"):
            sandbox.container_args("name", "/tmp/bad,path")

    def test_02_valid_result_and_extra_metadata(self):
        self.assertEqual(sandbox.validate_result({"rows": ROWS, "extra": "ignored"}), {"rows": ROWS})
        self.assertEqual(sandbox.validate_result({"rows": [{}] * 100}), {"rows": [{}] * 100})
        values = {"null": None, "boolean": False, "zero": 0, "float": 1.25, "text": "字" * 1000}
        self.assertEqual(sandbox.validate_result({"rows": [values]})["rows"], [values])

    def test_03_invalid_result_rows(self):
        for value in (None, [], {}, {"rows": None}, {"rows": [{}] * 101}, {"rows": [[]]},
                      {"rows": [None]}, {"rows": ["text"]}, {"rows": [{str(n): n for n in range(21)}]}):
            with self.subTest(value=str(value)[:30]), self.assertRaises(ValueError):
                sandbox.validate_result(value)

    def test_04_invalid_field_types_and_lengths(self):
        for value in ([1], {"x": 1}, math.nan, math.inf, -math.inf, "x" * 1001, "🙂" * 501):
            with self.subTest(value=str(value)[:30]), self.assertRaisesRegex(ValueError, "字段"):
                sandbox.validate_result({"rows": [{"field": value}]})
        with self.assertRaisesRegex(ValueError, "字段"):
            sandbox.validate_result({"rows": [{"🙂" * 33: 1}]})
        self.assertEqual(utf16_length("🙂" * 32), 64)

    def test_05_truncated_result(self):
        with self.assertRaisesRegex(ValueError, "截断"):
            sandbox.validate_result({"rows": [], "truncated": True})
        self.assertEqual(sandbox.validate_result({"rows": [], "truncated": 1}), {"rows": []})

    def test_06_timeout_input_validation(self):
        for value in (99, 30001, 1.5, True, None, "5000"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "执行时限"):
                sandbox.run_sandbox({"kind": "sql", "sql": "SELECT * FROM sales"}, database_path=self.database, timeout_ms=value)

    def test_07_sql_input_validation(self):
        for task, database in (({"kind": "sql", "sql": "SELECT * FROM sales"}, None),
                               ({"kind": "sql", "sql": 1}, self.database),
                               ({"kind": "sql", "sql": "🙂" * 6001}, self.database)):
            with self.subTest(task=str(task)[:30]), self.assertRaisesRegex(ValueError, "SQL 任务"):
                sandbox.run_sandbox(task, database_path=database)

    def test_08_code_byte_size_validation(self):
        for code in (None, 1, "x" * (16 * 1024 + 1), "字" * 5462):
            with self.subTest(code=str(code)[:20]), self.assertRaisesRegex(ValueError, "分析代码"):
                sandbox.run_sandbox({"kind": "code", "code": code, "rows": []})
        self.mock_run(task={"kind": "code", "code": "x" * (16 * 1024), "rows": []})

    def test_09_data_byte_size_and_unknown_kind(self):
        with self.assertRaisesRegex(ValueError, "输入数据超过"):
            sandbox.run_sandbox({"kind": "code", "code": "def analyze(rows): pass", "rows": [{"text": "字" * 1000}] * 30})
        for task in ({"kind": "shell"}, {}, None):
            with self.subTest(task=task), self.assertRaisesRegex(ValueError, "只允许"):
                sandbox.run_sandbox(task)

    def test_10_sql_files_original_unchanged_and_cleanup_order(self):
        report = self.mock_run()
        self.assertEqual(set(self.input_files), {"request.json", "data.duckdb"})
        self.assertEqual(self.input_files["data.duckdb"], b"trusted-database-fixture")
        self.assertEqual(self.database.read_bytes(), b"trusted-database-fixture")
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["result"], {"rows": ROWS})
        self.assertRegex(report["jobId"], r"^[a-f0-9-]{36}$")
        self.assertEqual(report["containerName"], f"course-analysis-{report['jobId']}")
        self.assertEqual([call[0] for call in self.calls], ["create", "inspect", "inspect", "ps", "rm"])

    def test_11_code_task_only_has_finite_rows_and_source(self):
        # 未执行这份任务代码；只检查发送到容器的文件与协议。
        code = "raise RuntimeError('不应该在宿主执行')"
        self.mock_run(task={"kind": "code", "code": code, "rows": ROWS, "image": "evil", "databasePath": "/other"})
        self.assertEqual(set(self.input_files), {"request.json", "rows.json", "analysis.py"})
        self.assertEqual(json.loads(self.input_files["request.json"]), {"kind": "code"})
        self.assertEqual(self.input_files["analysis.py"].decode(), code)
        self.assertEqual(self.calls[0][-1], build_image.IMAGE_NAME)

    def test_12_policy_error_is_rejected(self):
        report = self.mock_run(message={"ok": False, "error": "POLICY: forbidden"}, code=1)
        self.assertEqual(report["status"], "rejected")

    def test_13_runtime_error_is_failed_and_bounded(self):
        report = self.mock_run(message={"ok": False, "error": "字" * 2000}, code=1)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(len(report["error"]), 1600)
        fallback = self.mock_run(message={"ok": False})
        self.assertEqual(fallback["error"], "执行失败。")

    def test_14_invalid_json_or_result_is_not_completed(self):
        for raw in ("bad JSON", "null", "[]", '{"ok":true,"result":{"rows":[{"x":NaN}]}}'):
            with self.subTest(raw=raw):
                report = self.mock_run(raw=raw)
                self.assertEqual(report["status"], "invalid_result")
        report = self.mock_run(message={"ok": True, "result": {"rows": [], "truncated": True}})
        self.assertEqual(report["status"], "invalid_result")

    def test_15_oom_takes_priority_over_broken_output(self):
        details = json.loads(json.dumps(DETAILS))
        details["State"]["OOMKilled"] = True
        with patch.dict(DETAILS, details):
            report = self.mock_run(raw="", code=137)
        self.assertEqual(report["status"], "resource_limit")

    def test_16_timeout_and_output_limit(self):
        for status in ("timeout", "output_limit"):
            with self.subTest(status=status):
                report = self.mock_run(stopped=status, raw="")
                self.assertEqual(report["status"], status)
                self.assertNotIn("result", report)

    def test_17_partial_create_failure_still_removes_container(self):
        original = self.fake_docker
        def fail_create(args):
            response = original(args)
            if args[0] == "create":
                raise RuntimeError("创建失败")
            return response
        with patch.object(sandbox, "docker", side_effect=fail_create), self.assertRaisesRegex(RuntimeError, "创建失败"):
            sandbox.run_sandbox({"kind": "sql", "sql": "SELECT * FROM sales"}, database_path=self.database)
        self.assertEqual([call[0] for call in self.calls], ["create", "ps", "rm"])
        self.assertFalse(self.input_directory.parent.exists())

    def test_18_cleanup_failure_cannot_claim_cleaned_up(self):
        def fail_cleanup(args):
            if args[0] == "ps":
                raise RuntimeError("Docker 不可达，清理失败")
            return self.fake_docker(args)
        with patch.object(sandbox, "docker", side_effect=fail_cleanup), \
                patch.object(sandbox, "start_and_collect", return_value={"stdout": '{"ok":true,"result":{"rows":[]}}', "exitCode": 0, "stopped": None}), \
                self.assertRaisesRegex(RuntimeError, "清理失败"):
            sandbox.run_sandbox({"kind": "code", "rows": [], "code": "def analyze(rows): pass"})

    def test_19_missing_database_does_not_create_container(self):
        with patch.object(sandbox, "docker") as managed, self.assertRaises(FileNotFoundError):
            sandbox.run_sandbox({"kind": "sql", "sql": "SELECT * FROM sales"}, database_path=self.root / "missing.duckdb")
        managed.assert_not_called()
        self.assertEqual(list((self.root / "jobs").iterdir()), [])


class ProcessTests(unittest.TestCase):
    def child(self, source):
        # 仅执行测试维护的固定、可信管道夹具，不把分析任务 code 交给宿主解释器。
        return subprocess.Popen([sys.executable, "-X", "utf8", "-B", "-c", source], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_20_collect_success(self):
        child = self.child("import sys; sys.stdout.write('正常'); sys.stderr.write('提示')")
        result = sandbox._collect_process(child, 2000, 65536)
        self.assertEqual(result, {"stdout": "正常", "stderr": "提示", "exitCode": 0, "stopped": None})

    def test_21_combined_utf8_byte_limit(self):
        child = self.child("import sys; sys.stdout.write('字'*10); sys.stdout.flush(); sys.stderr.write('字'*10)")
        stopped = []
        result = sandbox._collect_process(child, 2000, 40, on_stop=stopped.append)
        self.assertEqual(result["stopped"], "output_limit")
        self.assertEqual(stopped, ["output_limit"])
        self.assertIsNotNone(child.poll())

    def test_22_timeout_kills_client_after_stop_callback(self):
        child = self.child("import time; time.sleep(1)")
        stopped = []
        result = sandbox._collect_process(child, 30, 65536, on_stop=stopped.append)
        self.assertEqual(result["stopped"], "timeout")
        self.assertEqual(stopped, ["timeout"])
        self.assertIsNotNone(child.poll())

    def test_23_stop_failure_still_reaps_client(self):
        child = self.child("import time; time.sleep(1)")
        def stop(_status):
            raise RuntimeError("停止容器失败")
        with self.assertRaisesRegex(RuntimeError, "停止容器失败"):
            sandbox._collect_process(child, 30, 65536, on_stop=stop)
        self.assertIsNotNone(child.poll())

    def test_24_management_command_no_shell(self):
        child = self.child("print(' fixture ') ")
        with patch.object(sandbox.subprocess, "Popen", return_value=child) as popen:
            self.assertEqual(sandbox.docker(["inspect", "name;not-a-shell-command"]), "fixture")
        self.assertEqual(popen.call_args[0][0], ["docker", "inspect", "name;not-a-shell-command"])
        self.assertNotIn("shell", popen.call_args.kwargs)

    def test_25_start_timeout_removes_full_container(self):
        child = self.child("import time; time.sleep(1)")
        with patch.object(sandbox.subprocess, "Popen", return_value=child), patch.object(sandbox, "docker") as manage:
            report = sandbox.start_and_collect("course-analysis-fixture", 30)
        self.assertEqual(report["stopped"], "timeout")
        manage.assert_called_once_with(["rm", "--force", "course-analysis-fixture"])


class BuildAndDemoTests(unittest.TestCase):
    def test_26_build_context_only_fixed_files(self):
        contexts = []
        def build(args, **kwargs):
            context = Path(args[-1])
            contexts.append(context)
            self.assertEqual(set(file.name for file in context.iterdir()),
                             {"Dockerfile", "requirements.lock", "entry.py", "model.py", "query_worker.py"})
            self.assertEqual((context / "query_worker.py").read_bytes(),
                             (build_image.PROJECT_DIR.parent / "04-text-to-sql" / "query_worker.py").read_bytes())
            self.assertEqual(args[:4], ["docker", "build", "--tag", build_image.IMAGE_NAME])
            self.assertNotIn("shell", kwargs)
            return subprocess.CompletedProcess(args, 0)
        with patch.object(build_image.subprocess, "run", side_effect=build):
            build_image.build_image()
        self.assertFalse(contexts[0].exists())

    def test_27_failed_build_also_cleans_context(self):
        contexts = []
        def fail(args, **_kwargs):
            contexts.append(Path(args[-1]))
            return subprocess.CompletedProcess(args, 1)
        with patch.object(build_image.subprocess, "run", side_effect=fail), self.assertRaisesRegex(RuntimeError, "镜像构建失败"):
            build_image.build_image()
        self.assertFalse(contexts[0].exists())

    def test_28_trusted_algorithm_fixture(self):
        # 算法单元测试只加载本仓库维护的可信样本，不执行 run_sandbox 接收的 task.code。
        spec = importlib.util.spec_from_file_location("trusted_share_fixture", build_image.PROJECT_DIR / "samples" / "region_share.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = module.analyze(ROWS)
        self.assertEqual([row["share_percent"] for row in result["rows"]], ["66.71", "33.29"])
        self.assertEqual(module.analyze([]), {"rows": []})
        self.assertEqual(module.analyze([{"region": "无", "sales_amount": "0.00"}])["rows"][0]["share_percent"], None)

    def test_29_all_scenario_payloads_compile_without_executing(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(execution_demo, "PROJECT_DIR", Path(folder)):
            for name in ("sql", "sql-table", "sql-file", "sql-write", "read-host", "write-input", "network", "timeout", "output"):
                task = execution_demo.make_task(name, ROWS)
                if task["kind"] == "code":
                    compile(task["code"], "fixture.py", "exec")
                    self.assertEqual(task["rows"], ROWS)
            self.assertEqual((Path(folder) / ".work" / "host-only.txt").read_text(), "course-host-only-marker")
        with self.assertRaisesRegex(ValueError, "可选"):
            execution_demo.make_task("unknown", ROWS)

    def test_30_demo_queries_before_code_and_saves_report(self):
        dataset = {"databasePath": "/trusted/data.duckdb", "context": {"datasetId": "sales-demo", "version": "a" * 64}}
        query = {"status": "completed", "result": {"rows": ROWS}}
        result = {"jobId": "fixture", "status": "completed", "result": {"rows": ROWS}, "cleanedUp": True, "elapsedMs": 1}
        with tempfile.TemporaryDirectory() as folder, patch.object(execution_demo, "PROJECT_DIR", Path(folder)), \
                patch.object(execution_demo, "load_dataset", return_value=dataset), \
                patch.object(execution_demo, "make_task", return_value={"kind": "code", "rows": ROWS, "code": "fixture"}), \
                patch.object(execution_demo, "run_sandbox", side_effect=[query, result]) as run, \
                contextlib.redirect_stdout(io.StringIO()):
            report = execution_demo.main("code")
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args_list[0].args[0]["kind"], "sql")
            self.assertEqual(json.loads((Path(folder) / "outputs" / "code-fixture.json").read_text()), report)
            self.assertEqual(report["dataset"], dataset["context"])

    def test_31_query_failure_does_not_start_analysis(self):
        with patch.object(execution_demo, "load_dataset", return_value={"databasePath": "/trusted"}), \
                patch.object(execution_demo, "run_sandbox", return_value={"status": "rejected", "error": "POLICY"}) as run, \
                self.assertRaisesRegex(RuntimeError, "准备查询结果失败"):
            execution_demo.main("code")
        self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
