"""追踪辅助函数的离线测试，对齐 Node 版 trace.test.js。"""

from __future__ import annotations

import io
import unittest
from contextlib import redirect_stdout

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from agent_trace import message_text, print_main_messages, tool_result


class AgentTraceTests(unittest.TestCase):
    def test_message_text_accepts_string_and_text_blocks(self) -> None:
        self.assertEqual(message_text({"content": "完成"}), "完成")
        self.assertEqual(
            message_text({"content": [{"type": "text", "text": "报告"}, {"type": "image"}]}),
            "报告",
        )
        self.assertEqual(message_text(None), "")

    def test_direct_tool_result_matches_call_id(self) -> None:
        message = ToolMessage(content="世界观", name="read_file", tool_call_id="read-1")
        self.assertIs(tool_result(message, "read-1"), message)
        self.assertIsNone(tool_result(message, "wrong-id"))

    def test_task_command_extracts_matching_tool_message(self) -> None:
        message = ToolMessage(content="大纲已交付", name="task", tool_call_id="task-1")
        other = ToolMessage(content="其他", name="task", tool_call_id="other")
        command = Command(update={"messages": [message, other]})
        self.assertIs(tool_result(command, "task-1"), message)
        self.assertIsNone(tool_result(command, "wrong-id"))

    def test_print_main_messages_shows_only_supplied_history(self) -> None:
        messages = [
            HumanMessage(content="用户任务"),
            AIMessage(content="", tool_calls=[{
                "id": "task-1",
                "name": "task",
                "args": {"description": "设计剧情", "subagent_type": "plot-designer"},
            }]),
            ToolMessage(content="大纲已交付", name="task", tool_call_id="task-1"),
            AIMessage(content="已完成"),
        ]
        output = io.StringIO()
        with redirect_stdout(output):
            print_main_messages(messages)
        self.assertIn("HumanMessage：用户任务", output.getvalue())
        self.assertIn("AIMessage：调用 task", output.getvalue())
        self.assertIn("ToolMessage：task 返回结果", output.getvalue())


if __name__ == "__main__":
    unittest.main()
