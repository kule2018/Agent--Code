"""用假模型验证委派边界、任务单原样传递和文件权限。"""

from __future__ import annotations

import asyncio
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from langchain.agents.middleware.types import ToolCallRequest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

import agents
import review_workflow


class ScriptedModel(BaseChatModel):
    replies: list[AIMessage]
    position: int = 0
    seen_messages: list[list[object]] = []

    @property
    def _llm_type(self) -> str:
        return "offline-review-model"

    def bind_tools(self, tools: object, **kwargs: object) -> ScriptedModel:
        return self

    def _generate(
        self,
        messages: object,
        stop: object = None,
        run_manager: object = None,
        **kwargs: object,
    ) -> ChatResult:
        if self.position >= len(self.replies):
            raise AssertionError("模型收到超出脚本预期的调用")
        self.seen_messages.append(list(messages))
        reply = self.replies[self.position]
        self.position += 1
        return ChatResult(generations=[ChatGeneration(message=reply)])


def tool_request(name: str, call_id: str, **args: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_boundary_overrides_description_and_rejects_second_call(self) -> None:
        assignment = {
            "assignee": "continuity-reviewer",
            "writeFiles": ["/reviews/review-1.json"],
            "acceptanceCriteria": ["原样引用正文"],
        }
        boundary = agents.DelegationBoundaryMiddleware("continuity-reviewer", assignment)
        request = ToolCallRequest(
            tool_call={
                "id": "task-1", "name": "task",
                "args": {"subagent_type": "continuity-reviewer", "description": "模型遗漏了限制"},
            },
            tool=None, state={}, runtime=None,
        )
        captured: list[dict] = []

        async def handler(modified: ToolCallRequest) -> ToolMessage:
            captured.append(modified.tool_call)
            return ToolMessage(content="完成", name="task", tool_call_id="task-1")

        with redirect_stdout(io.StringIO()):
            await boundary.awrap_tool_call(request, handler)
        self.assertTrue(boundary.dispatched)
        self.assertEqual(json.loads(captured[0]["args"]["description"]), assignment)
        self.assertEqual(request.tool_call["args"]["description"], "模型遗漏了限制")
        with self.assertRaisesRegex(RuntimeError, "只允许"):
            await boundary.awrap_tool_call(request, handler)

        wrong = agents.DelegationBoundaryMiddleware("continuity-reviewer", assignment)
        bad = request.override(tool_call={**request.tool_call, "name": "write_file"})
        with self.assertRaisesRegex(RuntimeError, "只允许"):
            await wrong.awrap_tool_call(bad, handler)

    async def test_unknown_role_is_rejected_before_agent_creation(self) -> None:
        with self.assertRaisesRegex(ValueError, "未知执行角色"):
            await agents.delegate_task(None, Path("/tmp"), {
                "assignee": "unknown", "writeFiles": [],
            })

    async def test_real_agent_graph_delegates_without_paid_api(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(review_workflow, "WORKSPACES_ROOT", Path(directory)):
                workspace = review_workflow.prepare_workspace()
            assignment = {
                "assignee": "continuity-reviewer",
                "goal": "只审核当前场景",
                "readFiles": ["/game/world.md", "/game/scenes/ending-b.json"],
                "writeFiles": ["/reviews/review-1.json"],
                "skillPath": "/skills/story-quality/SKILL.md",
                "acceptanceCriteria": ["只写报告，保持场景不变"],
            }
            report = json.dumps({"verdict": "approved", "issues": []}, ensure_ascii=False)
            model = ScriptedModel(replies=[
                tool_request(
                    "task", "task-1", subagent_type="continuity-reviewer",
                    description="模型写出的简化任务，不应传给子 Agent",
                ),
                tool_request("read_file", "read-skill", file_path=assignment["skillPath"]),
                tool_request("read_file", "read-world", file_path="/game/world.md"),
                tool_request("read_file", "read-scene", file_path="/game/scenes/ending-b.json"),
                tool_request("read_file", "read-schema", file_path="/contracts/review.schema.json"),
                # 故意尝试越权：权限层应拒绝写世界观。
                tool_request("write_file", "write-world", file_path="/game/world.md", content="越权覆盖"),
                tool_request("write_file", "write-report", file_path=assignment["writeFiles"][0], content=report),
                AIMessage(content="/reviews/review-1.json；0 个问题。"),
                AIMessage(content="已完成审核委派。"),
            ])
            world = workspace / "game" / "world.md"
            before = world.read_text(encoding="utf-8")
            output = io.StringIO()
            with redirect_stdout(output):
                await agents.delegate_task(model, workspace, assignment)

            self.assertEqual(model.position, 9)
            self.assertEqual(world.read_text(encoding="utf-8"), before)
            self.assertEqual(
                json.loads((workspace / "reviews" / "review-1.json").read_text(encoding="utf-8")),
                {"verdict": "approved", "issues": []},
            )
            child_input = model.seen_messages[1]
            child_requests = [message for message in child_input if isinstance(message, HumanMessage)]
            self.assertEqual(len(child_requests), 1)
            self.assertEqual(json.loads(child_requests[0].content), assignment)
            self.assertIn("[总导演] task → continuity-reviewer", output.getvalue())


if __name__ == "__main__":
    unittest.main()
