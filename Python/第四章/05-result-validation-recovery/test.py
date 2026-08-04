"""和 Node test.js 对齐的轻量验证入口。"""

import asyncio

from recovery_runtime import run_recovery_agent


async def main():
    retry_fallback = await run_recovery_agent(
        scenario_name="retry-fallback",
        silent=True,
    )
    assert retry_fallback["status"] == "completed"
    assert [item["strategy"] for item in retry_fallback["recoveryEvents"]] == [
        "retry",
        "fallback",
    ]
    assert retry_fallback["usage"]["toolAttempts"] == 3
    assert retry_fallback["usage"]["toolResponses"] == 1
    assert retry_fallback["usage"]["validatedObservations"] == 1
    assert retry_fallback["planState"]["steps"][0]["resolvedBy"] == "query_backup_logs"

    replan = await run_recovery_agent(
        scenario_name="replan",
        silent=True,
    )
    assert replan["status"] == "completed"
    assert replan["planState"]["version"] == 2
    assert replan["usage"]["toolResponses"] == 2
    assert replan["usage"]["validatedObservations"] == 1
    assert [step["status"] for step in replan["planState"]["steps"]] == [
        "cancelled",
        "completed",
    ]

    handoff = await run_recovery_agent(
        scenario_name="handoff",
        silent=True,
    )
    assert handoff["status"] == "waiting_for_human"
    assert handoff["stopReason"]["code"] == "human_handoff"
    assert handoff["handoff"]["reasonCode"] == "RUNTIME_VERSION_CONFLICT"
    assert len(handoff["handoff"]["evidenceKeys"]) == 2

    print("三组结果校验与失败恢复实验验证通过。")


if __name__ == "__main__":
    asyncio.run(main())
