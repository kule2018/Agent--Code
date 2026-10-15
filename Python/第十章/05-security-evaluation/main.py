"""按分组运行安全样本、保存会话快照与评分，任一未通过即返回退出码 1。"""

from copy import deepcopy
from pathlib import Path
import sys
from uuid import uuid4

from agent_service import AgentService
from cases import DATASET_VERSION, select_cases
from contracts import json_text, utc_now
from evaluation_service import EvaluationService
from model_service import ModelService
from tools_service import ToolsService, prepare


OUTPUT_DIR = Path(__file__).resolve().parent / "outputs"


def run_batch(group="injection", *, model=None, output_directory=OUTPUT_DIR):
    samples = select_cases(group)
    # 原例是 Nest 独立 CLI，不提供 Web 接口；Python 直接组合各个 Service。
    model = ModelService() if model is None else model
    model.assert_configured()
    agent, evaluator = AgentService(model, ToolsService()), EvaluationService(model)
    print("将调用真实答题模型与评分模型，会产生 API 费用。订单、记忆和退款全部为测试数据。")
    report_id, reports = str(uuid4()), []
    for sample in samples:
        print(f"\n{sample['name']}（{sample['id']}）")
        # 不同样本隔离；同一样本的两个新会话共享 world，只通过长期记忆传递偏好。
        world = prepare(sample)
        before, turns = deepcopy(world), []
        for index, question in enumerate(sample["turns"]):
            thread_id = f"{report_id}:{sample['id']}:thread-{index + 1}"
            print(f"\n新会话 {index + 1}：{question}")
            turn = agent.run_turn(world, question, thread_id)
            turns.append(turn)
            print("本次召回：", json_text(turn["recalledMemories"]))
            for call in turn["toolCalls"]:
                print(f"{call['name']}({json_text(call['arguments'])}) → {call['result']['code']}")
            print("回答：", turn["answer"] or turn.get("error"))
            print("当前记忆：", json_text(world["memories"]))
            print("实际退款记录数：", len(world["refunds"]))
            if turn["status"] == "error":
                break
        evaluation = evaluator.evaluate(sample, before, turns)
        for check in evaluation["checks"]:
            print(f"  {check['name']}；{'安全' if check['kind'] == 'safety' else '任务'}；{'通过' if check['passed'] else '未通过'}")
        judge = evaluation["judge"]
        if judge["status"] == "completed":
            print("回答评审：", "通过" if judge["result"]["passed"] else "未通过", judge["result"]["reason"])
        else:
            print("回答评审：", judge["reason"])
        print("本条样本最终结果：", evaluation["status"])
        reports.append({"sample": sample, "before": before, "turns": turns, "evaluation": evaluation})

    output_directory = Path(output_directory)
    output_directory.mkdir(parents=True, exist_ok=True)
    output = output_directory / f"{report_id}.json"
    report = {"reportId": report_id, "createdAt": utc_now(), "datasetVersion": DATASET_VERSION,
              "models": model.settings(), "reports": reports}
    output.write_text(json_text(report, indent=2), encoding="utf-8")
    print(f"\n完整输入、工具结果、会话快照与评分已保存：{output.resolve()}")
    passed = sum(item["evaluation"]["status"] == "passed" for item in reports)
    print(f"样本通过：{passed}/{len(reports)}。仅代表本次所运行样本。")
    return 1 if any(item["evaluation"]["status"] != "passed" for item in reports) else 0


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    try:
        return run_batch(arguments[0] if arguments and arguments[0] else "injection")
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
