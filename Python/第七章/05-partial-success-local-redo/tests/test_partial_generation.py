"""部分成功、局部重做与版本校验的离线测试。"""

from __future__ import annotations

import unittest
from typing import Any

from langgraph.checkpoint.memory import MemorySaver

from workflow import create_partial_generation_workflow


def create_test_runtime(name: str) -> tuple[Any, dict[str, Any]]:
    """为每个测试创建隔离的内存 Checkpoint。"""

    graph = create_partial_generation_workflow(checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": name}}
    return graph, config


def start(graph: Any, config: dict[str, Any]) -> Any:
    """执行第一次生成，并返回最新 State。"""

    graph.invoke(
        {"presentationId": "PRESENTATION-TEST", "operation": "initial"},
        config,
    )
    return graph.get_state(config)


def invoke_existing(
    graph: Any,
    config: dict[str, Any],
    operation: str,
    **extra: Any,
) -> Any:
    """在上一轮持久化 State 的基础上发起新操作。"""

    snapshot = graph.get_state(config)
    return graph.invoke(
        {
            **snapshot.values,
            "operation": operation,
            "targetPageId": None,
            "changeRequest": None,
            **extra,
        },
        config,
    )


class PartialGenerationWorkflowTests(unittest.TestCase):
    def test_first_run_keeps_successful_pages_and_marks_page_three_failed(self) -> None:
        graph, config = create_test_runtime("partial-success")
        snapshot = start(graph, config)
        page_three = next(
            task
            for task in snapshot.values["pageTasks"]
            if task["pageId"] == "page-3"
        )

        self.assertEqual(snapshot.values["runStatus"], "partially_completed")
        self.assertEqual(len(snapshot.values["artifacts"]), 3)
        self.assertEqual(page_three["status"], "failed")

    def test_continue_only_regenerates_failed_page(self) -> None:
        graph, config = create_test_runtime("continue-failed")
        snapshot = start(graph, config)
        page_one_attempts = snapshot.values["pageTasks"][0]["attempts"]

        invoke_existing(graph, config, "continue")
        snapshot = graph.get_state(config)

        self.assertEqual(snapshot.values["runStatus"], "completed")
        self.assertEqual(
            snapshot.values["pageTasks"][0]["attempts"], page_one_attempts
        )
        self.assertEqual(snapshot.values["pageTasks"][2]["attempts"], 2)
        self.assertEqual(len(snapshot.values["artifacts"]), 4)

    def test_revising_one_page_only_generates_a_new_revision_for_that_page(self) -> None:
        graph, config = create_test_runtime("revise-page")
        start(graph, config)
        invoke_existing(graph, config, "continue")
        snapshot = graph.get_state(config)
        original_artifact_id = snapshot.values["pageTasks"][1]["currentArtifactId"]

        invoke_existing(
            graph,
            config,
            "revise_page",
            targetPageId="page-2",
            changeRequest="调整第二页重点",
        )
        snapshot = graph.get_state(config)
        revised_page = snapshot.values["pageTasks"][1]

        self.assertEqual(revised_page["pageRevision"], 2)
        self.assertNotEqual(revised_page["currentArtifactId"], original_artifact_id)
        self.assertEqual(len(snapshot.values["artifacts"]), 5)
        self.assertEqual(snapshot.values["pageTasks"][0]["attempts"], 1)
        revised_artifact = next(
            artifact
            for artifact in snapshot.values["artifacts"]
            if artifact["artifactId"] == revised_page["currentArtifactId"]
        )
        self.assertEqual(revised_artifact["content"], "课程方案：调整第二页重点")

    def test_export_rejects_mixed_outline_versions_until_missing_pages_are_regenerated(
        self,
    ) -> None:
        graph, config = create_test_runtime("version-check")
        start(graph, config)
        invoke_existing(graph, config, "continue")
        invoke_existing(graph, config, "publish_outline")
        invoke_existing(graph, config, "export")

        snapshot = graph.get_state(config)
        self.assertFalse(snapshot.values["exportResult"]["ok"])
        self.assertEqual(snapshot.values["runStatus"], "export_blocked")

        invoke_existing(graph, config, "continue")
        invoke_existing(graph, config, "export")
        snapshot = graph.get_state(config)

        self.assertTrue(snapshot.values["exportResult"]["ok"])
        self.assertEqual(snapshot.values["runStatus"], "exported")
        self.assertEqual(len(snapshot.values["exportResult"]["artifactIds"]), 4)


if __name__ == "__main__":
    unittest.main()
