"""计划步骤可执行的故障排查工具。"""

from incident_data import INCIDENT

TOOL_CATALOG = [
    {
        "name": "query_metrics",
        "description": "查询错误率、延迟、CPU、内存和数据库连接池使用率。适合先判断异常集中在哪个方向。",
    },
    {
        "name": "inspect_database_pool",
        "description": "检查数据库连接池的活跃连接、等待请求和获取连接延迟。只有证据仍然指向数据库时使用。",
    },
    {
        "name": "query_logs",
        "description": "查询主要错误、首次出现时间和服务版本。适合在指标不能解释故障时继续定位错误来源。",
    },
    {
        "name": "get_recent_deployments",
        "description": "查询最近发布的版本、完成时间和变更内容。只有日志或时间线指向版本变化时使用。",
    },
]

TOOL_REGISTRY = {
    "query_metrics": lambda: INCIDENT["metrics"],
    "inspect_database_pool": lambda: INCIDENT["databasePool"],
    "query_logs": lambda: INCIDENT["logs"],
    "get_recent_deployments": lambda: INCIDENT["deployments"],
}


async def execute_tool(tool_name, raw_arguments):
    """执行计划步骤中声明的工具。"""

    execute = TOOL_REGISTRY.get(tool_name)

    if execute is None:
        raise ValueError(f"不存在工具 {tool_name}")

    service_name = validate_service_arguments(raw_arguments, tool_name)

    if service_name != INCIDENT["serviceName"]:
        raise ValueError(f"没有找到服务 {service_name}")

    return {
        "ok": True,
        "source": tool_name,
        "data": execute(),
    }


def validate_service_arguments(raw_arguments, tool_name):
    """校验工具参数。

    Node 版使用 Zod。Python 版为了保持课程轻量，直接实现本节需要的
    serviceName 校验，不额外引入 JSON Schema 依赖。
    """

    if not isinstance(raw_arguments, dict):
        raise ValueError(f"工具 {tool_name} 的参数没有通过校验。")

    service_name = raw_arguments.get("serviceName")

    if not isinstance(service_name, str) or len(service_name) < 1:
        raise ValueError(f"工具 {tool_name} 的参数没有通过校验。")

    return service_name


def has_tool(tool_name):
    """判断 Planner 返回的工具是否属于当前允许范围。"""

    return tool_name in TOOL_REGISTRY
