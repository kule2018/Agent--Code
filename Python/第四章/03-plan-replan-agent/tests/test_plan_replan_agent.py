import asyncio
import json
import unittest

from deepseek_client import call_deepseek
from incident_data import INCIDENT
from incident_tools import TOOL_CATALOG, execute_tool
from plan_agent import generate_final_answer, run_plan_agent
from plan_schema import parse_model_json
from plan_state import (
    StepStatus,
    apply_replan,
    complete_step,
    create_plan_state,
    get_completed_evidence,
    get_next_ready_step,
    start_step,
)
from planner import create_initial_plan, replan


GOAL = "排查 payment-service 从 15:10 开始出现的大量支付失败。"
COMPLETION_CRITERIA = [
    "通过监控数据确认故障现象和异常时间",
    "通过错误日志找到直接故障表现",
    "使用另一份独立系统数据验证最可能的故障原因",
]

INITIAL_PLAN = {
    "planSummary": "先验证数据库连接池假设。",
    "steps": [
        {
            "id": "step-1",
            "title": "查询核心监控",
            "toolName": "query_metrics",
            "arguments": {"serviceName": "payment-service"},
            "dependsOn": [],
        },
        {
            "id": "step-2",
            "title": "检查数据库连接池",
            "toolName": "inspect_database_pool",
            "arguments": {"serviceName": "payment-service"},
            "dependsOn": ["step-1"],
        },
    ],
}


class IncidentToolsTest(unittest.TestCase):
    def test_executes_known_tool(self):
        observation = asyncio.run(execute_tool("query_metrics", {"serviceName": "payment-service"}))

        self.assertTrue(observation["ok"])
        self.assertEqual(observation["source"], "query_metrics")
        self.assertEqual(observation["data"]["databasePoolUsagePercent"], 46)

    def test_rejects_invalid_tool_call(self):
        with self.assertRaisesRegex(ValueError, "不存在工具"):
            asyncio.run(execute_tool("restart_service", {"serviceName": "payment-service"}))

        with self.assertRaisesRegex(ValueError, "参数没有通过校验"):
            asyncio.run(execute_tool("query_metrics", {}))

        with self.assertRaisesRegex(ValueError, "没有找到服务"):
            asyncio.run(execute_tool("query_metrics", {"serviceName": "unknown-service"}))


class PlanSchemaTest(unittest.TestCase):
    def test_parses_and_normalizes_initial_plan(self):
        plan = parse_model_json(json.dumps(INITIAL_PLAN, ensure_ascii=False), "initial_plan", "Planner")

        self.assertEqual(len(plan["steps"]), 2)
        self.assertEqual(plan["steps"][1]["dependsOn"], ["step-1"])

    def test_rejects_invalid_initial_plan(self):
        with self.assertRaisesRegex(ValueError, "Planner 返回结构不符合要求"):
            parse_model_json(
                json.dumps({"planSummary": "x", "steps": []}, ensure_ascii=False),
                "initial_plan",
                "Planner",
            )

    def test_parses_replan_defaults(self):
        decision = parse_model_json(
            json.dumps(
                {
                    "decision": "continue",
                    "reason": "需要继续检查日志。",
                    "planSummary": "增加日志检查。",
                    "newSteps": [
                        {
                            "id": "step-3",
                            "title": "查询错误日志",
                            "toolName": "query_logs",
                            "arguments": {"serviceName": "payment-service"},
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            "replan_decision",
            "Replanner",
        )

        self.assertEqual(decision["cancelStepIds"], [])
        self.assertEqual(decision["newSteps"][0]["dependsOn"], [])


class PlanStateTest(unittest.TestCase):
    def test_executes_dependencies_and_applies_replan(self):
        state = create_plan_state(GOAL, COMPLETION_CRITERIA, INITIAL_PLAN)

        self.assertEqual(get_next_ready_step(state)["id"], "step-1")
        start_step(state, "step-1")
        complete_step(state, "step-1", {"ok": True, "source": "query_metrics"})

        decision = {
            "decision": "continue",
            "reason": "监控不支持连接池耗尽，取消连接池检查，改查日志。",
            "planSummary": "转向日志直接错误。",
            "cancelStepIds": ["step-2"],
            "newSteps": [
                {
                    "id": "step-3",
                    "title": "查询错误日志",
                    "toolName": "query_logs",
                    "arguments": {"serviceName": "payment-service"},
                    "dependsOn": ["step-1"],
                }
            ],
        }
        apply_replan(state, decision)

        self.assertEqual(state["version"], 2)
        self.assertEqual(state["steps"][1]["status"], StepStatus.CANCELLED)
        self.assertEqual(get_next_ready_step(state)["id"], "step-3")
        self.assertEqual(state["revisions"][0]["newStepIds"], ["step-3"])

    def test_rejects_early_finish(self):
        state = create_plan_state(GOAL, COMPLETION_CRITERIA, INITIAL_PLAN)
        start_step(state, "step-1")
        complete_step(state, "step-1", {"ok": True, "source": "query_metrics"})
        apply_replan(
            state,
            {
                "decision": "continue",
                "reason": "先取消连接池假设。",
                "planSummary": "等待日志检查。",
                "cancelStepIds": ["step-2"],
                "newSteps": [],
            },
        )

        with self.assertRaisesRegex(ValueError, "过早结束任务"):
            apply_replan(
                state,
                {
                    "decision": "finish",
                    "reason": "证据不足却结束。",
                    "planSummary": "结束。",
                    "cancelStepIds": [],
                    "newSteps": [],
                },
            )

    def test_deduplicates_new_step_by_tool_and_arguments(self):
        state = create_plan_state(GOAL, COMPLETION_CRITERIA, INITIAL_PLAN)

        apply_replan(
            state,
            {
                "decision": "continue",
                "reason": "重复步骤应被忽略。",
                "planSummary": "继续执行原计划。",
                "cancelStepIds": [],
                "newSteps": [
                    {
                        "id": "step-3",
                        "title": "重复查询监控",
                        "toolName": "query_metrics",
                        "arguments": {"serviceName": "payment-service"},
                        "dependsOn": [],
                    }
                ],
            },
        )

        self.assertEqual(len(state["steps"]), 2)
        self.assertEqual(state["revisions"][0]["newStepIds"], [])

    def test_rejects_missing_dependency_and_unknown_tool(self):
        bad_dependency = {
            "planSummary": "错误计划。",
            "steps": [
                {
                    "id": "step-1",
                    "title": "查询监控",
                    "toolName": "query_metrics",
                    "arguments": {"serviceName": "payment-service"},
                    "dependsOn": ["step-9"],
                },
                {
                    "id": "step-2",
                    "title": "查日志",
                    "toolName": "query_logs",
                    "arguments": {"serviceName": "payment-service"},
                    "dependsOn": [],
                },
            ],
        }
        unknown_tool = {
            "planSummary": "错误计划。",
            "steps": [
                {
                    "id": "step-1",
                    "title": "重启服务",
                    "toolName": "restart_service",
                    "arguments": {"serviceName": "payment-service"},
                    "dependsOn": [],
                },
                {
                    "id": "step-2",
                    "title": "查日志",
                    "toolName": "query_logs",
                    "arguments": {"serviceName": "payment-service"},
                    "dependsOn": [],
                },
            ],
        }

        with self.assertRaisesRegex(ValueError, "依赖不存在"):
            create_plan_state(GOAL, COMPLETION_CRITERIA, bad_dependency)

        with self.assertRaisesRegex(ValueError, "不存在的工具"):
            create_plan_state(GOAL, COMPLETION_CRITERIA, unknown_tool)


class PlannerTest(unittest.TestCase):
    def test_create_initial_plan_uses_json_output(self):
        captured = {}

        async def fake_model(**kwargs):
            captured.update(kwargs)
            return {
                "message": {"content": json.dumps(INITIAL_PLAN, ensure_ascii=False)},
                "latencyMs": 7,
            }

        result = asyncio.run(
            create_initial_plan(
                goal=GOAL,
                alert_context=INCIDENT["alertContext"],
                completion_criteria=COMPLETION_CRITERIA,
                tool_catalog=TOOL_CATALOG,
                call_model=fake_model,
            )
        )

        self.assertTrue(captured["json_output"])
        self.assertEqual(result["latencyMs"], 7)
        self.assertEqual(result["plan"]["steps"][0]["toolName"], "query_metrics")

    def test_replan_calculates_next_step_number(self):
        state = create_plan_state(GOAL, COMPLETION_CRITERIA, INITIAL_PLAN)
        captured = {}

        async def fake_model(**kwargs):
            captured.update(kwargs)
            return {
                "message": {
                    "content": json.dumps(
                        {
                            "decision": "continue",
                            "reason": "需要查询日志。",
                            "planSummary": "追加日志步骤。",
                            "cancelStepIds": ["step-2"],
                            "newSteps": [
                                {
                                    "id": "step-3",
                                    "title": "查询错误日志",
                                    "toolName": "query_logs",
                                    "arguments": {"serviceName": "payment-service"},
                                    "dependsOn": ["step-1"],
                                }
                            ],
                        },
                        ensure_ascii=False,
                    )
                },
                "latencyMs": 9,
            }

        result = asyncio.run(replan(state=state, tool_catalog=TOOL_CATALOG, call_model=fake_model))

        self.assertTrue(captured["json_output"])
        self.assertIn("step-3", captured["messages"][0]["content"])
        self.assertEqual(result["decision"]["newSteps"][0]["id"], "step-3")


class PlanAgentTest(unittest.TestCase):
    def test_runs_full_plan_replan_route(self):
        async def fake_create_initial_plan(**kwargs):
            return {"plan": INITIAL_PLAN, "latencyMs": 1}

        decisions = [
            {
                "decision": "continue",
                "reason": "监控不支持连接池耗尽，取消连接池检查，改查日志。",
                "planSummary": "改为验证日志中的直接错误。",
                "cancelStepIds": ["step-2"],
                "newSteps": [
                    {
                        "id": "step-3",
                        "title": "查询错误日志",
                        "toolName": "query_logs",
                        "arguments": {"serviceName": "payment-service"},
                        "dependsOn": ["step-1"],
                    }
                ],
            },
            {
                "decision": "continue",
                "reason": "日志显示 v2.4.1 的 currency 错误，需要查询发布记录。",
                "planSummary": "追加发布记录验证版本变更。",
                "cancelStepIds": [],
                "newSteps": [
                    {
                        "id": "step-4",
                        "title": "查询最近发布",
                        "toolName": "get_recent_deployments",
                        "arguments": {"serviceName": "payment-service"},
                        "dependsOn": ["step-3"],
                    }
                ],
            },
            {
                "decision": "finish",
                "reason": "监控、日志和发布记录已经形成证据链。",
                "planSummary": "证据链完整，可以生成结论。",
                "cancelStepIds": [],
                "newSteps": [],
            },
        ]

        async def fake_replan(**kwargs):
            return {"decision": decisions.pop(0), "latencyMs": 1}

        async def fake_final_answer(**kwargs):
            evidence = kwargs["evidence"]
            self.assertEqual(
                [item["toolName"] for item in evidence],
                ["query_metrics", "query_logs", "get_recent_deployments"],
            )
            return "最可能原因是 v2.4.1 的币种归一化逻辑引入空字段读取问题。"

        result = asyncio.run(
            run_plan_agent(
                goal=GOAL,
                alert_context=INCIDENT["alertContext"],
                completion_criteria=COMPLETION_CRITERIA,
                tool_catalog=TOOL_CATALOG,
                execute_tool=execute_tool,
                create_initial_plan_fn=fake_create_initial_plan,
                replan_fn=fake_replan,
                generate_final_answer_fn=fake_final_answer,
            )
        )

        self.assertEqual(result["state"]["status"], "completed")
        self.assertEqual(result["state"]["version"], 4)
        self.assertEqual(result["state"]["steps"][1]["status"], StepStatus.CANCELLED)
        self.assertIn("v2.4.1", result["finalAnswer"])

    def test_generate_final_answer_uses_completed_evidence_only(self):
        captured = {}

        async def fake_model(**kwargs):
            captured.update(kwargs)
            return {
                "message": {"content": "最终结论"},
                "latencyMs": 1,
            }

        answer = asyncio.run(
            generate_final_answer(
                goal=GOAL,
                evidence=[{"toolName": "query_metrics", "observation": {"ok": True}}],
                call_model=fake_model,
            )
        )

        self.assertEqual(answer, "最终结论")
        self.assertEqual(captured["max_tokens"], 1600)
        self.assertNotIn("response_format", captured)

    def test_get_completed_evidence_filters_pending_and_cancelled(self):
        state = create_plan_state(GOAL, COMPLETION_CRITERIA, INITIAL_PLAN)
        start_step(state, "step-1")
        complete_step(state, "step-1", {"ok": True})
        apply_replan(
            state,
            {
                "decision": "continue",
                "reason": "取消数据库步骤。",
                "planSummary": "等待日志。",
                "cancelStepIds": ["step-2"],
                "newSteps": [
                    {
                        "id": "step-3",
                        "title": "查询错误日志",
                        "toolName": "query_logs",
                        "arguments": {"serviceName": "payment-service"},
                        "dependsOn": ["step-1"],
                    }
                ],
            },
        )

        self.assertEqual(
            [item["id"] for item in get_completed_evidence(state)],
            ["step-1"],
        )


class DeepSeekClientTest(unittest.TestCase):
    def test_builds_deepseek_request_for_json_output(self):
        captured = {}

        def transport(api_url, headers, payload):
            captured["api_url"] = api_url
            captured["headers"] = headers
            captured["payload"] = payload
            return 200, {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(INITIAL_PLAN, ensure_ascii=False),
                        }
                    }
                ],
                "usage": {"total_tokens": 32},
            }

        result = asyncio.run(
            call_deepseek(
                messages=[{"role": "user", "content": "hello"}],
                json_output=True,
                max_tokens=123,
                env={
                    "DEEPSEEK_API_KEY": "sk-test",
                    "DEEPSEEK_BASE_URL": "https://example.test/chat/completions",
                    "DEEPSEEK_MODEL": "deepseek-test",
                },
                transport=transport,
            )
        )

        self.assertEqual(captured["api_url"], "https://example.test/chat/completions")
        self.assertEqual(captured["headers"]["Authorization"], "Bearer sk-test")
        self.assertEqual(captured["payload"]["model"], "deepseek-test")
        self.assertEqual(captured["payload"]["response_format"], {"type": "json_object"})
        self.assertEqual(captured["payload"]["thinking"], {"type": "disabled"})
        self.assertEqual(captured["payload"]["temperature"], 0.1)
        self.assertEqual(captured["payload"]["max_tokens"], 123)
        self.assertEqual(result["usage"], {"total_tokens": 32})

    def test_requires_api_key(self):
        with self.assertRaisesRegex(RuntimeError, "缺少 DEEPSEEK_API_KEY"):
            asyncio.run(call_deepseek(messages=[], env={}))
