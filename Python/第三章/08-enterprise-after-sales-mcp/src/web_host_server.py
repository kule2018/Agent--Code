"""启动浏览器版 Web Host 和独立 MCP App Sandbox。

文件作用：
代理 DeepSeek 与 MCP 请求，并为 MCP App 提供受控的跨 Origin
渲染环境。

章节定位：【本章重点】

建议阅读：
重点理解浏览器为什么不直接持有模型密钥、Elicitation 如何转交页面，
以及 Web Host 与 Sandbox 为什么运行在不同 Origin。
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

import uvicorn
from mcp_types import (
    CallToolResult,
    ElicitRequest,
    ElicitResult,
    InputRequiredResult,
)
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from starlette.routing import Route

from deepseek_client import MODEL, call_deepseek
from mcp_client import create_after_sales_client

HOST_NAME = "127.0.0.1"
STATIC_DIRECTORY = Path(__file__).resolve().parent / "web_host"
MAX_BODY_BYTES = 1024 * 1024


# ==================== Web Host HTTP 基础能力 ====================


async def read_json_body(request: Request) -> dict[str, Any]:
    """读取不超过 1 MB 的 JSON Object 请求体。"""

    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise ValueError("请求体超过 1 MB 限制")

    parsed = json.loads(body or b"{}")
    if not isinstance(parsed, dict):
        raise ValueError("请求体必须是 JSON Object")
    return parsed


def to_wire(value: Any) -> Any:
    """把 MCP Pydantic 对象转换为使用协议字段名的 JSON 数据。"""

    if hasattr(value, "model_dump"):
        return value.model_dump(
            by_alias=True,
            exclude_none=True,
            mode="json",
        )
    return value


def error_response(error: Exception, status_code: int = 500) -> JSONResponse:
    """返回不泄露凭证的统一错误结果。"""

    return JSONResponse({"error": str(error)}, status_code=status_code)


def safe_static_path(path: str) -> Path | None:
    """阻止通过 ../ 等路径读取静态目录之外的文件。"""

    relative = path or "index.html"
    candidate = (STATIC_DIRECTORY / relative).resolve()
    root = STATIC_DIRECTORY.resolve()
    if candidate != root and root not in candidate.parents:
        return None
    return candidate if candidate.is_file() else None


# ==================== MCP App Sandbox 安全策略 ====================


def sanitize_csp_domains(value: Any) -> list[str]:
    """只保留不会破坏 CSP Header 结构的域名文本。"""

    if not isinstance(value, list):
        return []
    return [
        item
        for item in value
        if isinstance(item, str)
        and not any(character in item for character in ";\r\n'\" ")
    ]


def build_sandbox_csp(csp: dict[str, Any] | None = None) -> str:
    """按 MCP App Resource 声明生成 Sandbox Content-Security-Policy。"""

    config = csp or {}
    resources = " ".join(sanitize_csp_domains(config.get("resourceDomains")))
    connects = " ".join(sanitize_csp_domains(config.get("connectDomains")))
    frames = " ".join(sanitize_csp_domains(config.get("frameDomains")))
    bases = " ".join(sanitize_csp_domains(config.get("baseUriDomains")))

    return "; ".join(
        [
            "default-src 'self' 'unsafe-inline'",
            (
                "script-src 'self' 'unsafe-inline' 'unsafe-eval' "
                f"blob: data: {resources}"
            ).strip(),
            f"style-src 'self' 'unsafe-inline' blob: data: {resources}".strip(),
            f"img-src 'self' data: blob: {resources}".strip(),
            f"font-src 'self' data: blob: {resources}".strip(),
            f"connect-src 'self' {connects}".strip(),
            f"frame-src {frames}" if frames else "frame-src 'none'",
            "object-src 'none'",
            f"base-uri {bases}" if bases else "base-uri 'none'",
        ]
    )


# ==================== Python 层 MCP Client 代理 ====================


def _elicitation_details(
    result: InputRequiredResult,
) -> tuple[str, str]:
    """读取 input_required 中第一条表单确认请求。"""

    for request_id, request in (result.input_requests or {}).items():
        if isinstance(request, ElicitRequest):
            return request_id, request.params.message
    raise RuntimeError("Server 请求了额外输入，但没有提供 Elicitation 表单")


async def call_mcp_tool(
    *,
    token: str,
    name: str,
    arguments: dict[str, Any],
    decision: str,
) -> dict[str, Any]:
    """调用 MCP Tool，并把两轮确认流程转换成 Web 页面可处理的数据。"""

    async with create_after_sales_client(
        token=token,
        auto_confirm=True,
        name="enterprise-after-sales-web-host",
    ) as client:
        # 这里绕过 Client 自动驱动，先观察原始 InputRequiredResult。
        # Web Host 需要把确认问题返回浏览器，等待用户点击后再发第二次请求。
        first = await client.session.call_tool(
            name,
            arguments,
            allow_input_required=True,
        )

        if not isinstance(first, InputRequiredResult):
            if not isinstance(first, CallToolResult):
                raise RuntimeError("MCP Tool 返回了不支持的结果类型")
            return {"kind": "result", "result": to_wire(first)}

        request_id, message = _elicitation_details(first)
        if decision == "prompt":
            return {"kind": "elicitation", "message": message}
        if decision not in {"accept", "decline"}:
            raise ValueError("decision 必须是 prompt、accept 或 decline")

        answer = (
            ElicitResult(action="accept", content={"confirm": True})
            if decision == "accept"
            else ElicitResult(action="decline")
        )
        second = await client.session.call_tool(
            name,
            arguments,
            input_responses={request_id: answer},
            request_state=first.request_state,
            allow_input_required=True,
        )

        if not isinstance(second, CallToolResult):
            raise RuntimeError("用户确认后，MCP Tool 仍未返回最终结果")
        return {"kind": "result", "result": to_wire(second)}


# ==================== 浏览器 Web Host 服务 ====================


def create_host_app(*, sandbox_port: int) -> Starlette:
    """创建连接前端、模型和 MCP Server 的 Web Host。"""

    async def config(_request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "sandboxUrl": f"http://{HOST_NAME}:{sandbox_port}/sandbox.html",
                "model": MODEL,
            }
        )

    async def list_tools(request: Request) -> JSONResponse:
        try:
            body = await read_json_body(request)
            token = body.get("token")
            if not isinstance(token, str):
                raise ValueError("token 必须是字符串")

            async with create_after_sales_client(
                token=token,
                name="enterprise-after-sales-web-host",
            ) as client:
                return JSONResponse(to_wire(await client.list_tools()))
        except Exception as error:  # noqa: BLE001 - HTTP 边界统一返回错误
            return error_response(error)

    async def call_tool(request: Request) -> JSONResponse:
        try:
            body = await read_json_body(request)
            token = body.get("token")
            name = body.get("name")
            arguments = body.get("arguments")
            decision = body.get("decision", "prompt")

            if not isinstance(token, str) or not isinstance(name, str):
                raise ValueError("token 和 name 必须是字符串")
            if not isinstance(arguments, dict):
                raise ValueError("arguments 必须是 JSON Object")
            if not isinstance(decision, str):
                raise ValueError("decision 必须是字符串")

            result = await call_mcp_tool(
                token=token,
                name=name,
                arguments=arguments,
                decision=decision,
            )
            return JSONResponse(result)
        except Exception as error:  # noqa: BLE001
            return error_response(error)

    async def read_resource(request: Request) -> JSONResponse:
        try:
            body = await read_json_body(request)
            token = body.get("token")
            uri = body.get("uri")
            if not isinstance(token, str) or not isinstance(uri, str):
                raise ValueError("token 和 uri 必须是字符串")

            async with create_after_sales_client(
                token=token,
                name="enterprise-after-sales-web-host",
            ) as client:
                return JSONResponse(to_wire(await client.read_resource(uri)))
        except Exception as error:  # noqa: BLE001
            return error_response(error)

    async def call_model(request: Request) -> JSONResponse:
        try:
            body = await read_json_body(request)
            messages = body.get("messages")
            tools = body.get("tools")
            if not isinstance(messages, list) or not isinstance(tools, list):
                raise ValueError("messages 和 tools 必须是数组")

            message = await call_deepseek(messages=messages, tools=tools)
            return JSONResponse({"message": message})
        except Exception as error:  # noqa: BLE001
            return error_response(error)

    async def static_file(request: Request) -> Response:
        path = request.path_params.get("path", "")
        if path == "sandbox.html" or path == "sandbox.js":
            return PlainTextResponse("Not Found", status_code=404)

        file_path = safe_static_path(path)
        if file_path is None:
            return PlainTextResponse("Not Found", status_code=404)
        return FileResponse(
            file_path,
            headers={"X-Content-Type-Options": "nosniff"},
        )

    return Starlette(
        routes=[
            Route("/api/config", config, methods=["GET"]),
            Route("/api/mcp/tools", list_tools, methods=["POST"]),
            Route("/api/mcp/call", call_tool, methods=["POST"]),
            Route("/api/mcp/resource", read_resource, methods=["POST"]),
            Route("/api/model", call_model, methods=["POST"]),
            Route("/{path:path}", static_file, methods=["GET"]),
        ]
    )


# ==================== 独立 Origin Sandbox 服务 ====================


def create_sandbox_app() -> Starlette:
    """创建只提供 Sandbox 页面与脚本的独立 Origin。"""

    async def sandbox_file(request: Request) -> Response:
        requested = request.path_params.get("path", "")
        path = "sandbox.html" if requested in {"", "sandbox.html"} else requested

        if path not in {"sandbox.html", "sandbox.js"}:
            return PlainTextResponse("Not Found", status_code=404)

        file_path = safe_static_path(path)
        if file_path is None:
            return PlainTextResponse("Not Found", status_code=404)

        headers = {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        }
        if path == "sandbox.html":
            csp: dict[str, Any] = {}
            raw_csp = request.query_params.get("csp")
            if raw_csp:
                try:
                    parsed = json.loads(raw_csp)
                    if isinstance(parsed, dict):
                        csp = parsed
                except json.JSONDecodeError:
                    # 无效配置使用最严格的默认 CSP。
                    pass
            headers["Content-Security-Policy"] = build_sandbox_csp(csp)

        return FileResponse(file_path, headers=headers)

    return Starlette(
        routes=[
            Route("/{path:path}", sandbox_file, methods=["GET"]),
        ]
    )


async def serve() -> None:
    """在同一个 Python 进程中启动 Web Host 与 Sandbox 两个 Origin。"""

    host_port = int(os.getenv("WEB_HOST_PORT", "3200"))
    sandbox_port = int(os.getenv("WEB_SANDBOX_PORT", "3201"))

    host_server = uvicorn.Server(
        uvicorn.Config(
            create_host_app(sandbox_port=sandbox_port),
            host=HOST_NAME,
            port=host_port,
            log_level="warning",
        )
    )
    sandbox_server = uvicorn.Server(
        uvicorn.Config(
            create_sandbox_app(),
            host=HOST_NAME,
            port=sandbox_port,
            log_level="warning",
        )
    )

    print(f"MCP Apps Web Host：http://{HOST_NAME}:{host_port}")
    print(f"MCP Apps Sandbox：http://{HOST_NAME}:{sandbox_port}")
    await asyncio.gather(host_server.serve(), sandbox_server.serve())


if __name__ == "__main__":
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        # 用户按 Ctrl+C 停止两个本地服务时安静退出，
        # 不把 asyncio 的取消堆栈误显示成运行错误。
        pass
