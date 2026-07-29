"""启动故障排查 Agent。"""

import asyncio
import sys

from incident_data import INCIDENT
from incident_tools import TOOL_CATALOG, execute_tool
from plan_agent import run_plan_agent

# 任务目标
GOAL = "排查 payment-service 从 15:10 开始出现的大量支付失败，找出最可能原因并给出处理建议。不要执行重启或回滚。"

# 完成条件
COMPLETION_CRITERIA = [
    "通过监控数据确认故障现象和异常时间",
    "通过错误日志找到直接故障表现",
    "使用另一份独立系统数据验证最可能的故障原因",
]


async def main():
    """run_plan_agent 会完成计划、执行、重规划和最终回答生成。"""

    await run_plan_agent(
        # Agent 最终需要完成的任务。
        goal=GOAL,
        # 当前事故的告警上下文，为 Agent 提供初始故障信息。
        alert_context=INCIDENT["alertContext"],
        # 判断任务是否完成的验收条件。
        completion_criteria=COMPLETION_CRITERIA,
        # Agent 可以发现和选择的工具定义。
        tool_catalog=TOOL_CATALOG,
        # 工具的统一执行入口。
        execute_tool=execute_tool,
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print(f"\n运行失败：{error}", file=sys.stderr)
        sys.exit(1)
