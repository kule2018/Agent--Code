"""Agent Runtime 实验入口。"""

import asyncio
import json
import sys

from agent_runtime import run_agent
from incident_tools import execute_tool
from runtime_state import create_run_state
from scripted_decision_provider import create_decision_provider

GOAL = "排查 payment-service 的大量支付失败，找出最可能原因并给出处理建议。"

SCENARIOS = ["complete", "repeat", "no-progress", "budget"]


async def main():
    """程序入口。

    不传入命令行参数时，按照 SCENARIOS 中定义的顺序运行全部实验；
    传入实验名称时，只运行指定的实验。
    """

    # 读取第三个命令行参数作为本次需要运行的实验名称。
    # 例如：python3 demo.py complete
    selected_scenario = sys.argv[1] if len(sys.argv) > 1 else None

    # 如果指定了实验名称，就只运行这一组；
    # 否则运行 SCENARIOS 中定义的全部实验。
    scenarios = [selected_scenario] if selected_scenario else SCENARIOS

    # 依次执行本次选中的实验。
    for scenario_name in scenarios:
        # 在运行前检查实验名称是否合法，避免执行不存在的场景。
        if scenario_name not in SCENARIOS:
            raise ValueError(f"未知实验 {scenario_name}，可选值：{'、'.join(SCENARIOS)}")

        # 等待当前实验执行完成，再继续运行下一组实验。
        await run_scenario(scenario_name)


async def run_scenario(scenario_name):
    """创建 Agent Run State，并运行指定的实验场景。"""

    # 输出当前实验的标题，用于区分不同场景的运行结果。
    print(f"\n\n================ {get_scenario_title(scenario_name)} ================")

    # 创建本次实验对应的 Agent Run State。
    state = create_run_state(
        # 参数一：设置本次 Agent 需要完成的目标。
        goal=GOAL,
        # 参数二：创建并写入初始任务计划状态。
        plan_state=create_plan_state(),
        # 参数三：为不同实验配置对应的执行预算。
        limits={
            # budget 场景最多只允许调用两次工具，
            # 用于验证工具调用预算耗尽后的终止逻辑。
            "maxToolCalls": 2,
        }
        if scenario_name == "budget"
        else {},
    )

    # 打印本次运行的唯一标识。
    print(f"runId：{state['runId']}")

    # 打印本次运行实际采用的执行预算。
    print("执行预算：")
    print(json.dumps(state["limits"], ensure_ascii=False, indent=2))

    # 启动 Agent Runtime，并等待本次实验运行结束。
    final_state = await run_agent(
        # 传入已经初始化完成的运行状态。
        state=state,
        # 创建当前场景对应的确定性决策器，
        # 用预设结果模拟模型每一轮返回的决定。
        decide_next_action=create_decision_provider(scenario_name),
        # 传入真实的工具执行函数。
        execute_tool=execute_tool,
    )

    # 输出 Agent 终止后的状态摘要，包括停止原因和资源消耗等信息。
    print_run_summary(final_state)


def create_plan_state():
    """创建一份初始的 Plan State。

    该计划把故障排查目标拆分为三个步骤，
    每个步骤都要求从指定工具中获得对应证据。
    """

    return {
        # 当前计划的版本号，重新规划时可以递增。
        "version": 1,
        # 当前计划的整体状态。
        "status": "active",
        # 本次任务需要依次完成的计划步骤。
        "steps": [
            {
                # 当前步骤的唯一标识。
                "id": "step-1",
                # 当前步骤需要完成的任务。
                "title": "确认故障现象",
                # 完成该步骤所需证据的来源。
                # 只有 query_metrics 返回有效证据后，该步骤才能完成。
                "requiredEvidenceSource": "query_metrics",
                # 当前步骤尚未执行完成。
                "status": "pending",
            },
            {
                # 当前步骤的唯一标识。
                "id": "step-2",
                # 通过日志找到故障的直接错误表现。
                "title": "找到直接错误",
                # 该步骤要求从日志查询工具中获得证据。
                "requiredEvidenceSource": "query_logs",
                # 当前步骤尚未执行完成。
                "status": "pending",
            },
            {
                # 当前步骤的唯一标识。
                "id": "step-3",
                # 使用独立系统数据验证最可能的故障原因。
                "title": "验证故障原因",
                # 该步骤要求从最近发布记录中获得证据。
                "requiredEvidenceSource": "get_recent_deployments",
                # 当前步骤尚未执行完成。
                "status": "pending",
            },
        ],
    }


def print_run_summary(state):
    print("\nRun 结束：")
    print(f"status = {state['status']}")
    print(f"stopReason = {state['stopReason']['code']}")
    print(f"message = {state['stopReason']['message']}")
    print(
        f"usage = {json.dumps({ 'steps': state['usage']['steps'], 'modelCalls': state['usage']['modelCalls'], 'toolCalls': state['usage']['toolCalls'], 'totalTokens': state['usage']['totalTokens'] }, ensure_ascii=False)}"
    )
    print(f"evidenceSources = {json.dumps(state['progress']['evidenceSources'], ensure_ascii=False)}")

    if state["finalAnswer"]:
        print(f"finalAnswer = {state['finalAnswer']}")


def get_scenario_title(scenario_name):
    titles = {
        "complete": "实验一：满足完成条件",
        "repeat": "实验二：重复 Action",
        "no-progress": "实验三：连续没有新进展",
        "budget": "实验四：工具调用预算耗尽",
    }

    return titles[scenario_name]


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print(f"\n运行失败：{error}", file=sys.stderr)
        sys.exit(1)
