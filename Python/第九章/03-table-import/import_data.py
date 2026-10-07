"""命令入口：读取、整理、生成概览，再发布一个可复用的本地数据版本。"""

import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

import duckdb

from table_parser import (
    COLUMNS, PARSER_VERSION, build_profile, hash_value, inspect_source,
    normalize_rows, read_source, read_table,
)


PROJECT_DIR = Path(__file__).resolve().parent


def _json(value, *, pretty=False):
    # 紧凑 JSON 的字段顺序与原示例一致，是版本 Hash 的一部分。
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      indent=2 if pretty else None, separators=None if pretty else (",", ":"))


def save_database(database_path, table, normalized):
    """原始单元格、所有整理明细和问题清单分表保存，不静默丢弃问题行。"""
    connection = duckdb.connect(str(database_path))
    try:
        connection.execute("BEGIN TRANSACTION")
        connection.execute("CREATE TABLE sales_raw (source_row INTEGER, cells_json VARCHAR)")
        # 表名、字段名、类型来自课程固定 Schema；业务值全部参数绑定。
        fields = ", ".join(f"{column['name']} {column['type']}" for column in COLUMNS)
        connection.execute(f"CREATE TABLE sales (source_row INTEGER, {fields}, is_valid BOOLEAN)")
        connection.execute(
            "CREATE TABLE import_issues (source_row INTEGER, field VARCHAR, code VARCHAR, message VARCHAR)"
        )
        for row in table["rows"]:
            connection.execute("INSERT INTO sales_raw VALUES (?, ?)",
                               [row["sourceRow"], _json(row["cells"])])
        for row in normalized["rows"]:
            # 金额以十进制文本绑定，显式转为 DECIMAL(18,2)，不转成 Python float。
            connection.execute(
                """INSERT INTO sales VALUES (
                    ?, ?, ?, CAST(? AS DATE), ?, ?, ?,
                    CAST(? AS DECIMAL(18,2)), CAST(? AS DECIMAL(18,2)), ?, ?
                )""",
                [row["sourceRow"], *(row["values"][column["name"]] for column in COLUMNS), row["isValid"]],
            )
        for issue in normalized["issues"]:
            connection.execute("INSERT INTO import_issues VALUES (?, ?, ?, ?)",
                               [issue["sourceRow"], issue["field"], issue["code"], issue["message"]])
        # 三张表全部写入后统一提交；任一写入失败则回滚。
        connection.execute("COMMIT")
    except Exception:
        try:
            connection.execute("ROLLBACK")
        except duckdb.Error:
            pass
        raise
    finally:
        connection.close()


def save_dataset(source, table, normalized, profile, *, dataset_id="sales-demo", output_root=None):
    """文件内容与导入规则标识版本；重复导入复用，失败时不发布半成品。"""
    if not isinstance(dataset_id, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", dataset_id):
        raise ValueError("datasetId 只允许小写英文开头，包含小写英文、数字和短横线，最长 40 字符。")
    import_options = {"sheet": table["sheet"], "headerRow": table["headerRow"],
                      "delimiter": table["delimiter"], "parserVersion": PARSER_VERSION}
    version = hash_value(_json({"sourceHash": source["sha256"], **import_options}))
    root = Path(output_root if output_root is not None else PROJECT_DIR / "outputs").resolve() / dataset_id
    directory = root / version
    try:
        existing = json.loads((directory / "profile.json").read_text(encoding="utf-8"))
        if existing.get("version") != version:
            raise ValueError("已有版本元数据不一致。")
        # 与原示例一致：确认已有版本的数据库和原文件副本都仍然存在。
        (directory / "data.duckdb").stat()
        (directory / f"source{source['extension']}").stat()
        return {**existing, "directory": str(directory), "reused": True}
    except FileNotFoundError:
        pass

    root.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".import-", dir=root))
    saved = {
        "datasetId": dataset_id,
        "version": version,
        "sourceHash": source["sha256"],
        "sourceFile": Path(source["filePath"]).name,
        "sourceCopy": f"source{source['extension']}",
        "importOptions": import_options,
        "positionKind": table["positionKind"],
        "tableName": "sales",
        **profile,
    }
    try:
        # 原文件逐字节保存，数据与问题清单完成后才把临时目录发布为正式版本。
        (temporary / saved["sourceCopy"]).write_bytes(source["bytes"])
        save_database(temporary / "data.duckdb", table, normalized)
        (temporary / "profile.json").write_text(_json(saved, pretty=True) + "\n", encoding="utf-8")
        (temporary / "issues.json").write_text(_json(normalized["issues"], pretty=True) + "\n", encoding="utf-8")
        temporary.rename(directory)
    except Exception:
        shutil.rmtree(temporary)
        raise
    return {**saved, "directory": str(directory), "reused": False}


def print_result(result, issues):
    """打印概览、问题原行和实际落盘位置，提醒先核对再分析。"""
    print(f"\n数据集：{result['datasetId']}")
    reused = "，复用已有版本" if result["reused"] else ""
    print(f"版本：{result['version'][:12]}（完整版本见目录）{reused}")
    print(f"状态：{result['status']}")
    print(f"明细行数：{result['rowCount']}；通过本例规则：{result['validRowCount']}；问题条数：{result['issueCount']}")
    dates = result["dateRange"] or {"start": "无", "end": "无"}
    print(f"合法日期范围：{dates['start']} 至 {dates['end']}")
    print("\n字段 / 原表头 / 类型 / 空值：")
    for column in result["columns"]:
        print(f"{column['name']} / {column['header']} / {column['type']} / {column['nullCount']}")
    print("\n前三条整理结果：")
    print(_json(result["samples"], pretty=True))
    if issues:
        print(f"\n问题位置使用：{result['positionKind']}")
        for issue in issues:
            print(f"位置 {issue['sourceRow']} / {issue['field']} / {issue['message']}")
        print("完整数据已保存为待核对版本。请先处理问题，不要直接过滤问题行后汇总销售额。")
    print("输出目录：", result["directory"])


def main(argv=None):
    """从命令入口依次完成读取、字段整理、数据概览和持久化。"""
    parser = argparse.ArgumentParser(
        description="预览或导入课程销售表，完整保存原文件和数据质量问题。"
    )
    parser.add_argument("command", choices=("inspect", "import"))
    parser.add_argument("file", help="本地 .xlsx 或 UTF-8 CSV 文件")
    parser.add_argument("--sheet", help="Excel 工作表名称，CSV 不需要此项")
    parser.add_argument("--header-row", default="1", help="表头行，从 1 开始计数")
    parser.add_argument("--delimiter", default=",", help="逗号、分号或 tab")
    parser.add_argument("--dataset-id", default="sales-demo")
    args = parser.parse_args(argv)

    # 自定义文件路径相对执行目录；输出始终位于本 Python 小节，不依赖 cwd。
    source = read_source(Path(args.file).resolve())
    if args.command == "inspect":
        for item in inspect_source(source):
            print(f"\n工作表/文件：{item['sheet']}，范围：{item.get('range', '按 CSV 记录读取')}")
            for row in item["preview"]:
                print(_json(row))
        return

    # 先把 CLI 字符串转成表头行号；合法性仍由解析器统一检查。
    try:
        number = float(args.header_row)
        header_row = int(number) if number.is_integer() else number
    except (ValueError, OverflowError) as error:
        raise ValueError("headerRow 必须是从 1 开始的正整数。") from error
    table = read_table(source, sheet=args.sheet, header_row=header_row,
                       delimiter="\t" if args.delimiter == "tab" else args.delimiter)
    normalized = normalize_rows(table)
    profile = build_profile(table, normalized)
    result = save_dataset(source, table, normalized, profile, dataset_id=args.dataset_id)
    print_result(result, normalized["issues"])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, duckdb.Error) as error:
        print(f"\n导入失败：{error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n已取消。", file=sys.stderr)
        sys.exit(130)
