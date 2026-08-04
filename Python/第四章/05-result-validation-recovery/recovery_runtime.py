"""带结果校验和失败恢复的 Agent Runtime。"""

import asyncio
import copy
import json

from incident_tools import create_tool_executor
from recovery_policy import select_recovery
from recovery_state import create_recovery_state
from result_validator import (
    classify_tool_error,
    validate_evidence_set,
    validate_observation,
)


async def run_recovery_agent(*, scenario_name, silent=False):
    """运行一次带结果校验和失败恢复的 Agent 任务。"""

    # 为当前实验创建独立的运行状态
    state = create_recovery_state(scenario_name)

    # 根据实验场景创建对应的工具执行器，用于模拟空结果、冲突或超时
    execute_tool = create_tool_executor(scenario_name)

    # 根据 silent 参数决定是否输出运行日志
    log = create_logger(silent)

    log(f"runId：{state['runId']}")

    # 只要任务仍处于运行状态，就持续调度待执行的计划步骤
    while state["status"] == "running":
        # 当前示例按顺序获取第一个尚未处理的步骤
        step = next(
            (item for item in state["planState"]["steps"] if item["status"] == "pending"),
            None,
        )

        # 没有待执行步骤时，检查计划是否满足完成条件并结束运行
        if not step:
            complete_run(state)
            break

        log(f"\n执行步骤：{step['title']}")
        log(f"Action：{format_action(step['action'])}")

        # 执行当前 Action，并在内部完成结果校验、重试或备用方案选择
        result = await execute_action_with_recovery(
            state=state,
            step=step,
            execute_tool=execute_tool,
            log=log,
        )

        # 工具返回了通过校验的有效 Observation
        if result["type"] == "observation":
            # 标记当前计划步骤已完成，并记录最终使用的工具
            step["status"] = "completed"
            step["resolvedBy"] = result["action"]["toolName"]

            # 保存有效 Observation 及相关运行统计
            state["usage"]["validatedObservations"] += 1
            state["observations"].append(result["observation"])
            state["trace"].append(
                {
                    "type": "observation",
                    "stepId": step["id"],
                    "evidenceKey": result["observation"]["evidenceKey"],
                }
            )

            log(f"校验通过：{result['observation']['data']['summary']}")

            # 单条结果有效，并不代表全部证据组合后仍然一致
            evidence_validation = validate_evidence_set(state["observations"])

            # 多份证据发生冲突时，记录恢复决策并转交人工处理
            if not evidence_validation["ok"]:
                decision = select_recovery(
                    failure=evidence_validation["failure"],
                    action=step["action"],
                    retry_count=0,
                )

                # 把证据冲突和恢复决策写入运行状态及执行日志
                record_recovery(state, decision, evidence_validation["failure"], log)
                # 当前证据冲突无法自动恢复时，转交人工处理
                apply_human_handoff(state, evidence_validation["failure"])

            # 当前步骤处理完成，进入下一轮计划调度
            continue

        # 当前 Action 无法获得有效结果，需要替换原计划步骤
        if result["type"] == "replan":
            # 取消原步骤，并递增 Plan State 版本
            step["status"] = "cancelled"
            state["planState"]["version"] += 1

            # 将重新规划得到的替代步骤追加到计划中
            state["planState"]["steps"].append(result["replacementStep"])
            continue

        # 无法通过重试、备用工具或重新规划恢复时，转交人工处理
        apply_human_handoff(state, result["failure"])

    # 返回完整运行状态，供日志汇总、测试断言或后续分析使用
    return state


async def execute_action_with_recovery(*, state, step, execute_tool, log):
    """执行一个 Action，并在执行失败或结果校验失败时尝试恢复。

    恢复策略可能包括：
    - retry：等待一段时间后重试当前 Action
    - fallback：切换到备用 Action 后继续执行
    - replan：返回替代步骤，由上层更新 Plan State
    - human_handoff：无法自动恢复，转交人工处理
    """

    # 克隆步骤中的原始 Action，避免切换备用 Action 时直接修改 Plan State
    action = clone(step["action"])

    # 记录当前 Action 已经连续重试的次数
    retry_count = 0

    # Runtime 仍处于运行状态时，持续执行或恢复当前 Action
    while state["status"] == "running":
        # 每次调用工具都计为一次尝试，包括重试和备用工具调用
        state["usage"]["toolAttempts"] += 1

        try:
            # 执行当前 Action 对应的工具
            observation = await execute_tool(action)

            # 工具正常返回时，记录一次工具响应
            state["usage"]["toolResponses"] += 1

            # 校验 Observation 是否满足当前 Action 的结果要求
            validation = validate_observation(action, observation)

            # Observation 有效时，将结果交给上层写入 Agent Run State
            if validation["ok"]:
                return {
                    "type": "observation",
                    "observation": observation,
                    "action": action,
                }

            # 工具虽然正常返回，但结果为空、格式错误或不满足业务要求
            log(f"结果校验失败：{validation['failure']['message']}")

            # 根据失败类型、当前 Action 和重试次数选择恢复策略
            decision = select_recovery(
                failure=validation["failure"],
                action=action,
                retry_count=retry_count,
            )

            # 把本次失败和恢复决策写入运行状态及执行日志
            record_recovery(state, decision, validation["failure"], log)

            # 当前数据源无法提供有效结果时，返回替代步骤并触发重新规划
            if decision["strategy"] == "replan":
                return {
                    "type": "replan",
                    "replacementStep": decision["replacementStep"],
                }

            # 结果校验失败且无法自动恢复时，转交人工处理
            return {
                "type": "human_handoff",
                "failure": validation["failure"],
            }
        except Exception as error:
            # 将工具抛出的原始异常转换成统一的 Failure 结构
            failure = classify_tool_error(error)

            log(f"工具执行失败：{failure['message']}")

            # 根据异常类型选择重试、备用方案或人工接管
            decision = select_recovery(failure=failure, action=action, retry_count=retry_count)

            # 记录本次异常及对应的恢复决策
            record_recovery(state, decision, failure, log)

            # 临时故障允许重试时，等待指定时间后再次执行当前 Action
            if decision["strategy"] == "retry":
                retry_count += 1
                await delay(decision["delayMs"])
                continue

            # 当前工具持续失败时，切换到备用工具或备用数据源
            if decision["strategy"] == "fallback":
                action = decision["nextAction"]

                # 新 Action 使用独立的重试计数
                retry_count = 0

                log(f"切换 Action：{format_action(action)}")
                continue

            # 不满足重试或备用方案条件时，交由人工处理
            return {
                "type": "human_handoff",
                "failure": failure,
            }

    # Runtime 在恢复过程中被外部停止时，返回统一的人工接管结果
    return {
        "type": "human_handoff",
        "failure": {
            "kind": "runtime_stopped",
            "code": "RUNTIME_STOPPED",
            "message": "Runtime 已经停止。",
        },
    }


def record_recovery(state, decision, failure, log):
    event = {
        "strategy": decision["strategy"],
        "failureCode": failure["code"],
        "message": failure["message"],
    }

    state["recoveryEvents"].append(event)
    state["trace"].append({"type": "recovery", **event})
    log(f"Recovery：{decision['strategy']}")


def apply_human_handoff(state, failure):
    state["status"] = "waiting_for_human"
    state["planState"]["status"] = "waiting_for_human"
    state["stopReason"] = {
        "code": "human_handoff",
        "message": "自动恢复无法安全解决当前问题。",
    }
    state["handoff"] = {
        "reasonCode": failure["code"],
        "summary": failure["message"],
        "requestedAction": "请人工核对证据冲突或补充缺失信息。",
        "evidenceKeys": [item["evidenceKey"] for item in state["observations"]],
        "planVersion": state["planState"]["version"],
    }


def complete_run(state):
    state["status"] = "completed"
    state["planState"]["status"] = "completed"
    state["stopReason"] = {
        "code": "completed",
        "message": "所有计划步骤均已获得通过校验的证据。",
    }


def create_logger(silent):
    return (lambda *args: None) if silent else print


def format_action(action):
    return f"{action['toolName']}({json.dumps(action['arguments'], ensure_ascii=False)})"


async def delay(ms):
    await asyncio.sleep(ms / 1000)


def clone(value):
    return copy.deepcopy(value)
