"""业务问题 → 查询决策 → 真实 SQL 结果 → 解读；最多修正一次语法或字段错误。"""

import json
import sys
from datetime import datetime, timezone
from uuid import uuid4

from dataset import PROJECT_DIR, load_dataset, prepare_dataset
from model import create_ai_provider, parse_decision, utf16_length
from query_runner import execute_query
from replay import SCENARIOS, create_replay_provider


def answer_question(question, dataset, provider, execute=execute_query):
    if not isinstance(question, str) or not question.strip() or utf16_length(question) > 2000:
        raise ValueError("问题需要在 1 到 2000 字符之间。")
    # 同一份报告保存每轮 SQL、口径、范围、错误和真实结果，方便回查。
    context = dataset["context"]
    report = {"question": question, "mode": provider.mode,
              "datasetId": context["datasetId"], "version": context["version"], "attempts": []}
    previous_error = None
    for attempt in range(2):
        decision = parse_decision(provider.decide(question, context, previous_error))
        if decision["action"] == "clarify":
            return {**report, "status": "clarify", "answer": decision["question"]}
        record = {"decision": decision}
        report["attempts"].append(record)
        try:
            result = execute(dataset["databasePath"], decision["sql"])
        except Exception as error:
            record["error"] = str(error)
            # 只有首次遇到可修复错误才反馈上一轮 SQL，不重试权限或资源拒绝。
            if attempt == 0 and getattr(error, "repairable", False):
                previous_error = {"sql": decision["sql"], "error": str(error)}
                continue
            return {**report, "status": "failed", "answer": f"查询未完成：{error}"}

        report["result"] = result
        report["warning"] = "结果只代表已导入记录；日期覆盖范围不能证明月份完整，不外推完整月度业绩。"
        # 前 100 行不能代表全部数据；空结果也不能自动解释为销售额为零。
        if result["truncated"]:
            return {**report, "status": "needs_narrowing",
                    "answer": "结果超过 100 行，仅展示前 100 行。请增加筛选或聚合后重新提问，不据此概括全部结果。"}
        if not result["rows"]:
            return {**report, "status": "empty",
                    "answer": "没有查到符合条件的记录。请核对筛选条件和数据范围；空结果不代表销售额为 0。"}
        try:
            return {**report, "status": "answered",
                    "answer": provider.explain(question, context, decision, result)}
        except Exception as error:
            # SQL 已成功，模型解读失败也保留真实结果，不编造备用解释。
            return {**report, "status": "explanation_failed",
                    "answer": f"SQL 已完成，模型解读失败：{error}。请先核对下方真实结果。"}


def print_and_save(report):
    """终端与 JSON 记录使用同一份报告；时间戳和随机后缀避免覆盖历史查询。"""
    print(f"\n模式：{report['mode']}\n问题：{report['question']}")
    print(f"数据集：{report['datasetId']} / {report['version'][:12]}")
    for index, attempt in enumerate(report["attempts"], 1):
        decision = attempt["decision"]
        print(f"\n第 {index} 次查询\n口径：{decision['metric']}\n范围：{decision['scope']}\n\n{decision['sql']}")
        if attempt.get("error"):
            print(f"\n错误：{attempt['error']}")
    if "result" in report:
        print("\n数据库返回：")
        print(json.dumps(report["result"]["rows"], ensure_ascii=False, allow_nan=False, indent=2))
    print(f"\n状态：{report['status']}\n{report['answer']}")
    if report.get("warning"):
        print(f"\n注意：{report['warning']}")
    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z").replace(":", "-")
    output = PROJECT_DIR / "outputs" / f"{timestamp}-{str(uuid4())[:8]}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n本次记录：{output}")
    return output


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    command = args[0] if args else None
    rest = args[1:]
    if command == "prepare":
        dataset = prepare_dataset()
        print(f"数据已就绪：{dataset['databasePath']}\n销售明细：{dataset['context']['rowCount']} 条；商品：2 个\n表：sales、products")
        return 0
    if command not in {"demo", "ask"}:
        raise ValueError('用法：uv run python text_to_sql.py prepare / demo regions / ask "问题"')
    dataset = load_dataset()
    name = rest[0] if rest else "regions"
    provider = create_replay_provider(name) if command == "demo" else create_ai_provider()
    question = SCENARIOS[name]["question"] if command == "demo" else " ".join(rest)
    if command == "ask":
        print("即将发送问题、Schema、统计口径及必要的查询结果给 DeepSeek，会产生 API 费用。")
    report = answer_question(question, dataset, provider)
    print_and_save(report)
    return 1 if report["status"] in {"failed", "explanation_failed"} else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"\n执行失败：{error}", file=sys.stderr)
        sys.exit(1)
