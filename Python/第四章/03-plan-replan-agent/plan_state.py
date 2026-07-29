"""应用程序持有的 Plan State。"""

import json

from incident_tools import has_tool


class StepStatus:
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


def create_plan_state(goal, completion_criteria, initial_plan):
    """根据 Planner 返回结果创建应用程序持有的 Plan State。"""

    state = {
        "goal": goal,
        "version": 1,
        "status": "active",
        "planSummary": initial_plan["planSummary"],
        "completionCriteria": completion_criteria,
        "steps": [
            {
                **step,
                "status": StepStatus.PENDING,
                "observation": None,
            }
            for step in initial_plan["steps"]
        ],
        "revisions": [],
    }

    # 检查计划完整性，确保没有重复 ID、依赖关系正确、工具存在等
    assert_plan_integrity(state)

    return state


def get_next_ready_step(state):
    """找到当前依赖已经完成的第一个待执行步骤。"""

    completed_step_ids = {
        step["id"] for step in state["steps"] if step["status"] == StepStatus.COMPLETED
    }

    return next(
        (
            step
            for step in state["steps"]
            if step["status"] == StepStatus.PENDING
            and all(step_id in completed_step_ids for step_id in step["dependsOn"])
        ),
        None,
    )


def start_step(state, step_id):
    """把计划步骤标记为执行中。"""

    step = get_step(state, step_id)

    if step["status"] != StepStatus.PENDING:
        raise ValueError(f"步骤 {step_id} 当前不是 pending，不能开始执行。")

    step["status"] = StepStatus.RUNNING


def complete_step(state, step_id, observation):
    """保存工具 Observation，并把步骤标记为完成。"""

    step = get_step(state, step_id)

    if step["status"] != StepStatus.RUNNING:
        raise ValueError(f"步骤 {step_id} 当前不是 running，不能完成。")

    step["status"] = StepStatus.COMPLETED
    step["observation"] = observation


def apply_replan(state, decision):
    """将 Replanner 的决定合并到当前计划。

    已完成步骤不会被删除；只能取消尚未执行的步骤，
    再把新的待执行步骤加入计划。
    """

    previous_version = state["version"]

    if decision["decision"] == "finish" and len(decision["newSteps"]) > 0:
        raise ValueError("Replanner 决定 finish 时不能继续增加新步骤。")

    for step_id in decision["cancelStepIds"]:
        step = get_step(state, step_id)

        if step["status"] != StepStatus.PENDING:
            raise ValueError(f"只能取消 pending 步骤，{step_id} 当前为 {step['status']}。")

        step["status"] = StepStatus.CANCELLED

    active_step_signatures = {
        create_step_signature(step)
        for step in state["steps"]
        if step["status"] != StepStatus.CANCELLED
    }

    new_steps_to_add = []
    for step in decision["newSteps"]:
        signature = create_step_signature(step)

        if signature in active_step_signatures:
            continue

        active_step_signatures.add(signature)
        new_steps_to_add.append(step)

    for step in new_steps_to_add:
        state["steps"].append(
            {
                **step,
                "status": StepStatus.PENDING,
                "observation": None,
            }
        )

    remaining_pending_steps = [
        step for step in state["steps"] if step["status"] == StepStatus.PENDING
    ]

    if decision["decision"] == "finish" and len(remaining_pending_steps) > 0:
        pending_ids = "、".join(step["id"] for step in remaining_pending_steps)
        raise ValueError(f"Replanner 决定 finish，但计划中仍有 pending 步骤：{pending_ids}")

    completed_step_count = len(
        [step for step in state["steps"] if step["status"] == StepStatus.COMPLETED]
    )

    if decision["decision"] == "finish" and completed_step_count < len(state["completionCriteria"]):
        raise ValueError(
            f"Replanner 过早结束任务：当前只有 {completed_step_count} 份已完成结果，无法覆盖 {len(state['completionCriteria'])} 条完成条件。"
        )

    state["version"] += 1
    state["status"] = "ready_to_finish" if decision["decision"] == "finish" else "active"
    state["planSummary"] = decision["planSummary"]
    state["revisions"].append(
        {
            "fromVersion": previous_version,
            "toVersion": state["version"],
            "decision": decision["decision"],
            "reason": decision["reason"],
            "cancelStepIds": decision["cancelStepIds"],
            "newStepIds": [step["id"] for step in new_steps_to_add],
        }
    )

    assert_plan_integrity(state)


def get_completed_evidence(state):
    """读取已经完成步骤形成的证据。"""

    return [
        {
            "id": step["id"],
            "title": step["title"],
            "toolName": step["toolName"],
            "observation": step["observation"],
        }
        for step in state["steps"]
        if step["status"] == StepStatus.COMPLETED
    ]


def assert_plan_integrity(state):
    """检查计划 ID、工具和依赖关系。"""

    ids = [step["id"] for step in state["steps"]]
    id_set = set(ids)

    if len(id_set) != len(ids):
        raise ValueError("计划中出现了重复的步骤 ID。")

    for step in state["steps"]:
        if not has_tool(step["toolName"]):
            raise ValueError(f"计划引用了不存在的工具 {step['toolName']}。")

        for dependency_id in step["dependsOn"]:
            if dependency_id not in id_set:
                raise ValueError(f"步骤 {step['id']} 依赖不存在的步骤 {dependency_id}。")

            if dependency_id == step["id"]:
                raise ValueError(f"步骤 {step['id']} 不能依赖自己。")


def get_step(state, step_id):
    step = next((item for item in state["steps"] if item["id"] == step_id), None)

    if step is None:
        raise ValueError(f"计划中不存在步骤 {step_id}。")

    return step


def create_step_signature(step):
    """使用工具名称和参数识别重复计划步骤。"""

    return f"{step['toolName']}:{json.dumps(step['arguments'], ensure_ascii=False, separators=(',', ':'))}"
