"""故障排查工具定义和执行器。"""

import json

from incident_data import get_incident_scenario

SERVICE_PARAMETERS = {
    "type": "object",
    "properties": {
        "serviceName": {
            "type": "string",
            "minLength": 1,
            "description": "需要排查的服务名称",
        }
    },
    "required": ["serviceName"],
    "additionalProperties": False,
}

# 提供给模型的只读故障排查工具。
#
# 本节没有提供重启和回滚工具，避免把人工确认和风险控制
# 提前塞进最小 ReAct 案例。
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_service_health",
            "description": "查询服务是否存活、实例健康数量和当前 5xx 错误率。开始排查线上服务异常时使用。",
            "parameters": SERVICE_PARAMETERS,
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_metrics",
            "description": "查询故障时间段内的错误率、延迟、CPU、内存和数据库连接池使用率，用来确定异常从什么时候开始以及哪些指标同时变化。",
            "parameters": SERVICE_PARAMETERS,
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_logs",
            "description": "查询故障时间段内的主要错误日志、首次出现时间、错误次数和服务版本。",
            "parameters": SERVICE_PARAMETERS,
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_recent_deployments",
            "description": "查询服务最近的版本发布时间和主要变更。只有指标或日志显示异常可能与版本变化有关时使用。",
            "parameters": SERVICE_PARAMETERS,
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inspect_database_pool",
            "description": "检查数据库连接池的活跃连接、等待请求和长时间运行的查询。只有指标或日志出现连接池异常时使用。",
            "parameters": SERVICE_PARAMETERS,
        },
    },
]


def create_incident_toolset(scenario_name):
    """为当前故障场景创建工具执行器。"""

    scenario = get_incident_scenario(scenario_name)

    tool_registry = {
        "get_service_health": lambda: scenario["health"],
        "query_metrics": lambda: scenario["metrics"],
        "query_logs": lambda: scenario["logs"],
        "get_recent_deployments": lambda: scenario["deployments"],
        "inspect_database_pool": lambda: scenario["databasePool"],
    }

    async def execute_tool_call(tool_call):
        """执行模型提出的一次 Action，并返回 Observation。"""

        function = tool_call.get("function", {})
        tool_name = function.get("name")
        execute = tool_registry.get(tool_name)

        if execute is None:
            return create_error("TOOL_NOT_FOUND", f"不存在工具 {tool_name}")

        try:
            raw_arguments = json.loads(function.get("arguments") or "{}")
        except json.JSONDecodeError:
            return create_error("INVALID_JSON_ARGUMENTS", "工具参数不是合法 JSON。")

        parsed_arguments, issues = validate_service_arguments(raw_arguments)

        if issues:
            return create_error("INVALID_TOOL_ARGUMENTS", "工具参数没有通过校验。", issues)

        if parsed_arguments["serviceName"] != scenario["serviceName"]:
            return create_error(
                "SERVICE_NOT_FOUND",
                f"没有找到服务 {parsed_arguments['serviceName']}",
            )

        return {
            "ok": True,
            "source": tool_name,
            "data": execute(),
        }

    return {
        "tools": TOOLS,
        "scenario": scenario,
        "executeToolCall": execute_tool_call,
    }


def validate_service_arguments(raw_arguments):
    """校验工具参数。

    Node 版使用 Zod。Python 版没有引入额外依赖，直接保留本节需要的
    serviceName 校验规则：必须是非空字符串。
    """

    issues = []

    if not isinstance(raw_arguments, dict):
        issues.append(
            {
                "code": "invalid_type",
                "path": [],
                "message": "工具参数必须是对象。",
            }
        )
        return {}, issues

    service_name = raw_arguments.get("serviceName")

    if not isinstance(service_name, str):
        issues.append(
            {
                "code": "invalid_type",
                "path": ["serviceName"],
                "message": "serviceName 必须是字符串。",
            }
        )
    elif len(service_name) < 1:
        issues.append(
            {
                "code": "too_small",
                "path": ["serviceName"],
                "message": "serviceName 不能为空。",
            }
        )

    return {"serviceName": service_name}, issues


def create_error(code, message, issues=None):
    """创建统一的工具错误 Observation。"""

    error = {
        "code": code,
        "message": message,
    }

    if issues is not None:
        error["issues"] = issues

    return {
        "ok": False,
        "error": error,
    }
