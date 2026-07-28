"""启动当前故障场景。"""

import asyncio
import sys

from incident_tools import create_incident_toolset
from react_agent import run_react_agent

SCENARIO_NAME = sys.argv[1] if len(sys.argv) > 1 else "release-regression"

GOAL = "payment-service 从 15:10 开始出现大量支付失败。请根据服务状态、监控、日志以及必要的关联信息，找出最可能的故障原因并给出处理建议。不要执行重启或回滚。"


async def main():
    """场景名称只用于切换本地模拟数据，不会把预设的故障原因直接告诉模型。"""

    toolset = create_incident_toolset(SCENARIO_NAME)

    print(f"本地故障场景：{toolset['scenario']['label']}")

    await run_react_agent(
        goal=GOAL,
        tools=toolset["tools"],
        execute_tool_call=toolset["executeToolCall"],
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print(f"\n运行失败：{error}", file=sys.stderr)
        sys.exit(1)
