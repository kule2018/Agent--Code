"""离线验证 Skill 发现、工具调用、写权限和剧情交付。"""

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

import skill_agent


class ScriptedModel(BaseChatModel):
    """逐条返回预设工具请求，不向真实模型发送请求。"""

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


def tool_request(name: str, file_path: str, call_id: str, **args: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{
            "name": name,
            "args": {"file_path": file_path, **args},
            "id": call_id,
        }],
    )


def make_workspace(directory: str) -> Path:
    """只复制本小节已知的三份公开教学资源。"""

    workspace = Path(directory) / "workspace"
    for relative in (
        "game/world.md",
        "skills/branch-story-design/SKILL.md",
        "skills/branch-story-design/references/outline-template.md",
    ):
        target = workspace / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            (skill_agent.WORKSPACE_DIR / relative).read_text(encoding="utf-8"),
            encoding="utf-8",
        )
    return workspace


class SkillAgentTests(unittest.IsolatedAsyncioTestCase):
    def test_tool_calls_are_matched_by_id_and_failed_read_is_not_loaded(self) -> None:
        request = tool_request("read_file", skill_agent.SKILL_PATH, "read-1")
        wrong_reply = ToolMessage(
            content="Error: permission denied",
            name="read_file",
            tool_call_id="read-2",
            status="error",
        )
        calls = skill_agent.collect_tool_calls([request, wrong_reply])
        self.assertEqual(calls[0]["path"], skill_agent.SKILL_PATH)
        self.assertFalse(calls[0]["ok"])

        right_reply = ToolMessage(
            content="Skill 正文",
            name="read_file",
            tool_call_id="read-1",
            status="success",
        )
        self.assertTrue(skill_agent.collect_tool_calls([request, right_reply])[0]["ok"])

    def test_verify_story_accepts_python_write_reply_and_existing_file_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            outline = workspace / "game" / "branch-outline.md"
            outline.parent.mkdir()
            outline.write_text("# 剧情分支大纲\n", encoding="utf-8")
            saved_call = {
                "name": "write_file", "path": skill_agent.OUTPUT_PATH,
                "ok": True, "text": f"Updated file {skill_agent.OUTPUT_PATH}",
            }
            self.assertEqual(
                skill_agent.verify_story([saved_call], workspace),
                (outline, "# 剧情分支大纲\n", True),
            )

            read_call = {
                "name": "read_file", "path": skill_agent.OUTPUT_PATH,
                "ok": True, "text": "1  # 剧情分支大纲",
            }
            self.assertEqual(skill_agent.verify_story([read_call], workspace)[2], False)
            with self.assertRaisesRegex(RuntimeError, "没有保存或复核"):
                skill_agent.verify_story([], workspace)

            outline.write_text(" \n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "大纲文件为空"):
                skill_agent.verify_story([saved_call], workspace)

    async def test_chat_discovers_skill_without_reading_its_body(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = make_workspace(directory)
            model = ScriptedModel(replies=[AIMessage(content="5")])
            output = io.StringIO()
            with (
                patch.dict(os.environ, {"DEEPSEEK_API_KEY": "offline-test-key"}),
                patch.object(skill_agent, "WORKSPACE_DIR", workspace),
                patch.object(skill_agent, "ChatDeepSeek", return_value=model) as model_class,
                redirect_stdout(output),
            ):
                await skill_agent.run("chat")

            self.assertEqual(model.position, 1)
            self.assertIn("发现的 Skill： branch-story-design", output.getvalue())
            self.assertIn("本次工具调用：\n无", output.getvalue())
            self.assertIn("本轮是否读取 Skill 正文：否", output.getvalue())
            self.assertIn("本轮是否读取 大纲模板：否", output.getvalue())
            prompt = "\n".join(skill_agent.message_text(message) for message in model.seen_messages[0])
            self.assertIn("branch-story-design", prompt)
            self.assertNotIn("# 分支剧情设计", prompt)
            self.assertFalse((workspace / "game" / "branch-outline.md").exists())
            model_class.assert_called_once_with(
                model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
                temperature=0,
                max_retries=1,
                timeout=120,
            )

    async def test_story_reads_skill_and_template_then_writes_outline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = make_workspace(directory)
            outline_text = "# 剧情分支大纲\n\n## 选择 A\n保供氧。\n\n## 选择 B\n保供水。\n"
            model = ScriptedModel(replies=[
                tool_request("read_file", skill_agent.SKILL_PATH, "read-skill"),
                tool_request("read_file", "/game/world.md", "read-world"),
                tool_request("read_file", skill_agent.TEMPLATE_PATH, "read-template"),
                tool_request("write_file", skill_agent.OUTPUT_PATH, "write-outline", content=outline_text),
                tool_request("read_file", skill_agent.OUTPUT_PATH, "read-outline"),
                AIMessage(content="大纲已保存；两个选择的代价不同。"),
            ])
            output = io.StringIO()
            world_before = (workspace / "game" / "world.md").read_text(encoding="utf-8")
            with (
                patch.dict(os.environ, {"DEEPSEEK_API_KEY": "offline-test-key"}),
                patch.object(skill_agent, "WORKSPACE_DIR", workspace),
                patch.object(skill_agent, "ChatDeepSeek", return_value=model),
                redirect_stdout(output),
            ):
                await skill_agent.run("story")

            self.assertEqual(model.position, 6)
            self.assertEqual((workspace / "game" / "branch-outline.md").read_text(encoding="utf-8"), outline_text)
            self.assertEqual((workspace / "game" / "world.md").read_text(encoding="utf-8"), world_before)
            self.assertIn("本轮是否读取 Skill 正文：是", output.getvalue())
            self.assertIn("本轮是否读取 大纲模板：是", output.getvalue())
            self.assertIn("write_file /game/branch-outline.md：成功", output.getvalue())

    async def test_story_cannot_modify_world_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = make_workspace(directory)
            world_path = workspace / "game" / "world.md"
            before = world_path.read_text(encoding="utf-8")
            model = ScriptedModel(replies=[
                tool_request("write_file", "/game/world.md", "write-world", content="错误覆盖"),
                AIMessage(content="未修改世界观。"),
            ])
            output = io.StringIO()
            with (
                patch.dict(os.environ, {"DEEPSEEK_API_KEY": "offline-test-key"}),
                patch.object(skill_agent, "WORKSPACE_DIR", workspace),
                patch.object(skill_agent, "ChatDeepSeek", return_value=model),
                redirect_stdout(output),
            ):
                await skill_agent.run("chat")

            self.assertEqual(model.position, 2)
            self.assertIn("write_file /game/world.md：失败", output.getvalue())
            self.assertEqual(world_path.read_text(encoding="utf-8"), before)

    async def test_existing_outline_can_be_updated_with_edit_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = make_workspace(directory)
            outline = workspace / "game" / "branch-outline.md"
            outline.write_text("# 剧情分支大纲\n旧结局\n", encoding="utf-8")
            model = ScriptedModel(replies=[
                tool_request("read_file", skill_agent.OUTPUT_PATH, "read-old"),
                tool_request(
                    "edit_file", skill_agent.OUTPUT_PATH, "edit-outline",
                    old_string="旧结局", new_string="新结局",
                ),
                tool_request("read_file", skill_agent.OUTPUT_PATH, "read-new"),
                AIMessage(content="已更新大纲。"),
            ])
            output = io.StringIO()
            with (
                patch.dict(os.environ, {"DEEPSEEK_API_KEY": "offline-test-key"}),
                patch.object(skill_agent, "WORKSPACE_DIR", workspace),
                patch.object(skill_agent, "ChatDeepSeek", return_value=model),
                redirect_stdout(output),
            ):
                await skill_agent.run("story")

            self.assertEqual(model.position, 4)
            self.assertEqual(outline.read_text(encoding="utf-8"), "# 剧情分支大纲\n新结局\n")
            self.assertIn("edit_file /game/branch-outline.md：成功", output.getvalue())
            self.assertNotIn("本轮只读取了已有大纲", output.getvalue())


if __name__ == "__main__":
    unittest.main()
