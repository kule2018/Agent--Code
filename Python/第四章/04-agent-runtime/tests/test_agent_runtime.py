import asyncio
import copy
import unittest

from agent_runtime import run_agent
from demo import GOAL, create_plan_state
from incident_tools import execute_tool
from runtime_state import (
    can_call_model,
    can_execute_action,
    complete_run,
    create_action_fingerprint,
    create_run_state,
    record_model_decision,
    record_observation,
)
from scripted_decision_provider import create_decision_provider, final_answer, tool_call


def run_scenario(scenario_name, limits=None):
    state = create_run_state(
        goal=GOAL,
        plan_state=create_plan_state(),
        limits=limits or ({"maxToolCalls": 2} if scenario_name == "budget" else {}),
    )

    return asyncio.run(
        run_agent(
            state=state,
            decide_next_action=create_decision_provider(scenario_name),
            execute_tool=execute_tool,
        )
    )


class AgentRuntimeScenarioTest(unittest.TestCase):
    def test_complete_scenario_finishes_successfully(self):
        state = run_scenario("complete")

        self.assertEqual(state["status"], "completed")
        self.assertEqual(state["stopReason"]["code"], "completed")
        self.assertEqual(state["usage"]["steps"], 4)
        self.assertEqual(state["usage"]["modelCalls"], 4)
        self.assertEqual(state["usage"]["toolCalls"], 3)
        self.assertEqual(state["usage"]["totalTokens"], 4960)
        self.assertEqual(
            state["progress"]["evidenceSources"],
            ["query_metrics", "query_logs", "get_recent_deployments"],
        )
        self.assertEqual(state["planState"]["status"], "ready_to_finish")
        self.assertTrue(state["finalAnswer"].startswith("最可能原因是 v2.4.1"))

    def test_repeat_scenario_stops_on_repeated_action(self):
        state = run_scenario("repeat")

        self.assertEqual(state["status"], "stopped")
        self.assertEqual(state["stopReason"]["code"], "repeated_action")
        self.assertEqual(state["usage"]["steps"], 3)
        self.assertEqual(state["usage"]["toolCalls"], 2)
        self.assertEqual(state["progress"]["evidenceSources"], ["query_logs"])
        self.assertEqual(state["progress"]["consecutiveNoProgress"], 1)

    def test_no_progress_scenario_stops_after_two_duplicate_evidence_results(self):
        state = run_scenario("no-progress")

        self.assertEqual(state["status"], "stopped")
        self.assertEqual(state["stopReason"]["code"], "no_progress")
        self.assertEqual(state["usage"]["steps"], 3)
        self.assertEqual(state["usage"]["toolCalls"], 3)
        self.assertEqual(state["stopReason"]["consecutiveNoProgress"], 2)
        self.assertEqual(state["progress"]["evidenceSources"], ["query_logs"])

    def test_budget_scenario_stops_on_tool_call_limit(self):
        state = run_scenario("budget")

        self.assertEqual(state["status"], "stopped")
        self.assertEqual(state["stopReason"]["code"], "budget_exceeded")
        self.assertEqual(state["stopReason"]["limit"], "maxToolCalls")
        self.assertEqual(state["usage"]["steps"], 3)
        self.assertEqual(state["usage"]["toolCalls"], 2)


class RuntimeStateTest(unittest.TestCase):
    def test_create_run_state_clones_plan_state_and_merges_limits(self):
        plan_state = create_plan_state()
        state = create_run_state(goal=GOAL, plan_state=plan_state, limits={"maxSteps": 2})
        plan_state["steps"][0]["status"] = "completed"

        self.assertNotEqual(state["planState"]["steps"][0]["status"], "completed")
        self.assertEqual(state["limits"]["maxSteps"], 2)
        self.assertEqual(state["limits"]["maxToolCalls"], 6)
        self.assertEqual(state["status"], "running")
        self.assertIsNone(state["stopReason"])

    def test_action_fingerprint_is_stable_for_argument_order(self):
        left = {
            "toolName": "query_logs",
            "arguments": {"serviceName": "payment-service", "keyword": "error"},
        }
        right = {
            "toolName": "query_logs",
            "arguments": {"keyword": "error", "serviceName": "payment-service"},
        }

        self.assertEqual(create_action_fingerprint(left), create_action_fingerprint(right))

    def test_can_call_model_stops_when_step_budget_reached(self):
        state = create_run_state(goal=GOAL, plan_state=create_plan_state(), limits={"maxSteps": 1})
        state["usage"]["steps"] = 1

        self.assertFalse(can_call_model(state))
        self.assertEqual(state["stopReason"]["code"], "budget_exceeded")
        self.assertEqual(state["stopReason"]["limit"], "maxSteps")

    def test_record_model_decision_stops_when_token_budget_exceeded_after_call(self):
        state = create_run_state(goal=GOAL, plan_state=create_plan_state(), limits={"maxTotalTokens": 100})

        record_model_decision(
            state,
            {
                "type": "tool_call",
                "usage": {
                    "promptTokens": 80,
                    "completionTokens": 30,
                },
            },
        )

        self.assertEqual(state["status"], "stopped")
        self.assertEqual(state["stopReason"]["code"], "budget_exceeded")
        self.assertEqual(state["stopReason"]["limit"], "maxTotalTokens")
        self.assertEqual(state["usage"]["totalTokens"], 110)

    def test_record_observation_marks_plan_step_completed_only_for_new_evidence(self):
        state = create_run_state(goal=GOAL, plan_state=create_plan_state())
        action = tool_call("query_logs")["action"]
        observation = asyncio.run(execute_tool(action))

        self.assertTrue(record_observation(state, observation))
        self.assertEqual(state["planState"]["steps"][1]["status"], "completed")
        self.assertFalse(record_observation(state, copy.deepcopy(observation)))
        self.assertEqual(state["progress"]["consecutiveNoProgress"], 1)

    def test_complete_run_rejects_early_final_answer(self):
        state = create_run_state(goal=GOAL, plan_state=create_plan_state())

        complete_run(state, "提前总结")

        self.assertEqual(state["status"], "stopped")
        self.assertEqual(state["stopReason"]["code"], "failed")
        self.assertIsNone(state["finalAnswer"])

    def test_can_execute_action_records_action_history(self):
        state = create_run_state(goal=GOAL, plan_state=create_plan_state())
        action = tool_call("query_metrics")["action"]
        state["usage"]["steps"] = 1

        self.assertTrue(can_execute_action(state, action))
        self.assertEqual(state["actions"][0]["step"], 1)
        self.assertEqual(state["trace"][-1]["type"], "action")


class ScriptedDecisionProviderTest(unittest.TestCase):
    def test_decision_provider_adds_token_usage_by_round(self):
        provider = create_decision_provider("complete")
        state = create_run_state(goal=GOAL, plan_state=create_plan_state())

        first = asyncio.run(provider(state=state))
        second = asyncio.run(provider(state=state))

        self.assertEqual(first["usage"], {"promptTokens": 1000, "completionTokens": 60})
        self.assertEqual(second["usage"], {"promptTokens": 1100, "completionTokens": 60})

    def test_decision_provider_raises_for_missing_scenario_or_missing_round(self):
        with self.assertRaisesRegex(ValueError, "不存在实验"):
            create_decision_provider("missing")

        provider = create_decision_provider("budget")
        state = create_run_state(goal=GOAL, plan_state=create_plan_state())

        asyncio.run(provider(state=state))
        asyncio.run(provider(state=state))
        asyncio.run(provider(state=state))

        with self.assertRaisesRegex(ValueError, "没有准备第 4 轮决定"):
            asyncio.run(provider(state=state))


class AgentRuntimeFailureTest(unittest.TestCase):
    def test_tool_error_marks_run_failed(self):
        async def decide_next_action(*, state):
            return {
                **tool_call("missing_tool"),
                "usage": {"promptTokens": 1, "completionTokens": 1},
            }

        state = create_run_state(goal=GOAL, plan_state=create_plan_state())
        result = asyncio.run(
            run_agent(
                state=state,
                decide_next_action=decide_next_action,
                execute_tool=execute_tool,
            )
        )

        self.assertEqual(result["status"], "stopped")
        self.assertEqual(result["stopReason"]["code"], "failed")
        self.assertIn("不存在工具", result["stopReason"]["message"])

    def test_final_answer_after_completed_plan_finishes(self):
        decisions = [
            tool_call("query_metrics"),
            tool_call("query_logs"),
            tool_call("get_recent_deployments"),
            final_answer("最终结论"),
        ]

        async def decide_next_action(*, state):
            decision = decisions.pop(0)
            return {**decision, "usage": {"promptTokens": 1, "completionTokens": 1}}

        state = create_run_state(goal=GOAL, plan_state=create_plan_state())
        result = asyncio.run(
            run_agent(
                state=state,
                decide_next_action=decide_next_action,
                execute_tool=execute_tool,
            )
        )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["finalAnswer"], "最终结论")
