import asyncio
import unittest

from incident_tools import ToolExecutionError, create_tool_executor
from recovery_policy import calculate_backoff_ms, select_recovery
from recovery_runtime import execute_action_with_recovery, run_recovery_agent
from recovery_state import create_recovery_state
from result_validator import (
    classify_tool_error,
    validate_evidence_set,
    validate_observation,
)


SERVICE_ARGUMENTS = {"serviceName": "payment-service"}


def action(tool_name, extra=None):
    result = {
        "toolName": tool_name,
        "arguments": SERVICE_ARGUMENTS,
    }

    if extra:
        result.update(extra)

    return result


class ToolExecutorTest(unittest.TestCase):
    def test_retry_fallback_primary_logs_always_timeout(self):
        execute_tool = create_tool_executor("retry-fallback")

        with self.assertRaises(ToolExecutionError) as first:
            asyncio.run(execute_tool(action("query_primary_logs")))
        with self.assertRaises(ToolExecutionError) as second:
            asyncio.run(execute_tool(action("query_primary_logs")))

        self.assertEqual(first.exception.code, "UPSTREAM_TIMEOUT")
        self.assertEqual(second.exception.code, "UPSTREAM_TIMEOUT")
        self.assertIn("第 1 次", str(first.exception))
        self.assertIn("第 2 次", str(second.exception))

    def test_replan_primary_logs_returns_empty_records(self):
        execute_tool = create_tool_executor("replan")
        observation = asyncio.run(execute_tool(action("query_primary_logs")))

        self.assertTrue(observation["ok"])
        self.assertEqual(observation["source"], "primary_logs")
        self.assertEqual(observation["data"]["records"], [])

    def test_handoff_tools_return_conflicting_versions(self):
        execute_tool = create_tool_executor("handoff")
        logs = asyncio.run(execute_tool(action("query_primary_logs")))
        inventory = asyncio.run(execute_tool(action("query_instance_inventory")))

        self.assertEqual(logs["data"]["runtimeVersion"], "v2.4.1")
        self.assertEqual(inventory["data"]["activeVersion"], "v2.4.0")


class ResultValidatorTest(unittest.TestCase):
    def test_validate_observation_rejects_malformed_missing_and_empty_records(self):
        malformed = validate_observation(action("query_primary_logs"), None)
        missing_records = validate_observation(
            action("query_primary_logs"),
            {"ok": True, "data": {"summary": "missing"}},
        )
        empty_records = validate_observation(
            action("query_primary_logs"),
            {"ok": True, "data": {"records": []}},
        )

        self.assertEqual(malformed["failure"]["code"], "MALFORMED_RESULT")
        self.assertEqual(missing_records["failure"]["code"], "MISSING_RECORDS")
        self.assertEqual(empty_records["failure"]["code"], "EMPTY_RESULT")

    def test_validate_evidence_set_detects_runtime_version_conflict(self):
        execute_tool = create_tool_executor("handoff")
        logs = asyncio.run(execute_tool(action("query_primary_logs")))
        inventory = asyncio.run(execute_tool(action("query_instance_inventory")))

        validation = validate_evidence_set([logs, inventory])

        self.assertFalse(validation["ok"])
        self.assertEqual(validation["failure"]["kind"], "evidence_conflict")
        self.assertEqual(validation["failure"]["code"], "RUNTIME_VERSION_CONFLICT")
        self.assertEqual(
            validation["failure"]["details"]["evidenceKeys"],
            ["primary_logs:payment-service", "instance_inventory:payment-service"],
        )

    def test_classify_tool_error(self):
        timeout = ToolExecutionError("UPSTREAM_TIMEOUT", "timeout", {"retryable": True})
        unexpected = ToolExecutionError("TOOL_NOT_FOUND", "missing")

        self.assertEqual(classify_tool_error(timeout)["kind"], "transient_error")
        self.assertEqual(classify_tool_error(timeout)["details"], {"retryable": True})
        self.assertEqual(classify_tool_error(unexpected)["kind"], "unexpected_error")


class RecoveryPolicyTest(unittest.TestCase):
    def test_retry_fallback_replan_and_handoff_decisions(self):
        failure = {
            "kind": "transient_error",
            "code": "UPSTREAM_TIMEOUT",
            "message": "timeout",
            "details": {},
        }
        retry_action = action(
            "query_primary_logs",
            {
                "recovery": {
                    "maxRetries": 1,
                    "retryDelayMs": 20,
                    "fallbackAction": action("query_backup_logs"),
                }
            },
        )

        retry = select_recovery(failure=failure, action=retry_action, retry_count=0)
        fallback = select_recovery(failure=failure, action=retry_action, retry_count=1)
        replan = select_recovery(
            failure={
                "kind": "no_evidence",
                "code": "EMPTY_RESULT",
                "message": "empty",
                "details": {},
            },
            action=action(
                "query_primary_logs",
                {
                    "recovery": {
                        "replanTitle": "改用调用链追踪定位失败节点",
                        "replanAction": action("query_traces"),
                    }
                },
            ),
            retry_count=0,
        )
        handoff = select_recovery(
            failure={
                "kind": "unexpected_error",
                "code": "UNEXPECTED_ERROR",
                "message": "unknown",
                "details": {},
            },
            action=action("query_primary_logs"),
            retry_count=0,
        )

        self.assertEqual(retry, {"strategy": "retry", "delayMs": 20})
        self.assertEqual(fallback["strategy"], "fallback")
        self.assertEqual(fallback["nextAction"]["toolName"], "query_backup_logs")
        self.assertEqual(replan["strategy"], "replan")
        self.assertEqual(replan["replacementStep"]["id"], "query_primary_logs-replacement")
        self.assertEqual(handoff["strategy"], "human_handoff")

    def test_calculate_backoff_ms(self):
        self.assertEqual(calculate_backoff_ms(20, 0), 20)
        self.assertEqual(calculate_backoff_ms(20, 2), 80)


class RecoveryRuntimeTest(unittest.TestCase):
    def test_retry_fallback_scenario(self):
        retry_fallback = asyncio.run(
            run_recovery_agent(scenario_name="retry-fallback", silent=True)
        )

        self.assertEqual(retry_fallback["status"], "completed")
        self.assertEqual(
            [item["strategy"] for item in retry_fallback["recoveryEvents"]],
            ["retry", "fallback"],
        )
        self.assertEqual(retry_fallback["usage"]["toolAttempts"], 3)
        self.assertEqual(retry_fallback["usage"]["toolResponses"], 1)
        self.assertEqual(retry_fallback["usage"]["validatedObservations"], 1)
        self.assertEqual(
            retry_fallback["planState"]["steps"][0]["resolvedBy"],
            "query_backup_logs",
        )

    def test_replan_scenario(self):
        replan = asyncio.run(run_recovery_agent(scenario_name="replan", silent=True))

        self.assertEqual(replan["status"], "completed")
        self.assertEqual(replan["planState"]["version"], 2)
        self.assertEqual(replan["usage"]["toolResponses"], 2)
        self.assertEqual(replan["usage"]["validatedObservations"], 1)
        self.assertEqual(
            [step["status"] for step in replan["planState"]["steps"]],
            ["cancelled", "completed"],
        )
        self.assertEqual(
            replan["planState"]["steps"][1]["action"]["toolName"],
            "query_traces",
        )

    def test_handoff_scenario(self):
        handoff = asyncio.run(run_recovery_agent(scenario_name="handoff", silent=True))

        self.assertEqual(handoff["status"], "waiting_for_human")
        self.assertEqual(handoff["planState"]["status"], "waiting_for_human")
        self.assertEqual(handoff["stopReason"]["code"], "human_handoff")
        self.assertEqual(handoff["handoff"]["reasonCode"], "RUNTIME_VERSION_CONFLICT")
        self.assertEqual(len(handoff["handoff"]["evidenceKeys"]), 2)
        self.assertEqual(
            [item["strategy"] for item in handoff["recoveryEvents"]],
            ["human_handoff"],
        )

    def test_execute_action_with_recovery_returns_handoff_for_unexpected_error(self):
        state = create_recovery_state("handoff")
        step = state["planState"]["steps"][0]
        step["action"]["toolName"] = "missing_tool"

        result = asyncio.run(
            execute_action_with_recovery(
                state=state,
                step=step,
                execute_tool=create_tool_executor("handoff"),
                log=lambda *args: None,
            )
        )

        self.assertEqual(result["type"], "human_handoff")
        self.assertEqual(result["failure"]["code"], "TOOL_NOT_FOUND")
        self.assertEqual(state["recoveryEvents"][0]["strategy"], "human_handoff")

    def test_unknown_scenario_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "不存在实验"):
            create_recovery_state("missing")
