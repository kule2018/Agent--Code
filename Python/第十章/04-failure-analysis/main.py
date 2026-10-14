"""执行故障、修复或重复调用实验，保存独立历史和 latest.json。"""

from copy import deepcopy
import json
from pathlib import Path
import sys

from scoring import EvaluationService, RUBRIC_VERSION, load_case
from report import print_report
from trace_service import TraceService, timestamp
from traced_agent_service import TracedAgentService, VARIANTS
from traced_model_service import TracedModelService


OUTPUT_DIR = Path(__file__).resolve().parent / "outputs"


def run_experiment(variant="wrong-unit", *, model=None, trace=None, output_directory=OUTPUT_DIR):
    if variant not in VARIANTS:
        raise ValueError("实验名称应为 wrong-unit、fixed 或 repeat。")
    # 原例使用 Nest 独立应用来装配 Service，不启动 HTTP 服务。
    # Python 显式组合；测试注入本地模型服务、Trace 和临时输出目录。
    trace = TraceService() if trace is None else trace
    model = TracedModelService(trace) if model is None else model
    model.assert_configured()
    case = load_case()
    sample, fixture = case["sample"], case["fixture"]
    agent, evaluator = TracedAgentService(model, trace), EvaluationService(model)
    print("本次真实调用答题模型和评分模型，会产生 API 费用；故障由本例应用代码主动设置。")

    # 每次运行只用输入和订单副本答题；参考要求只在评分阶段使用。
    run = trace.capture("agent.run", "agent", {"inputs": sample["inputs"], "variant": variant},
                        lambda: agent.run(deepcopy(sample["inputs"]), deepcopy(fixture["orders"]), variant))
    evaluation = trace.capture("evaluation.run", "evaluation", {"sample": sample, "run": run},
                               lambda: evaluator.evaluate(sample, run))
    report = {"schemaVersion": 1, "createdAt": timestamp(), "caseId": sample["id"],
              "datasetVersion": case["datasetVersion"], "fixtureId": fixture["id"],
              "rubricVersion": RUBRIC_VERSION, "variant": variant, "models": model.settings(),
              "reference": sample["referenceOutputs"], "run": run, "evaluation": evaluation,
              **trace.snapshot()}
    output_directory = Path(output_directory)
    output_directory.mkdir(parents=True, exist_ok=True)
    contents = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)
    # 独立文件不被 latest 覆盖，之后可用 inspect_trace.py 重读某次历史。
    history = output_directory / f"{variant}-{trace.trace_id}.json"
    history.write_text(contents, encoding="utf-8")
    (output_directory / "latest.json").write_text(contents, encoding="utf-8")
    print_report(report)
    print(f"\n完整记录：outputs/{history.name}")
    # failed 是一次有效的未通过评测；仅技术性执行/评分错误使进程以 1 退出。
    return 1 if evaluation["status"] in ("agent_error", "evaluation_error") else 0


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    try:
        return run_experiment(arguments[0] if arguments else "wrong-unit")
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
