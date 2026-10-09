"""固定数据版本、查询、核对依据、绘图和保存报告；不调用模型。"""

import argparse
import hashlib
import json
import math
import re
import shutil
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import uuid4


PROJECT_DIR = Path(__file__).resolve().parent
# 保留 Python 03、04、05、06 的相邻关系，不读取另一种语言的实现或输出。
for lesson in ("04-text-to-sql", "05-restricted-execution"):
    sys.path.insert(0, str(PROJECT_DIR.parent / lesson))
from dataset import load_dataset  # noqa: E402
from sandbox import run_sandbox  # noqa: E402
from report_view import create_chart_option, render_report  # noqa: E402


def create_queries(month="2026-09", region=None):
    """汇总与明细共用筛选条件，防止图表查九月、依据却查了全部月份。"""
    if not isinstance(month, str) or not re.fullmatch(r"20[0-9]{2}-(0[1-9]|1[0-2])", month):
        raise ValueError("月份请使用 YYYY-MM，例如 2026-09。")
    # 只开放固定区域选项，SQL 不直接拼接任意用户文本。
    if region is not None and region not in ("华东", "华南", "西北"):
        raise ValueError("区域可选：华东、华南、西北。")
    year, number = map(int, month.split("-"))
    start = f"{month}-01"
    end = date(year + (number == 12), number % 12 + 1, 1).isoformat()
    where = f"WHERE sold_at >= DATE '{start}'\n  AND sold_at < DATE '{end}'"
    if region is not None:
        where += f"\n  AND region = '{region}'"
    return {
        "filters": {"month": month, "start": start, "end": end, "region": region},
        "summary": f"SELECT region, SUM(paid_amount) AS sales_amount\nFROM sales\n{where}\nGROUP BY region\nORDER BY sales_amount DESC, region",
        "details": f"SELECT source_row, line_id, sold_at, region, paid_amount\nFROM sales\n{where}\nORDER BY source_row",
    }


def cents(value):
    """按整数分核对财务金额，显示图表时才转换浮点数。"""
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+\.[0-9]{2}", value):
        raise ValueError("金额必须是保留两位小数的非负字符串。")
    amount = int(value.replace(".", "", 1))
    # Python int 没有这个上限，仍保留原案例的绘图边界。
    if amount > 9007199254740991:
        raise ValueError("金额超出本例绘图范围。")
    return amount


def verify_evidence(rows, details):
    """每个汇总值都应由这次保留的明细重新算出，不接收不完整的依据。"""
    totals, ids = {}, set()
    for row in details:
        source_row = row.get("source_row")
        integer = (not isinstance(source_row, bool)
                   and (isinstance(source_row, int)
                        or (isinstance(source_row, float) and math.isfinite(source_row) and source_row.is_integer())))
        if (not integer or source_row < 1 or not isinstance(row.get("line_id"), str)
                or not row["line_id"] or row["line_id"] in ids):
            raise ValueError("依据缺少原始行号，或存在重复明细。")
        ids.add(row["line_id"])
        totals[row["region"]] = totals.get(row["region"], 0) + cents(row["paid_amount"])
    if len({row["region"] for row in rows}) != len(rows) or len(rows) != len(totals):
        raise ValueError("汇总结果和明细的区域不一致。")
    for row in rows:
        if totals.get(row["region"]) != cents(row["sales_amount"]):
            raise ValueError(f"{row['region']} 的明细合计与图表金额不一致，停止生成报告。")


def main(options=None):
    options = {} if options is None else options
    queries = create_queries(options.get("month", "2026-09"), options.get("region"))
    # 模型接入时也只能提出同样的有限配置，不能提供另一个金额或任意前端脚本。
    chart_spec = {"type": "bar", "x": "region", "y": options.get("y") if options.get("y") is not None else "sales_amount"}
    create_chart_option(chart_spec, [])

    dataset = load_dataset()
    directory = Path(dataset["databasePath"]).parent
    profile = json.loads((directory / "profile.json").read_text(encoding="utf-8"))
    if profile.get("sourceCopy") != "source.xlsx" or profile["importOptions"].get("sheet") != "销售明细":
        raise ValueError("本例需要 04 导入的 sales-clean.xlsx / 销售明细。")

    report_id = str(uuid4())
    output = PROJECT_DIR / "outputs" / report_id
    output.mkdir(parents=True, exist_ok=True)
    try:
        # 两次查询使用同一个快照，原文件随报告保留；不直接挂载或覆盖原始数据。
        shutil.copyfile(dataset["databasePath"], output / "data.duckdb")
        shutil.copyfile(directory / profile["sourceCopy"], output / "source.xlsx")
        source_hash = hashlib.sha256((output / "source.xlsx").read_bytes()).hexdigest()
        if source_hash != profile["sourceHash"]:
            raise ValueError("原文件副本与导入版本不一致。")
        database_hash = hashlib.sha256((output / "data.duckdb").read_bytes()).hexdigest()
        database_path = output / "data.duckdb"

        # 沿用 Python 05 的执行边界，不因 Docker 失败而回退为宿主查询。
        summary_run = run_sandbox({"kind": "sql", "sql": queries["summary"]}, database_path=database_path)
        if summary_run["status"] != "completed":
            raise RuntimeError(f"汇总查询失败：{summary_run.get('error')}")
        detail_run = run_sandbox({"kind": "sql", "sql": queries["details"]}, database_path=database_path)
        if detail_run["status"] != "completed":
            raise RuntimeError(f"明细查询失败：{detail_run.get('error')}")
        rows, details = summary_run["result"]["rows"], detail_run["result"]["rows"]
        verify_evidence(rows, details)

        report = {
            "reportId": report_id,
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "question": f"仅按已导入记录，{queries['filters']['month']} {options.get('region') or '各区域'}的未扣退款销售额是多少？",
            "dataset": {
                "datasetId": dataset["context"]["datasetId"], "version": dataset["context"]["version"],
                "sourceFile": profile["sourceFile"], "sheet": profile["importOptions"]["sheet"],
                "table": profile["tableName"], "sourceHash": source_hash, "databaseHash": database_hash,
                "importOptions": profile["importOptions"],
            },
            "metric": {"name": "未扣退款销售额", "expression": "SUM(paid_amount)", "unit": "元"},
            "filters": queries["filters"], "sql": queries["summary"], "detailSql": queries["details"],
            "chartSpec": chart_spec, "rows": rows, "details": details,
            "executions": {"summary": summary_run, "details": detail_run},
        }
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
        (output / "report.html").write_text(render_report(report), encoding="utf-8")
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        print(f"明细核对：通过，共 {len(details)} 条。")
        print(f"打开报告：{output / 'report.html'}\n完整依据：{output / 'report.json'}")
        return {"report": report, "output": str(output)}
    except Exception:
        # 失败不留下看似可用的半份报告，也不覆盖其他已经成功的报告。
        shutil.rmtree(output)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="生成有查询、明细和原文件依据的离线报告")
    parser.add_argument("--month", default="2026-09")
    parser.add_argument("--region")
    parser.add_argument("--y", default="sales_amount")
    try:
        main(vars(parser.parse_args()))
    except Exception as error:
        print(f"生成失败：{error}", file=sys.stderr)
        sys.exit(1)
