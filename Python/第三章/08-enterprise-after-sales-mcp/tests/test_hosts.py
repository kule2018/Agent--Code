"""CLI Agent、模型请求和 Web Host 辅助逻辑的离线测试。"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from agent_host import (  # noqa: E402
    create_conversation_messages,
    run_agent_turn,
)
from deepseek_client import call_deepseek  # noqa: E402
from web_host_server import build_sandbox_csp  # noqa: E402


class HostTest(unittest.IsolatedAsyncioTestCase):
    """验证连续历史和 DeepSeek 请求字段，不访问真实 API。"""

    async def test_two_turns_share_the_same_message_history(self) -> None:
        messages = create_conversation_messages()
        snapshots: list[list[dict[str, Any]]] = []
        replies = iter(["第一轮完成", "第二轮读取到了前文"])

        async def fake_model(**kwargs: Any) -> dict[str, Any]:
            snapshots.append([dict(item) for item in kwargs["messages"]])
            return {"role": "assistant", "content": next(replies)}

        class FakeClient:
            async def call_tool(self, *_args: Any, **_kwargs: Any) -> None:
                raise AssertionError("本测试不应调用 Tool")

        await run_agent_turn(
            question="订单 A1024 可以退款吗？",
            messages=messages,
            tools=[],
            client=FakeClient(),
            call_model=fake_model,
            logger=lambda _message: None,
        )
        await run_agent_turn(
            question="它现在的物流到哪里了？",
            messages=messages,
            tools=[],
            client=FakeClient(),
            call_model=fake_model,
            logger=lambda _message: None,
        )

        self.assertEqual(
            [item["role"] for item in snapshots[1]],
            ["system", "user", "assistant", "user"],
        )
        self.assertEqual(
            snapshots[1][1]["content"],
            "订单 A1024 可以退款吗？",
        )

    async def test_deepseek_request_uses_api_key_not_mcp_token(self) -> None:
        captured: dict[str, Any] = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            captured["authorization"] = request.headers["authorization"]
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "测试完成",
                            }
                        }
                    ]
                },
            )

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            message = await call_deepseek(
                messages=[{"role": "user", "content": "你好"}],
                tools=[],
                api_key="test-deepseek-key",
                api_url="https://example.test/chat/completions",
                model="test-model",
                http_client=client,
            )

        self.assertEqual(captured["authorization"], "Bearer test-deepseek-key")
        self.assertEqual(captured["body"]["model"], "test-model")
        self.assertEqual(captured["body"]["thinking"], {"type": "disabled"})
        self.assertEqual(message["content"], "测试完成")

    def test_sandbox_csp_rejects_header_injection(self) -> None:
        csp = build_sandbox_csp(
            {
                "connectDomains": [
                    "https://api.example.com",
                    "https://bad.example.com; frame-src *",
                ]
            }
        )

        self.assertIn("https://api.example.com", csp)
        self.assertNotIn("bad.example.com", csp)
        self.assertIn("object-src 'none'", csp)


if __name__ == "__main__":
    unittest.main()
