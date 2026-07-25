"""不经过大模型，直接验证企业售后 MCP Server。

文件作用：
验证角色权限、租户隔离、Tools、Resources、Prompts、
Human-in-the-Loop、幂等、长任务和 MCP App。

章节定位：【配套文件】

建议阅读：
建议运行并观察每组断言，理解如何把协议行为和业务行为变成
可重复验证的测试流程。
"""

from __future__ import annotations

import asyncio
import time
from contextlib import AsyncExitStack
from typing import Any

from mcp_client import create_after_sales_client, parse_tool_result


def title(text: str) -> None:
    """打印验证分组标题。"""

    print(f"\n================ {text} ================")


def assert_ok(condition: bool, message: str) -> None:
    """输出一条易于定位的验证断言。"""

    if not condition:
        raise AssertionError(f"验证失败：{message}")
    print(f"✓ {message}")


async def call(client: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """调用 Tool 并解析结构化结果。"""

    return parse_tool_result(await client.call_tool(name, arguments))


async def main() -> None:
    """连接三个身份，运行完整且不调用模型的验证流程。"""

    async with AsyncExitStack() as stack:
        service_client = await stack.enter_async_context(
            create_after_sales_client(token="token-blue-service")
        )
        finance_client = await stack.enter_async_context(
            create_after_sales_client(token="token-blue-finance")
        )
        star_client = await stack.enter_async_context(
            create_after_sales_client(token="token-star-service")
        )

        title("1. 能力发现与角色权限")
        service_tools = (await service_client.list_tools()).tools
        finance_tools = (await finance_client.list_tools()).tools
        assert_ok(
            any(tool.name == "preview_refund" for tool in service_tools),
            "客服可以发现退款预检 Tool",
        )
        assert_ok(
            not any(
                tool.name == "start_batch_refund_review"
                for tool in service_tools
            ),
            "客服看不到财务批量审核 Tool",
        )
        assert_ok(
            any(
                tool.name == "start_batch_refund_review"
                for tool in finance_tools
            ),
            "财务可以发现批量审核 Tool",
        )

        title("2. 同订单号下的租户隔离")
        blue_order = await call(
            service_client,
            "get_order_detail",
            {"orderId": "A1024"},
        )
        star_order = await call(
            star_client,
            "get_order_detail",
            {"orderId": "A1024"},
        )
        print("蓝鲸科技：", blue_order["order"]["productName"])
        print("星河零售：", star_order["order"]["productName"])
        assert_ok(
            blue_order["order"]["productName"]
            != star_order["order"]["productName"],
            "订单查询始终使用登录人的 tenantId",
        )

        title("3. Tool、Resource 与 Prompt")
        preview = await call(
            service_client,
            "preview_refund",
            {
                "orderId": "A1024",
                "reason": "商品不符合预期",
            },
        )
        print(preview)
        assert_ok(
            preview["preview"]["manualReview"] is True,
            "3000 元退款被确定性规则判定为人工审核",
        )

        policy = await service_client.read_resource(
            "after-sales://policies/refund-policy"
        )
        policy_text = policy.contents[0].text
        print(policy_text)
        assert_ok(
            "蓝鲸科技" in policy_text,
            "Resource 返回当前租户的规则",
        )

        prompt = await service_client.get_prompt(
            "handle_after_sales_case",
            {
                "orderId": "A1024",
                "customerQuestion": "可以退款吗？",
            },
        )
        assert_ok(len(prompt.messages) == 1, "Host 可以获取售后任务 Prompt")

        title("4. Human-in-the-Loop 与幂等退款")
        idempotency_key = f"course-refund-{time.time_ns()}"
        arguments = {
            "orderId": "A1024",
            "reason": "商品不符合预期",
            "idempotencyKey": idempotency_key,
        }
        first_refund = await call(
            service_client,
            "submit_refund_request",
            arguments,
        )
        second_refund = await call(
            service_client,
            "submit_refund_request",
            arguments,
        )
        print(first_refund)
        assert_ok(
            first_refund["refundRequest"]["refundId"]
            == second_refund["refundRequest"]["refundId"],
            "重复调用没有创建第二张退款单",
        )
        assert_ok(
            second_refund["duplicated"] is True,
            "第二次调用被识别为幂等重试",
        )

        title("5. 业务长任务")
        started = await call(
            finance_client,
            "start_batch_refund_review",
            {"orderIds": ["A1024", "A1025", "A1026"]},
        )
        job_id = started["job"]["jobId"]
        print("创建任务：", job_id)

        while True:
            await asyncio.sleep(0.5)
            snapshot = await call(
                finance_client,
                "get_batch_review_status",
                {"jobId": job_id},
            )
            print(
                f"[{snapshot['job']['progress']}%] "
                f"{snapshot['job']['message']}"
            )
            if snapshot["job"]["status"] != "working":
                break

        assert_ok(
            snapshot["job"]["status"] == "completed",
            "Client 通过 jobId 取回长任务结果",
        )
        for detail in snapshot["job"]["result"]["details"]:
            print(detail)

        title("6. MCP App")
        report_tool = next(
            (
                tool
                for tool in finance_tools
                if tool.name == "get_batch_review_report"
            ),
            None,
        )
        app_uri = (
            report_tool.meta.get("ui", {}).get("resourceUri")
            if report_tool and report_tool.meta
            else None
        )
        assert_ok(
            app_uri == "ui://after-sales/batch-review-report.html",
            "报告 Tool 声明了 MCP App Resource URI",
        )

        report = await call(
            finance_client,
            "get_batch_review_report",
            {"jobId": job_id},
        )
        assert_ok(
            report["job"]["result"]["total"] == 3,
            "报告 Tool 返回结构化审核数据",
        )

        app_resource = await finance_client.read_resource(app_uri)
        app_content = app_resource.contents[0]
        assert_ok(
            app_content.mime_type == "text/html;profile=mcp-app",
            "App Resource 使用 MCP Apps MIME Type",
        )
        assert_ok(
            "批量退款审核报告" in app_content.text,
            "App Resource 返回可独立运行的 HTML",
        )

        print("\n全部验证通过。")


if __name__ == "__main__":
    asyncio.run(main())
