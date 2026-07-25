"""创建企业售后 MCP Client。

文件作用：
配置现代协议协商、Elicitation 和 Bearer Token 认证，并提供统一的
Tool Result 解析函数。

章节定位：【本章重点】

建议阅读：
重点理解 Streamable HTTP Transport、MCP_TOKEN 的发送位置，以及
Client 如何把 Server 返回的 input_required 转交给用户确认回调。
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
from mcp import Client
from mcp.client import ClientRequestContext
from mcp.client.streamable_http import streamable_http_client
from mcp_types import (
    CallToolResult,
    ElicitRequestParams,
    ElicitResult,
    Implementation,
    TextContent,
)

QuestionReader = Callable[[str], str]
ElicitationHandler = Callable[
    [ClientRequestContext, ElicitRequestParams],
    Awaitable[ElicitResult],
]


def create_elicitation_handler(
    *,
    auto_confirm: bool,
    question_reader: QuestionReader = input,
) -> ElicitationHandler:
    """创建命令行或自动验证使用的 Elicitation 处理器。"""

    async def handle_elicitation(
        context: ClientRequestContext,
        params: ElicitRequestParams,
    ) -> ElicitResult:
        del context

        if auto_confirm:
            print(f"\n[Human-in-the-Loop] {params.message}")
            return ElicitResult(
                action="accept",
                content={"confirm": True},
            )

        # input() 是同步函数，放到线程中避免阻塞 MCP 异步会话。
        answer = await asyncio.to_thread(
            question_reader,
            f"{params.message}（y/n）：",
        )
        if answer.strip().lower() == "y":
            return ElicitResult(
                action="accept",
                content={"confirm": True},
            )
        return ElicitResult(action="decline")

    return handle_elicitation


@asynccontextmanager
async def create_after_sales_client(
    *,
    token: str,
    auto_confirm: bool = True,
    name: str = "enterprise-after-sales-client",
    server_url: str | None = None,
    elicitation_handler: ElicitationHandler | None = None,
) -> AsyncIterator[Client]:
    """创建并连接售后 MCP Client，退出上下文时自动释放连接。"""

    resolved_server_url = server_url or os.getenv(
        "MCP_SERVER_URL",
        "http://127.0.0.1:3100/mcp",
    )
    callback = elicitation_handler or create_elicitation_handler(
        auto_confirm=auto_confirm
    )

    # MCP Token 只发送给售后 MCP Server。
    # 它与调用模型 API 使用的 DEEPSEEK_API_KEY 是两套独立凭证。
    async with httpx.AsyncClient(
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    ) as http_client:
        transport = streamable_http_client(
            resolved_server_url,
            http_client=http_client,
        )

        async with Client(
            transport,
            client_info=Implementation(name=name, version="1.0.0"),
            mode="auto",
            elicitation_callback=callback,
        ) as client:
            yield client


def parse_tool_result(result: CallToolResult) -> dict[str, Any]:
    """优先解析 structuredContent，否则读取第一段 JSON 文本。"""

    if isinstance(result.structured_content, dict):
        return result.structured_content

    text_block = next(
        (
            content
            for content in result.content
            if isinstance(content, TextContent)
        ),
        None,
    )
    if text_block is None:
        raise RuntimeError("Tool 没有返回可解析的结果")

    parsed = json.loads(text_block.text)
    if not isinstance(parsed, dict):
        raise ValueError("Tool 返回的 JSON 不是对象")
    return parsed


def tool_result_text(result: CallToolResult) -> str:
    """读取 Tool 返回给大模型的文本内容。"""

    text_block = next(
        (
            content
            for content in result.content
            if isinstance(content, TextContent)
        ),
        None,
    )
    if text_block is not None:
        return text_block.text
    return json.dumps(
        result.structured_content or {},
        ensure_ascii=False,
    )
