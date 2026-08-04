"""失败恢复策略选择。"""

import copy


def select_recovery(*, failure, action, retry_count):
    """根据失败类型和当前执行语境选择恢复策略。

    这些分类和路由是当前教学项目定义的工程规则，
    并不是某个 Agent 协议规定的固定枚举。
    """

    recovery = action.get("recovery") if action else {}
    recovery = recovery or {}

    if (
        failure["kind"] == "transient_error"
        and retry_count < (recovery.get("maxRetries") or 0)
    ):
        return {
            "strategy": "retry",
            "delayMs": calculate_backoff_ms(recovery.get("retryDelayMs") or 20, retry_count),
        }

    if failure["kind"] == "transient_error" and recovery.get("fallbackAction"):
        return {
            "strategy": "fallback",
            "nextAction": clone(recovery["fallbackAction"]),
        }

    if failure["kind"] == "no_evidence" and recovery.get("replanAction"):
        return {
            "strategy": "replan",
            "replacementStep": {
                "id": f"{action['toolName']}-replacement",
                "title": recovery.get("replanTitle"),
                "action": clone(recovery["replanAction"]),
                "status": "pending",
            },
        }

    return {
        "strategy": "human_handoff",
        "reason": failure,
    }


def calculate_backoff_ms(initial_delay_ms, retry_count):
    return initial_delay_ms * 2**retry_count


def clone(value):
    return copy.deepcopy(value)
