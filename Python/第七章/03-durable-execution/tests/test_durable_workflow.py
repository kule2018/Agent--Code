from __future__ import annotations

import unittest

from langgraph.checkpoint.memory import MemorySaver

from workflow import create_presentation_workflow


class DurableWorkflowTest(unittest.TestCase):
    def test_failed_run_resumes_only_unfinished_node_with_same_thread_id(self):
        checkpointer = MemorySaver()
        config = {
            "configurable": {
                "thread_id": "durable-execution-test",
            }
        }
        should_fail = True

        graph = create_presentation_workflow(
            checkpointer=checkpointer,
            should_fail_save=lambda: should_fail,
        )

        with self.assertRaisesRegex(RuntimeError, "大纲存储服务暂时不可用"):
            graph.invoke(
                {
                    "presentationId": "PRESENTATION-TEST",
                },
                config,
            )

        failed_snapshot = graph.get_state(config)

        self.assertEqual(list(failed_snapshot.next), ["save_outline_draft"])
        self.assertEqual(
            failed_snapshot.values["executionPath"],
            [
                "prepare_requirements",
                "generate_outline",
            ],
        )

        should_fail = False
        result = graph.invoke(None, config)

        self.assertTrue(result["draftSaved"])
        self.assertEqual(
            result["executionPath"],
            [
                "prepare_requirements",
                "generate_outline",
                "save_outline_draft",
            ],
        )


if __name__ == "__main__":
    unittest.main()
