"""本节使用的 Agent Run State。"""

import uuid


def create_recovery_state(scenario_name):
    """创建本节使用的 Agent Run State。"""

    return {
        "runId": str(uuid.uuid4()),
        "scenarioName": scenario_name,
        "status": "running",
        "stopReason": None,
        "planState": create_plan_state(scenario_name),
        "observations": [],
        "recoveryEvents": [],
        "usage": {
            "toolAttempts": 0,
            "toolResponses": 0,
            "validatedObservations": 0,
        },
        "handoff": None,
        "trace": [],
    }


def create_plan_state(scenario_name):
    service_arguments = {"serviceName": "payment-service"}

    if scenario_name == "retry-fallback":
        return {
            "version": 1,
            "status": "active",
            "steps": [
                {
                    "id": "collect-logs",
                    "title": "收集错误日志",
                    "status": "pending",
                    "action": {
                        "toolName": "query_primary_logs",
                        "arguments": service_arguments,
                        "recovery": {
                            "maxRetries": 1,
                            "retryDelayMs": 20,
                            "fallbackAction": {
                                "toolName": "query_backup_logs",
                                "arguments": service_arguments,
                            },
                        },
                    },
                }
            ],
        }

    if scenario_name == "replan":
        return {
            "version": 1,
            "status": "active",
            "steps": [
                {
                    "id": "locate-failure",
                    "title": "从日志中定位直接故障",
                    "status": "pending",
                    "action": {
                        "toolName": "query_primary_logs",
                        "arguments": service_arguments,
                        "recovery": {
                            "replanTitle": "改用调用链追踪定位失败节点",
                            "replanAction": {
                                "toolName": "query_traces",
                                "arguments": service_arguments,
                            },
                        },
                    },
                }
            ],
        }

    if scenario_name == "handoff":
        return {
            "version": 1,
            "status": "active",
            "steps": [
                {
                    "id": "collect-logs",
                    "title": "查询报错实例的日志版本",
                    "status": "pending",
                    "action": {
                        "toolName": "query_primary_logs",
                        "arguments": service_arguments,
                    },
                },
                {
                    "id": "check-inventory",
                    "title": "查询服务实例的当前版本",
                    "status": "pending",
                    "action": {
                        "toolName": "query_instance_inventory",
                        "arguments": service_arguments,
                    },
                },
            ],
        }

    raise ValueError(f"不存在实验 {scenario_name}")
