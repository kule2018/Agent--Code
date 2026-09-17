import unittest

from langgraph.checkpoint.memory import MemorySaver

from workflow import (
    Command,
    create_review_workflow,
    get_pending_review,
    validate_review_submission,
)


def create_test_runtime(name: str):
    checkpointer = MemorySaver()
    graph = create_review_workflow(checkpointer=checkpointer)
    config = {
        "configurable": {
            "thread_id": name,
        },
    }

    return graph, config


def start_review(graph, config):
    graph.invoke({"presentationId": "PRESENTATION-TEST"}, config)
    return graph.get_state(config)


class ReviewWorkflowTest(unittest.TestCase):
    def test_approve_current_outline_starts_page_production(self):
        graph, config = create_test_runtime("approve-test")
        snapshot = start_review(graph, config)
        pending_review = get_pending_review(snapshot)

        self.assertEqual(pending_review["outlineVersion"], 1)

        decision = validate_review_submission(
            snapshot,
            {
                "presentationId": "PRESENTATION-TEST",
                "outlineVersion": 1,
                "action": "approve",
                "feedback": None,
            },
        )

        result = graph.invoke(Command(resume=decision), config)

        self.assertEqual(result["reviewStatus"], "approved")
        self.assertEqual(result["pageProductionStarted"], True)

    def test_revise_generates_new_outline_and_pauses_again(self):
        graph, config = create_test_runtime("revise-test")
        first_snapshot = start_review(graph, config)
        decision = validate_review_submission(
            first_snapshot,
            {
                "presentationId": "PRESENTATION-TEST",
                "outlineVersion": 1,
                "action": "revise",
                "feedback": "补充风险控制方案",
            },
        )

        graph.invoke(Command(resume=decision), config)
        second_snapshot = graph.get_state(config)
        pending_review = get_pending_review(second_snapshot)

        self.assertEqual(second_snapshot.values["outline"]["version"], 2)
        self.assertEqual(second_snapshot.values["reviewStatus"], "pending")
        self.assertEqual(pending_review["outlineVersion"], 2)
        self.assertEqual(second_snapshot.next, ("review_outline",))

    def test_reject_outline_ends_task(self):
        graph, config = create_test_runtime("reject-test")
        snapshot = start_review(graph, config)
        decision = validate_review_submission(
            snapshot,
            {
                "presentationId": "PRESENTATION-TEST",
                "outlineVersion": 1,
                "action": "reject",
                "feedback": None,
            },
        )

        result = graph.invoke(Command(resume=decision), config)

        self.assertEqual(result["reviewStatus"], "rejected")
        self.assertEqual(result.get("pageProductionStarted", False), False)

    def test_stale_outline_version_cannot_resume_workflow(self):
        graph, config = create_test_runtime("stale-test")
        snapshot = start_review(graph, config)

        with self.assertRaisesRegex(ValueError, "审核版本已经过期"):
            validate_review_submission(
                snapshot,
                {
                    "presentationId": "PRESENTATION-TEST",
                    "outlineVersion": 0,
                    "action": "approve",
                    "feedback": None,
                },
            )


if __name__ == "__main__":
    unittest.main()
