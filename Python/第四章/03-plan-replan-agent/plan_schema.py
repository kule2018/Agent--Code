"""Planner / Replanner JSON 输出校验。"""

import json
import re

STEP_ID_PATTERN = re.compile(r"^step-\d+$")


def parse_model_json(content, schema_name, stage):
    """解析并校验模型返回的 JSON。

    JSON Output 只能保证返回内容是合法 JSON，
    具体字段和业务约束仍然需要应用程序自己校验。
    """

    if not content:
        raise ValueError(f"{stage} 没有返回内容。")

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        raise ValueError(f"{stage} 返回的内容不是合法 JSON：{content}") from None

    issues = validate_initial_plan(data) if schema_name == "initial_plan" else validate_replan_decision(data)

    if issues:
        raise ValueError(f"{stage} 返回结构不符合要求：{json.dumps(issues, ensure_ascii=False)}")

    return normalize_initial_plan(data) if schema_name == "initial_plan" else normalize_replan_decision(data)


def validate_initial_plan(data):
    issues = []

    if not isinstance(data, dict):
        return [{"path": [], "message": "必须是对象。"}]

    if not isinstance(data.get("planSummary"), str) or len(data["planSummary"]) < 1:
        issues.append({"path": ["planSummary"], "message": "planSummary 必须是非空字符串。"})

    steps = data.get("steps")
    if not isinstance(steps, list) or len(steps) != 2:
        issues.append({"path": ["steps"], "message": "steps 必须包含且只包含 2 个步骤。"})
    else:
        for index, step in enumerate(steps):
            issues.extend(validate_plan_step(step, ["steps", index]))

    return issues


def validate_replan_decision(data):
    issues = []

    if not isinstance(data, dict):
        return [{"path": [], "message": "必须是对象。"}]

    if data.get("decision") not in ["continue", "finish"]:
        issues.append({"path": ["decision"], "message": "decision 必须是 continue 或 finish。"})

    if not isinstance(data.get("reason"), str) or len(data["reason"]) < 1:
        issues.append({"path": ["reason"], "message": "reason 必须是非空字符串。"})

    if not isinstance(data.get("planSummary"), str) or len(data["planSummary"]) < 1:
        issues.append({"path": ["planSummary"], "message": "planSummary 必须是非空字符串。"})

    cancel_step_ids = data.get("cancelStepIds", [])
    if not isinstance(cancel_step_ids, list) or not all(isinstance(item, str) for item in cancel_step_ids):
        issues.append({"path": ["cancelStepIds"], "message": "cancelStepIds 必须是字符串数组。"})

    new_steps = data.get("newSteps", [])
    if not isinstance(new_steps, list) or len(new_steps) > 1:
        issues.append({"path": ["newSteps"], "message": "newSteps 最多只能包含 1 个步骤。"})
    else:
        for index, step in enumerate(new_steps):
            issues.extend(validate_plan_step(step, ["newSteps", index]))

    return issues


def validate_plan_step(step, path):
    issues = []

    if not isinstance(step, dict):
        return [{"path": path, "message": "计划步骤必须是对象。"}]

    if not isinstance(step.get("id"), str) or not STEP_ID_PATTERN.match(step["id"]):
        issues.append({"path": path + ["id"], "message": "id 必须符合 step-N 格式。"})

    if not isinstance(step.get("title"), str) or len(step["title"]) < 1:
        issues.append({"path": path + ["title"], "message": "title 必须是非空字符串。"})

    if not isinstance(step.get("toolName"), str) or len(step["toolName"]) < 1:
        issues.append({"path": path + ["toolName"], "message": "toolName 必须是非空字符串。"})

    arguments = step.get("arguments")
    if not isinstance(arguments, dict):
        issues.append({"path": path + ["arguments"], "message": "arguments 必须是对象。"})
    elif not isinstance(arguments.get("serviceName"), str) or len(arguments["serviceName"]) < 1:
        issues.append({"path": path + ["arguments", "serviceName"], "message": "serviceName 必须是非空字符串。"})

    depends_on = step.get("dependsOn", [])
    if not isinstance(depends_on, list) or not all(isinstance(item, str) for item in depends_on):
        issues.append({"path": path + ["dependsOn"], "message": "dependsOn 必须是字符串数组。"})

    return issues


def normalize_initial_plan(data):
    return {
        "planSummary": data["planSummary"],
        "steps": [normalize_plan_step(step) for step in data["steps"]],
    }


def normalize_replan_decision(data):
    return {
        "decision": data["decision"],
        "reason": data["reason"],
        "planSummary": data["planSummary"],
        "cancelStepIds": data.get("cancelStepIds", []),
        "newSteps": [normalize_plan_step(step) for step in data.get("newSteps", [])],
    }


def normalize_plan_step(step):
    return {
        "id": step["id"],
        "title": step["title"],
        "toolName": step["toolName"],
        "arguments": {
            "serviceName": step["arguments"]["serviceName"],
        },
        "dependsOn": step.get("dependsOn", []),
    }
