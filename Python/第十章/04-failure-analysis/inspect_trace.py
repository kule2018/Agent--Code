"""离线重读 Trace；避免命名为 inspect.py，遮蔽 Python 标准库 inspect。"""

from pathlib import Path
import sys

from report import print_report
from scoring import parse_json


DEFAULT_PATH = Path(__file__).resolve().parent / "outputs" / "latest.json"


def inspect_report(path=None):
    selected = DEFAULT_PATH if path is None else Path(path)
    # 命令只用于本节报告，环境文件即使被误传为参数也不能读取。
    if selected.name == ".env" or selected.name.startswith(".env."):
        raise ValueError("请传入本节生成的 Trace JSON 文件。")
    report = parse_json(selected.read_text(encoding="utf-8"))
    if (not isinstance(report, dict) or type(report.get("schemaVersion")) not in (int, float)
            or report["schemaVersion"] != 1 or not isinstance(report.get("spans"), list)
            or not isinstance(report.get("evaluation"), dict) or not isinstance(report.get("run"), dict)):
        raise ValueError("请传入本节生成的 Trace JSON 文件。")
    print_report(report)
    return report


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    try:
        inspect_report(arguments[0] if arguments else None)
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
