"""固定测试输入验证真实执行器，不调用模型，也不验证模型生成代码的能力。"""

import json
import sys
from pathlib import Path

from build_image import PROJECT_DIR
from sandbox import run_sandbox

# 只依赖相邻 Python 04 的数据集与 SQL；资源路径不依赖当前工作目录。
sys.path.insert(0, str(PROJECT_DIR.parent / "04-text-to-sql"))
from dataset import load_dataset  # noqa: E402
from replay import REGION_SQL  # noqa: E402


def make_task(name, rows):
    if name == "sql":
        return {"kind": "sql", "sql": REGION_SQL}
    if name == "sql-table":
        return {"kind": "sql", "sql": "SELECT * FROM sales_raw"}
    if name == "sql-file":
        return {"kind": "sql", "sql": "SELECT * FROM read_csv_auto('/outside/private.csv')"}
    if name == "sql-write":
        return {"kind": "sql", "sql": "DELETE FROM sales"}
    if name == "code":
        code = (PROJECT_DIR / "samples" / "region_share.py").read_text(encoding="utf-8")
    elif name == "read-host":
        # 只创建课程探针，不读取真实私密文件；这个宿主路径不会挂进容器。
        marker = PROJECT_DIR / ".work" / "host-only.txt"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("course-host-only-marker", encoding="utf-8")
        code = f"from pathlib import Path\ndef analyze(rows):\n    return {{'rows': [{{'text': Path({str(marker)!r}).read_text(encoding='utf-8')}}]}}\n"
    elif name == "write-input":
        code = "from pathlib import Path\ndef analyze(rows):\n    Path('/input/rows.json').write_text('[]', encoding='utf-8')\n    return {'rows': []}\n"
    elif name == "network":
        code = "import urllib.request\ndef analyze(rows):\n    with urllib.request.urlopen('http://192.0.2.1', timeout=1.5):\n        pass\n    return {'rows': []}\n"
    elif name == "timeout":
        code = "def analyze(rows):\n    while True:\n        pass\n"
    elif name == "output":
        code = "import sys\ndef analyze(rows):\n    sys.stdout.write('x' * (128 * 1024))\n    sys.stdout.flush()\n    return {'rows': []}\n"
    else:
        raise ValueError("可选：sql、code、sql-table、sql-file、sql-write、read-host、write-input、network、timeout、output")
    return {"kind": "code", "rows": rows, "code": code}


def main(name=None):
    name = name if name is not None else (sys.argv[1] if len(sys.argv) > 1 else "code")
    dataset = load_dataset()
    rows = []
    is_sql = name.startswith("sql")
    if not is_sql:
        # 先在查询容器取结果，成功以后才向另一个分析容器提供有限数据。
        query = run_sandbox({"kind": "sql", "sql": REGION_SQL}, database_path=dataset["databasePath"])
        if query["status"] != "completed":
            raise RuntimeError(f"准备查询结果失败：{query.get('error')}")
        rows = query["result"]["rows"]
        print("查询得到的原始结果：")
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    task = make_task(name, rows)
    report = run_sandbox(task, database_path=dataset["databasePath"], timeout_ms=2000 if name == "timeout" else 5000)
    report["dataset"] = {"datasetId": dataset["context"]["datasetId"], "version": dataset["context"]["version"]}
    print(f"\n测试：{name}\n状态：{report['status']}")
    if "result" in report:
        print(json.dumps(report["result"]["rows"], ensure_ascii=False, indent=2))
    if "error" in report:
        print(f"原因：{report['error']}")
    print(f"容器与临时输入已清理：{str(report['cleanedUp']).lower()}\n执行时间：{report['elapsedMs']}ms")
    output = PROJECT_DIR / "outputs" / f"{name}-{report['jobId']}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    print(f"执行记录：{output}")

    # 负面测试按预期被拦截也算演示成功，退出状态不把“拒绝”误判为程序故障。
    expected = ("rejected" if is_sql and name != "sql" else "failed" if name in {"read-host", "write-input", "network"}
                else "timeout" if name == "timeout" else "output_limit" if name == "output" else "completed")
    if report["status"] != expected:
        raise RuntimeError(f"预期 {expected}，实际 {report['status']}，请检查执行记录。")
    return report


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"执行失败：{error}", file=sys.stderr)
        sys.exit(1)
