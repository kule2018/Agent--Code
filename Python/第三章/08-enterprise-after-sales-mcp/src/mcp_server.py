"""注册企业售后 MCP Server 的 Tools、Resources、Prompts 和 MCP App。

文件作用：
注册企业售后 MCP Server 的全部协议能力，并根据当前登录角色决定
Client 能够发现和调用哪些能力。

章节定位：【本章重点】

建议阅读：
这是本节最核心的文件。重点理解能力发现、角色权限、
Human-in-the-Loop、requestState、业务长任务和 MCP App Resource。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from mcp.server import Server, ServerRequestContext
from mcp_types import (
    CallToolRequestParams,
    CallToolResult,
    ElicitRequest,
    ElicitRequestFormParams,
    ElicitResult,
    GetPromptRequestParams,
    GetPromptResult,
    InputRequiredResult,
    ListPromptsResult,
    ListResourcesResult,
    ListToolsResult,
    PaginatedRequestParams,
    Prompt,
    PromptArgument,
    PromptMessage,
    ReadResourceRequestParams,
    ReadResourceResult,
    Resource,
    TextContent,
    TextResourceContents,
    Tool,
    ToolAnnotations,
)

from after_sales_service import (
    cancel_batch_review,
    get_audit_logs,
    get_job_snapshot,
    get_logistics,
    get_order,
    get_policy,
    get_refund_by_idempotency_key,
    preview_refund,
    search_policies,
    start_batch_review,
    submit_refund,
)
from auth import current_principal

APP_URI = "ui://after-sales/batch-review-report.html"
APP_MIME_TYPE = "text/html;profile=mcp-app"
DEFAULT_REQUEST_STATE_SECRET = "course-demo-request-state-secret-2026-change-me"
SOURCE_DIRECTORY = Path(__file__).resolve().parent


# ==================== MCP Tool 定义 ====================

COMMON_TOOLS = [
    Tool(
        name="get_order_detail",
        title="查询订单详情",
        description="根据订单号查询当前企业的订单详情",
        inputSchema={
            "type": "object",
            "properties": {
                "orderId": {
                    "type": "string",
                    "description": "订单号，例如 A1024",
                }
            },
            "required": ["orderId"],
            "additionalProperties": False,
        },
        annotations=ToolAnnotations(
            readOnlyHint=True,
            idempotentHint=True,
        ),
    ),
    Tool(
        name="get_logistics_trace",
        title="查询物流轨迹",
        description="根据订单号查询当前企业的物流轨迹",
        inputSchema={
            "type": "object",
            "properties": {"orderId": {"type": "string"}},
            "required": ["orderId"],
            "additionalProperties": False,
        },
        annotations=ToolAnnotations(
            readOnlyHint=True,
            idempotentHint=True,
        ),
    ),
    Tool(
        name="search_after_sales_policy",
        title="检索售后规则",
        description="根据用户问题检索当前企业的售后规则",
        inputSchema={
            "type": "object",
            "properties": {"query": {"type": "string", "minLength": 1}},
            "required": ["query"],
            "additionalProperties": False,
        },
        annotations=ToolAnnotations(
            readOnlyHint=True,
            idempotentHint=True,
        ),
    ),
    Tool(
        name="preview_refund",
        title="退款预检",
        description="只做退款资格和人工审核判断，不会创建退款申请",
        inputSchema={
            "type": "object",
            "properties": {
                "orderId": {"type": "string"},
                "reason": {"type": "string", "minLength": 2},
            },
            "required": ["orderId", "reason"],
            "additionalProperties": False,
        },
        annotations=ToolAnnotations(
            # 提示 Host 和模型，该 Tool 属于只读操作。
            readOnlyHint=True,
            # 重复调用不会产生重复写入或其他额外副作用。
            idempotentHint=True,
        ),
    ),
    Tool(
        name="submit_refund_request",
        title="提交退款申请",
        description="经用户确认后创建退款申请，相同幂等键不会重复创建",
        inputSchema={
            "type": "object",
            "properties": {
                "orderId": {"type": "string"},
                "reason": {"type": "string", "minLength": 2},
                "idempotencyKey": {
                    "type": "string",
                    "minLength": 8,
                    "description": "调用方生成的唯一幂等键",
                },
            },
            "required": ["orderId", "reason", "idempotencyKey"],
            "additionalProperties": False,
        },
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=True,
        ),
    ),
]

FINANCE_TOOLS = [
    Tool(
        name="start_batch_refund_review",
        title="启动批量退款审核",
        description="经确认后创建批量退款审核后台任务，并立即返回 jobId",
        inputSchema={
            "type": "object",
            "properties": {
                "orderIds": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": 20,
                }
            },
            "required": ["orderIds"],
            "additionalProperties": False,
        },
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=True,
        ),
    ),
    Tool(
        name="get_batch_review_status",
        title="查询批量审核状态",
        description="根据 jobId 查询后台审核任务的进度和结果",
        inputSchema={
            "type": "object",
            "properties": {"jobId": {"type": "string"}},
            "required": ["jobId"],
            "additionalProperties": False,
        },
        annotations=ToolAnnotations(
            readOnlyHint=True,
            idempotentHint=True,
        ),
    ),
    Tool(
        name="cancel_batch_review",
        title="取消批量审核",
        description="取消尚未执行完成的批量退款审核任务",
        inputSchema={
            "type": "object",
            "properties": {"jobId": {"type": "string"}},
            "required": ["jobId"],
            "additionalProperties": False,
        },
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=True,
        ),
    ),
    Tool(
        name="get_batch_review_report",
        title="查看批量审核报告",
        description="读取已完成的批量审核结果，并使用 MCP App 展示报告",
        inputSchema={
            "type": "object",
            "properties": {"jobId": {"type": "string"}},
            "required": ["jobId"],
            "additionalProperties": False,
        },
        annotations=ToolAnnotations(
            readOnlyHint=True,
            idempotentHint=True,
        ),
        _meta={"ui": {"resourceUri": APP_URI}},
    ),
]


# ==================== requestState 签名与校验 ====================


def _base64url_encode(raw: bytes) -> str:
    """生成没有补位等号的 URL-safe Base64。"""

    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    """解析没有补位等号的 URL-safe Base64。"""

    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


class RequestStateCodec:
    """使用 HMAC 保护跨轮请求状态，避免确认信息被篡改或复用。"""

    def __init__(
        self,
        *,
        key: str,
        ttl_seconds: int = 300,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._key = key.encode("utf-8")
        self._ttl_seconds = ttl_seconds
        self._clock = clock

    def mint(
        self,
        data: dict[str, Any],
        principal: dict[str, Any],
    ) -> str:
        """签发只对当前 Client 有效、5 分钟后过期的 requestState。"""

        payload = {
            "data": data,
            "clientId": principal["userId"],
            "method": "tools/call",
            "expiresAt": int(self._clock()) + self._ttl_seconds,
        }
        encoded_payload = _base64url_encode(
            json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        )
        signature = hmac.new(
            self._key,
            encoded_payload.encode("ascii"),
            hashlib.sha256,
        ).digest()
        return f"{encoded_payload}.{_base64url_encode(signature)}"

    def verify(
        self,
        token: str | None,
        principal: dict[str, Any],
    ) -> dict[str, Any] | None:
        """验证签名、有效期、请求方法和当前 Client 绑定关系。"""

        if not token:
            return None

        try:
            encoded_payload, encoded_signature = token.split(".", 1)
            expected_signature = hmac.new(
                self._key,
                encoded_payload.encode("ascii"),
                hashlib.sha256,
            ).digest()
            supplied_signature = _base64url_decode(encoded_signature)

            if not hmac.compare_digest(expected_signature, supplied_signature):
                return None

            payload = json.loads(_base64url_decode(encoded_payload))
        except (ValueError, TypeError, json.JSONDecodeError):
            return None

        if (
            not isinstance(payload, dict)
            or payload.get("method") != "tools/call"
            or payload.get("clientId") != principal["userId"]
            or not isinstance(payload.get("expiresAt"), int)
            or payload["expiresAt"] < int(self._clock())
            or not isinstance(payload.get("data"), dict)
        ):
            return None

        return payload["data"]


def create_request_state_codec() -> RequestStateCodec:
    """从进程环境读取签名密钥；未配置时使用课程演示默认值。"""

    return RequestStateCodec(
        key=os.getenv("REQUEST_STATE_SECRET", DEFAULT_REQUEST_STATE_SECRET),
        ttl_seconds=300,
    )


# ==================== MCP 统一返回与输入校验 ====================


def json_result(data: dict[str, Any], is_error: bool = False) -> CallToolResult:
    """同时返回结构化数据和便于阅读的 JSON 文本。"""

    return CallToolResult(
        isError=is_error,
        structuredContent=data,
        content=[
            TextContent(
                text=json.dumps(data, ensure_ascii=False, indent=2),
            )
        ],
    )


def business_result(result: dict[str, Any]) -> CallToolResult:
    """把业务层统一结果转换成 MCP Tool Result。"""

    return json_result(result, is_error=result.get("ok") is False)


def cancelled_result(message: str) -> CallToolResult:
    """创建用户取消敏感操作时的统一错误。"""

    return json_result(
        {
            "ok": False,
            "error": {"code": "USER_CANCELLED", "message": message},
        },
        is_error=True,
    )


def invalid_state_result(message: str) -> CallToolResult:
    """创建 requestState 无效时的统一错误。"""

    return json_result(
        {
            "ok": False,
            "error": {
                "code": "INVALID_REQUEST_STATE",
                "message": message,
            },
        },
        is_error=True,
    )


def _required_string(
    arguments: dict[str, Any],
    key: str,
    *,
    min_length: int = 0,
) -> str:
    """复现 Node/Zod 对必填字符串和最短长度的边界校验。"""

    value = arguments.get(key)
    if not isinstance(value, str) or len(value) < min_length:
        suffix = f"，长度至少为 {min_length}" if min_length else ""
        raise ValueError(f"{key} 必须是字符串{suffix}")
    return value


def _required_order_ids(arguments: dict[str, Any]) -> list[str]:
    """校验 1～20 个批量审核订单编号。"""

    value = arguments.get("orderIds")
    if (
        not isinstance(value, list)
        or not 1 <= len(value) <= 20
        or any(not isinstance(item, str) for item in value)
    ):
        raise ValueError("orderIds 必须是包含 1～20 个字符串的数组")
    return list(value)


def _accepted_confirmation(
    params: CallToolRequestParams,
    request_id: str,
) -> tuple[str | None, bool | None]:
    """读取 Client 对指定 Elicitation 请求的动作与确认内容。"""

    response = (params.input_responses or {}).get(request_id)
    if not isinstance(response, ElicitResult):
        return None, None

    if response.action != "accept":
        return response.action, None

    content = response.content
    confirm = content.get("confirm") if isinstance(content, dict) else None
    if not isinstance(confirm, bool):
        raise ValueError("confirm 响应必须包含布尔值")
    return response.action, confirm


def _confirmation_required(
    *,
    request_id: str,
    message: str,
    request_state: str,
) -> InputRequiredResult:
    """返回 MCP 2.0 input_required，让 Host 收集用户确认后自动重试。"""

    return InputRequiredResult(
        requestState=request_state,
        inputRequests={
            request_id: ElicitRequest(
                params=ElicitRequestFormParams(
                    message=message,
                    requestedSchema={
                        "type": "object",
                        "properties": {
                            "confirm": {
                                "type": "boolean",
                            }
                        },
                        "required": ["confirm"],
                    },
                )
            )
        },
    )


def _available_tools(principal: dict[str, Any]) -> list[Tool]:
    """根据角色返回当前 Client 可以发现的 Tools。"""

    tools = list(COMMON_TOOLS)
    if principal["role"] == "finance":
        tools.extend(FINANCE_TOOLS)
    return tools


def load_app_html() -> str:
    """将分离的 HTML、CSS、JS 合成为可独立返回的 MCP App Resource。"""

    app_directory = SOURCE_DIRECTORY / "app"
    template = (app_directory / "report.html").read_text(encoding="utf-8")
    style = (app_directory / "style.css").read_text(encoding="utf-8")
    script = (app_directory / "main.js").read_text(encoding="utf-8")
    return template.replace("/*__APP_STYLE__*/", style).replace(
        "/*__APP_SCRIPT__*/",
        script,
    )


# ==================== MCP Server 工厂 ====================


def create_after_sales_mcp_server(
    *,
    principal_provider: Callable[[], dict[str, Any]] = current_principal,
    app_html: str | None = None,
    request_state_codec: RequestStateCodec | None = None,
) -> Server:
    """创建企业售后 MCP Server。

    HTTP 正常运行时从认证上下文读取 principal；离线测试可以注入固定
    principal，从而不需要启动 HTTP 或处理真实凭证。
    """

    resolved_app_html = app_html if app_html is not None else load_app_html()
    codec = request_state_codec or create_request_state_codec()

    async def list_tools(
        context: ServerRequestContext,
        params: PaginatedRequestParams | None,
    ) -> ListToolsResult:
        """按当前角色暴露 MCP Tools。"""

        del context, params
        return ListToolsResult(tools=_available_tools(principal_provider()))

    async def call_tool(
        context: ServerRequestContext,
        params: CallToolRequestParams,
    ) -> CallToolResult | InputRequiredResult:
        """执行售后 Tool，并处理两种 Human-in-the-Loop 写操作。"""

        del context
        principal = principal_provider()
        available_names = {tool.name for tool in _available_tools(principal)}

        if params.name not in available_names:
            return json_result(
                {
                    "ok": False,
                    "error": {
                        "code": "TOOL_NOT_FOUND",
                        "message": f"当前身份不能调用 Tool：{params.name}",
                    },
                },
                is_error=True,
            )

        arguments = params.arguments or {}

        try:
            if params.name == "get_order_detail":
                order_id = _required_string(arguments, "orderId")
                return business_result(get_order(principal, order_id))

            if params.name == "get_logistics_trace":
                order_id = _required_string(arguments, "orderId")
                return business_result(get_logistics(principal, order_id))

            if params.name == "search_after_sales_policy":
                query = _required_string(arguments, "query", min_length=1)
                return business_result(search_policies(principal, query))

            if params.name == "preview_refund":
                order_id = _required_string(arguments, "orderId")
                reason = _required_string(arguments, "reason", min_length=2)
                return business_result(preview_refund(principal, order_id, reason))

            if params.name == "submit_refund_request":
                order_id = _required_string(arguments, "orderId")
                reason = _required_string(arguments, "reason", min_length=2)
                idempotency_key = _required_string(
                    arguments,
                    "idempotencyKey",
                    min_length=8,
                )

                # 相同幂等键已经创建过退款时，直接返回原结果。
                existing_refund = get_refund_by_idempotency_key(
                    principal,
                    idempotency_key,
                )
                if existing_refund is not None:
                    return json_result(
                        {
                            "ok": True,
                            "duplicated": True,
                            "refundRequest": existing_refund,
                        }
                    )

                action, confirmed = _accepted_confirmation(
                    params,
                    "confirm-refund",
                )
                if action is not None and action != "accept":
                    return cancelled_result("用户取消了退款提交")

                # 尚未确认时先执行退款预检，再请求 Host 收集用户确认。
                if not confirmed:
                    preview = preview_refund(principal, order_id, reason)
                    if not preview["ok"] or not preview["preview"]["eligible"]:
                        return business_result(preview)

                    request_state = codec.mint(
                        {
                            "operation": "submit_refund_request",
                            "orderId": order_id,
                            "reason": reason,
                            "idempotencyKey": idempotency_key,
                        },
                        principal,
                    )
                    return _confirmation_required(
                        request_id="confirm-refund",
                        message=(
                            f"即将为订单 {order_id} 创建 "
                            f"{preview['preview']['refundAmount']} 元退款申请，"
                            "是否继续？"
                        ),
                        request_state=request_state,
                    )

                # 校验确认信息是否属于当前退款请求，防止状态被复用。
                previous_state = codec.verify(params.request_state, principal)
                if (
                    previous_state is None
                    or previous_state.get("operation")
                    != "submit_refund_request"
                    or previous_state.get("orderId") != order_id
                    or previous_state.get("idempotencyKey") != idempotency_key
                ):
                    return invalid_state_result("确认信息与当前退款请求不一致")

                return business_result(
                    submit_refund(
                        principal,
                        order_id=order_id,
                        reason=reason,
                        idempotency_key=idempotency_key,
                    )
                )

            if params.name == "start_batch_refund_review":
                order_ids = _required_order_ids(arguments)
                action, confirmed = _accepted_confirmation(
                    params,
                    "confirm-batch",
                )
                if action is not None and action != "accept":
                    return cancelled_result("用户取消了批量退款审核")

                if not confirmed:
                    request_state = codec.mint(
                        {
                            "operation": "start_batch_refund_review",
                            "orderIds": order_ids,
                        },
                        principal,
                    )
                    return _confirmation_required(
                        request_id="confirm-batch",
                        message=(
                            f"即将审核 {len(order_ids)} 笔退款订单，是否继续？"
                        ),
                        request_state=request_state,
                    )

                previous_state = codec.verify(params.request_state, principal)
                if (
                    previous_state is None
                    or previous_state.get("operation")
                    != "start_batch_refund_review"
                    or previous_state.get("orderIds") != order_ids
                ):
                    return invalid_state_result("确认信息与当前批量任务不一致")

                return business_result(start_batch_review(principal, order_ids))

            if params.name == "get_batch_review_status":
                job_id = _required_string(arguments, "jobId")
                return business_result(get_job_snapshot(principal, job_id))

            if params.name == "cancel_batch_review":
                job_id = _required_string(arguments, "jobId")
                return business_result(cancel_batch_review(principal, job_id))

            if params.name == "get_batch_review_report":
                job_id = _required_string(arguments, "jobId")
                return business_result(get_job_snapshot(principal, job_id))

        except ValueError as error:
            return json_result(
                {
                    "ok": False,
                    "error": {
                        "code": "INVALID_ARGUMENT",
                        "message": str(error),
                    },
                },
                is_error=True,
            )

        return json_result(
            {
                "ok": False,
                "error": {
                    "code": "TOOL_NOT_FOUND",
                    "message": f"没有实现 Tool：{params.name}",
                },
            },
            is_error=True,
        )

    async def list_resources(
        context: ServerRequestContext,
        params: PaginatedRequestParams | None,
    ) -> ListResourcesResult:
        """暴露当前身份有权读取的售后 Resources。"""

        del context, params
        principal = principal_provider()
        resources = [
            Resource(
                name="refund-policy",
                title="当前企业退款规则",
                uri="after-sales://policies/refund-policy",
                description="根据登录身份返回当前企业自己的退款规则",
                mimeType="text/markdown",
            )
        ]

        if principal["role"] == "finance":
            resources.extend(
                [
                    Resource(
                        name="recent-audit-logs",
                        title="近期售后审计记录",
                        uri="after-sales://audit/recent",
                        description="当前企业最近的退款和批量审核操作记录",
                        mimeType="application/json",
                    ),
                    Resource(
                        name="批量退款审核报告",
                        uri=APP_URI,
                        description="以可视化界面展示批量退款审核结果",
                        mimeType=APP_MIME_TYPE,
                    ),
                ]
            )

        return ListResourcesResult(resources=resources)

    async def read_resource(
        context: ServerRequestContext,
        params: ReadResourceRequestParams,
    ) -> ReadResourceResult:
        """读取退款规则、审计日志或 MCP App HTML。"""

        del context
        principal = principal_provider()
        uri = str(params.uri)

        if uri == "after-sales://policies/refund-policy":
            result = get_policy(principal, "refund-policy")
            text = (
                f"# {result['policy']['title']}\n\n{result['policy']['content']}"
                if result["ok"]
                else result["error"]["message"]
            )
            return ReadResourceResult(
                contents=[
                    TextResourceContents(
                        uri=uri,
                        mimeType="text/markdown",
                        text=text,
                    )
                ]
            )

        if uri == "after-sales://audit/recent" and principal["role"] == "finance":
            return ReadResourceResult(
                contents=[
                    TextResourceContents(
                        uri=uri,
                        mimeType="application/json",
                        text=json.dumps(
                            get_audit_logs(principal)[-20:],
                            ensure_ascii=False,
                            indent=2,
                        ),
                    )
                ]
            )

        if uri == APP_URI and principal["role"] == "finance":
            return ReadResourceResult(
                contents=[
                    TextResourceContents(
                        uri=APP_URI,
                        mimeType=APP_MIME_TYPE,
                        text=resolved_app_html,
                        _meta={"ui": {"prefersBorder": False}},
                    )
                ]
            )

        return ReadResourceResult(
            contents=[
                TextResourceContents(
                    uri=uri,
                    mimeType="text/plain",
                    text=f"当前身份不能读取 Resource：{uri}",
                )
            ]
        )

    async def list_prompts(
        context: ServerRequestContext,
        params: PaginatedRequestParams | None,
    ) -> ListPromptsResult:
        """暴露可复用的售后问题处理提示词模板。"""

        del context, params
        principal_provider()
        return ListPromptsResult(
            prompts=[
                Prompt(
                    name="handle_after_sales_case",
                    title="售后问题处理模板",
                    description="要求 Agent 先查询事实，再决定是否执行退款操作",
                    arguments=[
                        PromptArgument(name="orderId", required=True),
                        PromptArgument(name="customerQuestion", required=True),
                    ],
                )
            ]
        )

    async def get_prompt(
        context: ServerRequestContext,
        params: GetPromptRequestParams,
    ) -> GetPromptResult:
        """根据订单号和用户问题生成售后 Agent Prompt。"""

        del context
        principal_provider()
        if params.name != "handle_after_sales_case":
            raise ValueError(f"没有找到 Prompt：{params.name}")

        arguments = params.arguments or {}
        order_id = _required_string(arguments, "orderId")
        customer_question = _required_string(arguments, "customerQuestion")
        text = "\n".join(
            [
                "你是企业售后 Agent。",
                "先调用只读工具核对订单和规则，不允许根据用户描述猜测业务事实。",
                "只有用户明确要求提交退款时，才可以调用 submit_refund_request。",
                f"订单号：{order_id}",
                f"用户问题：{customer_question}",
            ]
        )

        return GetPromptResult(
            description="企业售后 Agent 处理模板",
            messages=[
                PromptMessage(
                    role="user",
                    content=TextContent(text=text),
                )
            ],
        )

    return Server(
        "enterprise-after-sales-mcp",
        version="1.0.0",
        on_list_tools=list_tools,
        on_call_tool=call_tool,
        on_list_resources=list_resources,
        on_read_resource=read_resource,
        on_list_prompts=list_prompts,
        on_get_prompt=get_prompt,
    )
