"""用脚本化模型离线验证真实 Deep Agents 委派与文件交付流程。"""

from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

import story_team
from agent_trace import Trace


class ScriptedModel(BaseChatModel):
    """顺序返回预设工具调用；不会连接 DeepSeek。"""

    replies: list[AIMessage]
    position: int = 0
    seen_messages: list[list[object]] = []

    @property
    def _llm_type(self) -> str:
        return "offline-scripted-model"

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


def make_workspace(directory: str) -> Path:
    """仅复制本小节已知的三份公开教学资源到临时工作区。"""

    workspace = Path(directory) / "workspace"
    for relative in (
        "game/world.md",
        "skills/branch-story-design/SKILL.md",
        "skills/branch-story-design/references/outline-template.md",
    ):
        target = workspace / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            (story_team.WORKSPACE_DIR / relative).read_text(encoding="utf-8"),
            encoding="utf-8",
        )
    return workspace


class StoryTeamTests(unittest.IsolatedAsyncioTestCase):
    def test_verify_run_rejects_missing_read_or_leaked_child_message(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            output_file = workspace / "game" / "branch-outline.md"
            output_file.parent.mkdir()
            output_file.write_text("# 大纲\n", encoding="utf-8")
            trace = Trace(calls=[
                {
                    "actor": "story-director", "id": "task-1", "name": "task",
                    "args": {"subagent_type": "plot-designer"}, "ok": True, "text": "报告",
                },
                *[
                    {
                        "actor": "plot-designer", "id": f"read-{index}", "name": "read_file",
                        "args": {"file_path": path}, "ok": True, "text": "已读取",
                    }
                    for index, path in enumerate(story_team.REQUIRED_READS)
                ],
            ])
            result = {"messages": [AIMessage(content="已交付")]}
            with redirect_stdout(io.StringIO()):
                self.assertEqual(story_team.verify_run(result, trace, workspace)[0], output_file)

            trace.calls[-1]["ok"] = False
            with self.assertRaisesRegex(RuntimeError, "没有成功读取"):
                story_team.verify_run(result, trace, workspace)
            trace.calls[-1]["ok"] = True

            trace.calls[0]["ok"] = False
            with self.assertRaisesRegex(RuntimeError, "没有完成预期的剧情设计师委派"):
                story_team.verify_run(result, trace, workspace)
            trace.calls[0]["ok"] = True

            leaked = {"messages": [ToolMessage(
                content="内部工具结果", name="read_file", tool_call_id="read-0",
            )]}
            with self.assertRaisesRegex(RuntimeError, "内部工具结果"):
                story_team.verify_run(leaked, trace, workspace)

            output_file.write_text(" \n", encoding="utf-8")
            with redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "交付文件为空"):
                    story_team.verify_run(result, trace, workspace)

    async def test_director_delegates_to_isolated_designer_and_delivers_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = make_workspace(directory)
            outline = "# 剧情分支大纲\n\n## 选择 A\n保供氧。\n\n## 选择 B\n保供水。\n"
            model = ScriptedModel(replies=[
                tool_request(
                    "task", "task-1", description=story_team.USER_TASK,
                    subagent_type="plot-designer",
                ),
                tool_request(
                    "read_file", "read-skill",
                    file_path="/skills/branch-story-design/SKILL.md",
                ),
                tool_request(
                    "read_file", "read-template",
                    file_path="/skills/branch-story-design/references/outline-template.md",
                ),
                tool_request("read_file", "read-world", file_path="/game/world.md"),
                tool_request(
                    "write_file", "write-outline",
                    file_path=story_team.OUTPUT_PATH, content=outline,
                ),
                tool_request("read_file", "read-outline", file_path=story_team.OUTPUT_PATH),
                AIMessage(content="/game/branch-outline.md：A 保供氧，B 保供水。"),
                AIMessage(content="大纲已交付：/game/branch-outline.md，两个分支代价不同。"),
            ])
            trace = Trace()
            output = io.StringIO()
            world_before = (workspace / "game" / "world.md").read_text(encoding="utf-8")
            create_agent = story_team.create_deep_agent
            with (
                patch.dict(os.environ, {"DEEPSEEK_API_KEY": "offline-test-key"}),
                patch.object(story_team, "WORKSPACE_DIR", workspace),
                patch.object(story_team, "ChatDeepSeek", return_value=model) as model_class,
                patch.object(story_team, "Trace", return_value=trace),
                patch.object(story_team, "create_deep_agent", wraps=create_agent) as create,
                redirect_stdout(output),
            ):
                await story_team.run()

            self.assertEqual(model.position, 8)
            self.assertEqual((workspace / "game" / "branch-outline.md").read_text(encoding="utf-8"), outline)
            self.assertEqual((workspace / "game" / "world.md").read_text(encoding="utf-8"), world_before)
            self.assertIn("story-director", trace.inputs)
            self.assertIn("plot-designer", trace.inputs)
            self.assertEqual(len(trace.inputs["plot-designer"]), 1)
            self.assertEqual(trace.inputs["plot-designer"][0]["content"], story_team.USER_TASK)
            self.assertIn("[story-director] 调用 task", output.getvalue())
            self.assertIn("[plot-designer] 调用 read_file /game/world.md", output.getvalue())
            self.assertIn("子 Agent 的内部 ToolMessage 是否进入总导演 messages：否", output.getvalue())
            self.assertEqual(create.call_args.kwargs["name"], "story-director")
            director_permissions = create.call_args.kwargs["permissions"]
            self.assertEqual(director_permissions[0].mode, "deny")
            self.assertEqual(director_permissions[0].paths, ["/**"])
            child = create.call_args.kwargs["subagents"][0]
            self.assertEqual(child["name"], "plot-designer")
            self.assertEqual(child["mode"], "isolated")
            self.assertEqual(child["skills"], ["/skills/"])
            self.assertEqual(child["permissions"][0].paths, [story_team.OUTPUT_PATH])
            self.assertEqual(child["permissions"][1].mode, "deny")
            model_class.assert_called_once_with(
                model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
                temperature=0, max_retries=1, timeout=120,
            )


if __name__ == "__main__":
    unittest.main()
