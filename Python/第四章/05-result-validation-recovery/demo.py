"""结果校验与失败恢复实验入口。"""

import asyncio
import json
import sys

from recovery_runtime import run_recovery_agent

# 实验场景列表
# - replan：工具调用成功，但返回空结果，触发重新规划
# - handoff：不同数据源返回的有效证据相互冲突，触发人工接管
# - retry-fallback：工具调用超时，先重试，仍失败则切换备用方案
SCENARIOS = ["replan", "handoff", "retry-fallback"]


async def main():
    selected_scenario = sys.argv[1] if len(sys.argv) > 1 else None
    scenarios = [selected_scenario] if selected_scenario else SCENARIOS

    for scenario_name in scenarios:
        if scenario_name not in SCENARIOS:
            raise ValueError(f"未知实验 {scenario_name}，可选值：{'、'.join(SCENARIOS)}")

        print(f"\n\n================ {get_title(scenario_name)} ================")
        # 运行恢复代理
        state = await run_recovery_agent(scenario_name=scenario_name)
        print_summary(state)


def print_summary(state):
    print("\nRun 结束：")
    print(f"status = {state['status']}")
    print(f"stopReason = {state['stopReason']['code']}")
    print(
        f"recoveryStrategies = {json.dumps([item['strategy'] for item in state['recoveryEvents']], ensure_ascii=False)}"
    )
    print(f"planVersion = {state['planState']['version']}")
    print(
        f"planSteps = {json.dumps([{ 'id': step['id'], 'status': step['status'], 'toolName': step['action']['toolName'], 'resolvedBy': step.get('resolvedBy') or None } for step in state['planState']['steps']], ensure_ascii=False)}"
    )
    print(f"usage = {json.dumps(state['usage'], ensure_ascii=False)}")

    if state["handoff"]:
        print("handoff =")
        print(json.dumps(state["handoff"], ensure_ascii=False, indent=2))


def get_title(scenario_name):
    titles = {
        "replan": "实验一：空结果被校验器拒绝",
        "handoff": "实验二：证据冲突后暂停运行",
        "retry-fallback": "实验三：工具异常后的 Retry 与 Fallback",
    }

    return titles[scenario_name]


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print(f"\n运行失败：{error}", file=sys.stderr)
        sys.exit(1)
