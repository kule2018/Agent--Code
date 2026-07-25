"""命令行企业售后 Agent Host。

文件作用：
调用 DeepSeek、执行 MCP Tools、保存消息历史，并支持连续对话和
Human-in-the-Loop 人工确认。

章节定位：【本章重点】

建议阅读：
重点理解一轮 Tool Calling 循环、Tool Result 如何写回 messages，
以及为什么同一个 messages 列表能够支持连续对话。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Awaitable, Callable
from pprint import pprint
from typing import Any

from deepseek_client import MODEL, call_deepseek
from mcp_client import (
    create_after_sales_client,
    create_elicitation_handler,
    tool_result_text,
)

EXIT_COMMANDS = {"/exit", "/quit", "退出"}
ModelCaller = Callable[..., Awaitable[dict[str, Any]]]


# ==================== 对话历史初始化 ====================


def create_conversation_messages() -> list[dict[str, Any]]:
    """创建一段新的售后 Agent 对话历史。"""

    return [
        {
            "role": "system",
            "content": "\n".join(
                [
                    "你是企业售后 Agent。",
                    "订单、物流和规则必须通过工具查询，不能编造。",
                    "先调用只读工具核对事实，只有用户明确要求提交时才调用写操作。",
                ]
            ),
        }
    ]


# ==================== 单轮 Agent 与 Tool Calling 循环 ====================


async def run_agent_turn(
    *,
    question: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    client: Any,
    call_model: ModelCaller = call_deepseek,
    logger: Any = None,
) -> str | None:
    """处理一轮用户对话。

    一轮用户对话内部，模型可能连续调用多个 Tool。
    assistant 消息和 Tool Result 都会追加到同一个 messages 列表中。
    """

    output = logger or print
    messages.append({"role": "user", "content": question})

    # 最多执行 8 轮“调用模型 → 执行 Tool → 回传结果”。
    for _round in range(1, 9):
        assistant_message = await call_model(messages=messages, tools=tools)
        messages.append(assistant_message)

        tool_calls = assistant_message.get("tool_calls") or []
        if not tool_calls:
            content = assistant_message.get("content")
            output(f"\nAgent：{content}")
            return content

        for tool_call in tool_calls:
            function = tool_call["function"]
            arguments = json.loads(function.get("arguments") or "{}")

            output(f"\n[Tool] {function['name']}")
            pprint(arguments)

            result = await client.call_tool(
                function["name"],
                arguments,
            )
            content = tool_result_text(result)
            output(content)

            # 将 Tool Result 回传给模型，供下一轮生成继续使用。
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call["id"],
                    "content": content,
                }
            )

    raise RuntimeError("Agent 超过了单轮最大 Tool Calling 次数")


# ==================== 连续对话循环 ====================


async def run_conversation(
    *,
    initial_question: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    client: Any,
    question_reader: Callable[[str], str] = input,
    call_model: ModelCaller = call_deepseek,
    logger: Any = None,
) -> None:
    """持续读取用户输入，直到用户主动退出。

    messages 在整个循环中只创建一次，因此后续问题可以引用前文中的
    订单号、退款原因、模型回复和 Tool Result。
    """

    output = logger or print
    pending_question = initial_question.strip()

    while True:
        raw_input = pending_question
        pending_question = ""
        if not raw_input:
            raw_input = await asyncio.to_thread(question_reader, "\n用户：")

        question = raw_input.strip()
        if not question:
            continue

        if question.lower() in EXIT_COMMANDS:
            output("对话已结束。")
            return

        await run_agent_turn(
            question=question,
            messages=messages,
            tools=tools,
            client=client,
            call_model=call_model,
            logger=logger,
        )


# ==================== Host 启动入口 ====================


async def main() -> None:
    """连接 MCP Server 并启动连续对话 Host。"""

    initial_question = " ".join(sys.argv[1:]).strip()
    token = os.getenv("MCP_TOKEN", "token-blue-service")

    async with create_after_sales_client(
        token=token,
        auto_confirm=False,
        name="enterprise-after-sales-agent-host",
        elicitation_handler=create_elicitation_handler(
            auto_confirm=False,
            question_reader=input,
        ),
    ) as client:
        listed = await client.list_tools()
        mcp_tools = listed.tools

        # MCP 使用 inputSchema；模型 Function Calling 使用 parameters。
        tools = [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                },
            }
            for tool in mcp_tools
        ]

        # messages 只在 Host 启动时创建一次，后续所有轮次持续追加。
        messages = create_conversation_messages()

        print(f"Host 已连接 MCP Server，模型：{MODEL}")
        print(f"当前身份可发现 {len(mcp_tools)} 个 Tools。")
        print("现在可以连续提问，输入 /exit、/quit 或“退出”结束对话。")

        await run_conversation(
            initial_question=initial_question,
            messages=messages,
            tools=tools,
            client=client,
        )


if __name__ == "__main__":
    asyncio.run(main())
