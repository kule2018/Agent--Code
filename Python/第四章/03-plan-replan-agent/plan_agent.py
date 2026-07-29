"""具备显式计划和重新规划能力的故障排查 Agent。"""

import inspect
import json

from deepseek_client import MODEL, call_deepseek
from plan_state import (
    apply_replan,
    complete_step,
    create_plan_state,
    get_completed_evidence,
    get_next_ready_step,
    start_step,
)
from planner import create_initial_plan, replan

MAX_EXECUTED_STEPS = 6


async def run_plan_agent(
    *,
    goal,
    alert_context,
    completion_criteria,
    tool_catalog,
    execute_tool,
    create_initial_plan_fn=None,
    replan_fn=None,
    generate_final_answer_fn=None,
):
    """运行具备显式计划和重新规划能力的故障排查 Agent。"""

    create_initial_plan_fn = create_initial_plan_fn or create_initial_plan
    replan_fn = replan_fn or replan
    generate_final_answer_fn = generate_final_answer_fn or generate_final_answer

    print(f"模型：{MODEL}")
    print(f"目标：{goal}")
    print(f"初始告警：{alert_context['summary']}")

    # 创建初始计划和状态
    initial_result = create_initial_plan_fn(
        goal=goal,
        alert_context=alert_context,
        completion_criteria=completion_criteria,
        tool_catalog=tool_catalog,
    )
    if inspect.isawaitable(initial_result):
        initial_result = await initial_result

    # 创建应用程序持有的 Plan State
    state = create_plan_state(goal, completion_criteria, initial_result["plan"])

    print(f"\nPlanner：{initial_result['latencyMs']}ms")
    print_plan(state)

    # 运行循环，直到满足完成条件或达到最大执行次数
    executed_steps = 0

    # 循环执行计划步骤，直到满足完成条件或达到最大执行次数
    while state["status"] == "active":
        if executed_steps >= MAX_EXECUTED_STEPS:
            raise RuntimeError(f"达到最大工具执行次数 {MAX_EXECUTED_STEPS}，任务仍未满足结束条件。")

        # 找到当前依赖已经完成的第一个待执行步骤
        next_step = get_next_ready_step(state)

        if next_step is None:
            raise RuntimeError("当前仍有未完成任务，但没有依赖已满足的可执行步骤。")

        # 把计划步骤标记为执行中
        start_step(state, next_step["id"])

        print(f"\n================ 执行 {next_step['id']} ================")
        print(f"目标：{next_step['title']}")
        print(f"工具：{next_step['toolName']}")

        # 执行工具，获取 Observation
        observation = execute_tool(next_step["toolName"], next_step["arguments"])
        if inspect.isawaitable(observation):
            observation = await observation

        # 把计划步骤标记为已完成，并记录 Observation
        complete_step(state, next_step["id"], observation)
        executed_steps += 1

        print("Observation：")
        print(json.dumps(observation, ensure_ascii=False, indent=2))

        # 根据最新 Observation 重新检查计划
        replan_result = replan_fn(state=state, tool_catalog=tool_catalog)
        if inspect.isawaitable(replan_result):
            replan_result = await replan_result

        print(f"\nReplanner：{replan_result['latencyMs']}ms")
        print(f"决定：{replan_result['decision']['decision']}")
        print(f"原因：{replan_result['decision']['reason']}")

        # 根据 Replanner 的决定更新计划状态
        apply_replan(state, replan_result["decision"])
        print_plan(state)

    # 使用已完成步骤的 Observation 生成最终结论
    final_answer = generate_final_answer_fn(
        goal=goal,
        evidence=get_completed_evidence(state),
    )
    if inspect.isawaitable(final_answer):
        final_answer = await final_answer

    state["status"] = "completed"

    print("\n================ 最终结论 ================")
    print(final_answer)

    return {
        "finalAnswer": final_answer,
        "state": state,
    }


async def generate_final_answer(*, goal, evidence, call_model=None):
    """只使用已完成步骤的 Observation 生成最终结论。"""

    call_model = call_model or call_deepseek

    result = call_model(
        messages=[
            {
                "role": "system",
                "content": "你是线上故障排查 Agent。\n只能根据应用程序提供的已完成步骤和 Observation 生成结论。\n回答必须包含：最可能原因、关键证据、建议动作和仍未确认的信息。\n当前没有写操作工具，不得声称已经回滚、重启或修复。",
            },
            {
                "role": "user",
                "content": f"""用户目标：
{goal}

已完成步骤与证据：
{json.dumps(evidence, ensure_ascii=False, indent=2)}""",
            },
        ],
        max_tokens=1600,
    )
    if inspect.isawaitable(result):
        result = await result

    return result["message"].get("content")


def print_plan(state):
    """打印当前计划，让每次 Replan 的变化可以直接被观察。"""

    print(f"\nPlan v{state['version']}：{state['planSummary']}")

    if state["version"] == 1:
        print("完成条件：")

        for criterion in state["completionCriteria"]:
            print(f"- {criterion}")

    for step in state["steps"]:
        print(f"[{step['status'].ljust(9)}] {step['id']} {step['title']} -> {step['toolName']}")
