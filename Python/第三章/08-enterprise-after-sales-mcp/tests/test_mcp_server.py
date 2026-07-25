"""企业售后 MCP 协议层离线测试。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from mcp import Client  # noqa: E402
from mcp.client import ClientRequestContext  # noqa: E402
from mcp_types import (  # noqa: E402
    ElicitRequestParams,
    ElicitResult,
    InputRequiredResult,
)

from after_sales_service import reset_demo_state  # noqa: E402
from data import PRINCIPALS_BY_TOKEN  # noqa: E402
from mcp_client import parse_tool_result  # noqa: E402
from mcp_server import (  # noqa: E402
    APP_MIME_TYPE,
    APP_URI,
    RequestStateCodec,
    create_after_sales_mcp_server,
)


async def accept_elicitation(
    context: ClientRequestContext,
    params: ElicitRequestParams,
) -> ElicitResult:
    """离线测试自动同意 Server 发起的确认请求。"""

    del context, params
    return ElicitResult(action="accept", content={"confirm": True})


class McpServerTest(unittest.IsolatedAsyncioTestCase):
    """验证角色发现、MRTR、requestState 与 MCP App。"""

    def setUp(self) -> None:
        reset_demo_state()
        self.service = PRINCIPALS_BY_TOKEN["token-blue-service"]
        self.finance = PRINCIPALS_BY_TOKEN["token-blue-finance"]

    async def test_role_tools_human_confirmation_and_app_resource(self) -> None:
        service_server = create_after_sales_mcp_server(
            principal_provider=lambda: self.service
        )
        async with Client(
            service_server,
            elicitation_callback=accept_elicitation,
        ) as client:
            tools = (await client.list_tools()).tools
            self.assertEqual(len(tools), 5)
            self.assertNotIn(
                "start_batch_refund_review",
                {tool.name for tool in tools},
            )

            result = await client.call_tool(
                "submit_refund_request",
                {
                    "orderId": "A1024",
                    "reason": "商品质量不行",
                    "idempotencyKey": "offline-refund-001",
                },
            )
            parsed = parse_tool_result(result)
            self.assertTrue(parsed["ok"])
            self.assertEqual(parsed["refundRequest"]["status"], "manual_review")

        finance_server = create_after_sales_mcp_server(
            principal_provider=lambda: self.finance
        )
        async with Client(
            finance_server,
            elicitation_callback=accept_elicitation,
        ) as client:
            tools = (await client.list_tools()).tools
            self.assertEqual(len(tools), 9)
            report_tool = next(
                tool for tool in tools if tool.name == "get_batch_review_report"
            )
            self.assertEqual(report_tool.meta["ui"]["resourceUri"], APP_URI)

            resource = await client.read_resource(APP_URI)
            self.assertEqual(resource.contents[0].mime_type, APP_MIME_TYPE)
            self.assertIn("ui/initialize", resource.contents[0].text)

    async def test_tampered_request_state_is_rejected(self) -> None:
        server = create_after_sales_mcp_server(
            principal_provider=lambda: self.service
        )
        arguments = {
            "orderId": "A1024",
            "reason": "商品质量不行",
            "idempotencyKey": "offline-refund-002",
        }

        async with Client(server) as client:
            first = await client.session.call_tool(
                "submit_refund_request",
                arguments,
                allow_input_required=True,
            )
            self.assertIsInstance(first, InputRequiredResult)

            tampered = f"{first.request_state[:-1]}x"
            second = await client.session.call_tool(
                "submit_refund_request",
                arguments,
                input_responses={
                    "confirm-refund": ElicitResult(
                        action="accept",
                        content={"confirm": True},
                    )
                },
                request_state=tampered,
                allow_input_required=True,
            )
            parsed = parse_tool_result(second)
            self.assertEqual(
                parsed["error"]["code"],
                "INVALID_REQUEST_STATE",
            )

    def test_request_state_expires_and_is_bound_to_client(self) -> None:
        now = 1000.0
        codec = RequestStateCodec(
            key="test-secret",
            ttl_seconds=300,
            clock=lambda: now,
        )
        token = codec.mint({"operation": "demo"}, self.service)

        self.assertEqual(
            codec.verify(token, self.service),
            {"operation": "demo"},
        )
        self.assertIsNone(codec.verify(token, self.finance))

        expired_codec = RequestStateCodec(
            key="test-secret",
            ttl_seconds=300,
            clock=lambda: now + 301,
        )
        self.assertIsNone(expired_codec.verify(token, self.service))


if __name__ == "__main__":
    unittest.main()
