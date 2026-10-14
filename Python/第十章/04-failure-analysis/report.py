"""打印评分依据与输入变化，分别汇总 Agent / Judge 用量，不自动推断所有根因。"""

import json

from trace_service import round_ms


def summarize(spans, role):
    """usage 缺失时保留未知；未发生模型调用，才显示零调用和零 Token。"""
    models = [span for span in spans if span["name"] == f"{role}.model"]
    usages = [(span.get("output") or {}).get("usage") for span in models]
    keys = ("prompt_tokens", "completion_tokens", "total_tokens")
    # 不能把 bool 当数字；只要有一条 usage 不完整，各 Token 总数均保留 null。
    missing = sum(not isinstance(usage, dict) or any(type(usage.get(key)) not in (int, float) for key in keys)
                  for usage in usages)
    totals = {key: None if missing else sum(usage[key] for usage in usages) for key in keys}
    return {"modelCalls": len(models), "modelMs": int(round_ms(sum(span["durationMs"] for span in models), 0)),
            "inputTokens": totals["prompt_tokens"], "outputTokens": totals["completion_tokens"],
            "totalTokens": totals["total_tokens"], "missingUsageCalls": missing}


def print_report(report):
    print(f"样本：{report['caseId']}；实验：{report['variant']}")
    print(f"Trace ID：{report['traceId']}")
    print(f"回答：{report['run']['answer'] or '未产生回答'}")
    print(f"评测结果：{report['evaluation']['status']}")
    for rule in report["evaluation"]["rules"]:
        print(f"  {rule['name']}：{'通过' if rule['passed'] else '未通过'}；{rule['reason']}")
    judge = report["evaluation"]["judge"]
    print("评分依据：", json.dumps(judge["result"], ensure_ascii=False)
          if judge["status"] == "completed" else judge["reason"])
    print("\n按开始时间查看执行步骤（父步骤耗时包含子步骤，不能再次相加）：")
    spans = report["spans"]
    steps = {span["id"]: index + 1 for index, span in enumerate(spans)}
    for index, span in enumerate(spans):
        parent = steps.get(span["parentId"], 0) if span["parentId"] else "-"
        print(f"  {index + 1}. {span['name']}；父步骤 {parent}；{span['status']}；{span['durationMs']} ms")
    for span in spans:
        if span["kind"] in ("tool", "transform"):
            label = "工具输入与实际返回：" if span["kind"] == "tool" else "组装 Tool Message 前后："
            values = {key: span[key] for key in ("input", "output") if key in span}
            print("\n" + label, json.dumps(values, ensure_ascii=False, indent=2))
        if span["name"] == "agent.model":
            print("\n本次答题模型实际收到的 messages：",
                  json.dumps(span["input"]["messages"], ensure_ascii=False, indent=2))
        if span["status"] == "error":
            print(f"异常步骤 {span['name']}：{span['error']}")
    print("\n模型用量（null 表示未知，不是零）：")
    for role, label in (("agent", "Agent"), ("judge", "Judge")):
        print(json.dumps({"role": label, **summarize(spans, role)}, ensure_ascii=False))
