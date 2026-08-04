"""按实验场景创建工具执行器。"""

from incident_data import INCIDENT


class ToolExecutionError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.name = "ToolExecutionError"
        self.code = code
        self.details = details or {}


def create_tool_executor(scenario_name):
    """为指定实验创建工具执行器。

    工具行为由场景固定，方便所有同学稳定复现超时、空结果和证据冲突。
    """

    attempts = {}

    async def execute_tool(action):
        attempt = attempts.get(action["toolName"], 0) + 1
        attempts[action["toolName"]] = attempt

        if action["arguments"]["serviceName"] != INCIDENT["serviceName"]:
            raise ToolExecutionError(
                "INVALID_ARGUMENT",
                f"没有找到服务 {action['arguments']['serviceName']}",
            )

        if action["toolName"] == "query_primary_logs":
            return query_primary_logs(scenario_name, attempt)
        if action["toolName"] == "query_backup_logs":
            return query_backup_logs()
        if action["toolName"] == "query_traces":
            return query_traces()
        if action["toolName"] == "query_instance_inventory":
            return query_instance_inventory()

        raise ToolExecutionError("TOOL_NOT_FOUND", f"不存在工具 {action['toolName']}")

    return execute_tool


def query_primary_logs(scenario_name, attempt):
    if scenario_name == "retry-fallback":
        raise ToolExecutionError(
            "UPSTREAM_TIMEOUT",
            f"主日志服务第 {attempt} 次请求超时。",
            {"retryable": True},
        )

    if scenario_name == "replan":
        return create_observation(
            "primary_logs",
            {
                "records": [],
                "summary": "主日志服务请求成功，但目标时间段内没有查到匹配记录。",
            },
        )

    return create_observation(
        "primary_logs",
        {
            "records": [INCIDENT["primaryLogs"]],
            "runtimeVersion": INCIDENT["primaryLogs"]["runtimeVersion"],
            "summary": "日志显示报错实例运行 v2.4.1，错误码为 PAYMENT_CURRENCY_UNDEFINED。",
        },
    )


def query_backup_logs():
    return create_observation(
        "backup_logs",
        {
            "records": [INCIDENT["primaryLogs"]],
            "runtimeVersion": INCIDENT["primaryLogs"]["runtimeVersion"],
            "summary": "备用日志索引找到报错记录，运行版本为 v2.4.1。",
        },
    )


def query_traces():
    return create_observation(
        "traces",
        {
            "records": [INCIDENT["traceEvidence"]],
            "summary": "调用链追踪显示 normalizeCurrency 是第一个失败节点。",
        },
    )


def query_instance_inventory():
    return create_observation(
        "instance_inventory",
        {
            "records": [INCIDENT["inventory"]],
            "activeVersion": INCIDENT["inventory"]["activeVersion"],
            "summary": "实例清单显示 payment-service 当前运行版本为 v2.4.0。",
        },
    )


def create_observation(source, data):
    return {
        "ok": True,
        "source": source,
        "evidenceKey": f"{source}:{INCIDENT['serviceName']}",
        "data": data,
    }
