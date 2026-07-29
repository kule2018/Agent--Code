"""Planner 和 Replanner 模型调用封装。"""

import inspect
import json

from deepseek_client import call_deepseek
from plan_schema import parse_model_json


async def create_initial_plan(*, goal, alert_context, completion_criteria, tool_catalog, call_model=None):
    """根据任务目标和当前已知信息生成初始计划。"""

    call_model = call_model or call_deepseek

    result = call_model(
        json_output=True,
        messages=[
            {
                "role": "system",
                "content": """你是故障排查 Agent 的 Planner。

你只负责生成外部可执行计划，不要输出隐藏思考过程。
必须返回 JSON，格式如下：
{
  "planSummary": "当前计划说明",
  "steps": [
    {
      "id": "step-1",
      "title": "步骤目标",
      "toolName": "工具名称",
      "arguments": { "serviceName": "服务名称" },
      "dependsOn": []
    }
  ]
}

规划规则：
1. 当前教学案例必须生成且只生成 2 个可执行步骤。
2. 当前告警只是线索，不是已经确认的事实。
3. step-1 使用 query_metrics 核对异常方向。
4. step-2 根据当前数据库告警使用 inspect_database_pool，并依赖 step-1。
5. 初始计划只验证当前最可能的数据库假设，不要提前加入日志或发布等备用路线。
6. 不要生成总结、汇报或修改系统的步骤。""",
            },
            {
                "role": "user",
                "content": f"""请输出 JSON 任务计划。

用户目标：
{goal}

当前告警：
{json.dumps(alert_context, ensure_ascii=False, indent=2)}

任务完成条件：
{json.dumps(completion_criteria, ensure_ascii=False, indent=2)}

可用工具：
{json.dumps(tool_catalog, ensure_ascii=False, indent=2)}""",
            },
        ],
    )
    if inspect.isawaitable(result):
        result = await result

    return {
        "plan": parse_model_json(result["message"].get("content"), "initial_plan", "Planner"),
        "latencyMs": result["latencyMs"],
    }


async def replan(*, state, tool_catalog, call_model=None):
    """根据最新 Observation 重新检查计划。"""

    call_model = call_model or call_deepseek
    next_step_number = max(int(step["id"].split("-")[1]) for step in state["steps"]) + 1

    result = call_model(
        json_output=True,
        messages=[
            {
                "role": "system",
                "content": f"""你是故障排查 Agent 的 Replanner。

你需要根据已经完成步骤的 Observation，检查当前计划是否仍然成立。
必须返回 JSON，格式如下：
{{
  "decision": "continue 或 finish",
  "reason": "调整或结束的直接证据",
  "planSummary": "调整后的当前计划说明",
  "cancelStepIds": ["需要取消的 pending 步骤 ID"],
  "newSteps": [
    {{
      "id": "新的 step-N",
      "title": "步骤目标",
      "toolName": "工具名称",
      "arguments": {{ "serviceName": "服务名称" }},
      "dependsOn": ["已经存在的步骤 ID"]
    }}
  ]
}}

重新规划规则：
1. completed 步骤及结果必须保留，不能取消，也不能重复执行。
2. 如果 Observation 推翻当前假设，取消受影响的 pending 步骤，再增加新的验证步骤。
3. 新步骤 ID 从 step-{next_step_number} 开始，不得复用现有 ID。
4. 每次最多增加一个当前证据支持的新步骤，不要一次加入所有可能路线。
5. 逐条检查 Plan State 中的 completionCriteria。只有全部条件都有 Observation 支持时，才能 finish。
6. 当前任务至少需要三份已完成的工具结果，并形成“现象、直接错误、关联变更或系统状态”的证据链，才能 finish。
7. 添加步骤前先检查当前所有 pending、running 和 completed 步骤，不得重复相同工具和参数。
8. 如果下一步已经存在于 pending 中，继续执行它即可，newSteps 返回空数组。
9. 资料不足且没有可用的 pending 步骤时，必须 continue 并提供一个 newStep。
10. 只输出外部计划决定，不要输出隐藏思考过程。""",
            },
            {
                "role": "user",
                "content": f"""请检查计划并输出 JSON。

可用工具：
{json.dumps(tool_catalog, ensure_ascii=False, indent=2)}

当前 Plan State：
{json.dumps(state, ensure_ascii=False, indent=2)}""",
            },
        ],
    )
    if inspect.isawaitable(result):
        result = await result

    return {
        "decision": parse_model_json(result["message"].get("content"), "replan_decision", "Replanner"),
        "latencyMs": result["latencyMs"],
    }
