"""启动企业售后 MCP Streamable HTTP Server。

文件作用：
启动 MCP HTTP Server，完成 Bearer Token 鉴权，并提供健康检查接口。

章节定位：【本章重点】

建议阅读：
重点理解 HTTP 鉴权发生在 MCP Handler 之前，以及身份如何通过
认证上下文传递给动态能力发现和 Tool 执行逻辑。
"""

from __future__ import annotations

import os
from typing import Any

import uvicorn
from mcp.server.auth.settings import AuthSettings
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from auth import CourseTokenVerifier
from mcp_server import create_after_sales_mcp_server


async def health(_request: Request) -> JSONResponse:
    """健康检查只表示进程正常，不需要业务身份。"""

    return JSONResponse(
        {
            "ok": True,
            "service": "enterprise-after-sales-mcp",
        }
    )


def create_http_app() -> Any:
    """创建带 Bearer Token 鉴权的 Streamable HTTP ASGI 应用。"""

    server = create_after_sales_mcp_server()

    # Python SDK 的 TokenVerifier 会在 MCP Handler 前校验 Authorization。
    # Tool 内部只能读取已经验证过的身份，不能信任调用参数中的 tenantId。
    return server.streamable_http_app(
        streamable_http_path="/mcp",
        json_response=False,
        stateless_http=True,
        host="127.0.0.1",
        auth=AuthSettings(
            issuer_url="http://127.0.0.1:3100",
            resource_server_url="http://127.0.0.1:3100/mcp",
            required_scopes=[],
        ),
        token_verifier=CourseTokenVerifier(),
        custom_starlette_routes=[Route("/health", health, methods=["GET"])],
    )


app = create_http_app()


def main() -> None:
    """读取端口并启动本地课程服务。"""

    port = int(os.getenv("PORT", "3100"))
    print(f"企业售后 MCP Server：http://127.0.0.1:{port}/mcp")
    print(f"健康检查：http://127.0.0.1:{port}/health")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
