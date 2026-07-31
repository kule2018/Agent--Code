"""Runtime 已允许的工具执行入口。"""

from incident_data import INCIDENT

TOOL_REGISTRY = {
    "query_metrics": {
        "evidenceSource": "query_metrics",
        "execute": lambda: INCIDENT["metrics"],
    },
    "query_logs": {
        "evidenceSource": "query_logs",
        "execute": lambda: INCIDENT["logs"],
    },
    "get_recent_deployments": {
        "evidenceSource": "get_recent_deployments",
        "execute": lambda: INCIDENT["deployments"],
    },
}


async def execute_tool(action):
    """执行 Runtime 已经允许的一次 Action。"""

    tool = TOOL_REGISTRY.get(action["toolName"])

    if tool is None:
        raise ValueError(f"不存在工具 {action['toolName']}")

    service_name = action.get("arguments", {}).get("serviceName")

    if service_name != INCIDENT["serviceName"]:
        raise ValueError(f"没有找到服务 {service_name}")

    return {
        "ok": True,
        "source": tool["evidenceSource"],
        "evidenceKey": f"{tool['evidenceSource']}:{INCIDENT['serviceName']}",
        "data": tool["execute"](),
    }
