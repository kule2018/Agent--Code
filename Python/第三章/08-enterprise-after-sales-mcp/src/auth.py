"""把本地演示 Bearer Token 转换成企业用户身份。

文件作用：
校验本地演示 Bearer Token，并将 Token 转换成 MCP HTTP 层使用的
AccessToken 和企业用户身份。

章节定位：【配套文件】

建议阅读：
了解身份如何在进入 MCP Tool 前完成校验，以及 tenantId 和 role
如何从服务端身份中获得即可。
"""

from __future__ import annotations

from typing import Any

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken

from data import PRINCIPALS_BY_TOKEN


class CourseTokenVerifier:
    """校验只用于本地课程演示的三组固定 Token。"""

    async def verify_token(self, token: str) -> AccessToken | None:
        principal = PRINCIPALS_BY_TOKEN.get(token)
        if principal is None:
            return None

        return AccessToken(
            token=token,
            client_id=principal["userId"],
            scopes=[principal["role"]],
            subject=principal["userId"],
            claims={"principal": dict(principal)},
        )


def principal_from_token(token: str) -> dict[str, str] | None:
    """根据演示 Token 获取一份不会修改原始数据的身份对象。"""

    principal = PRINCIPALS_BY_TOKEN.get(token)
    return dict(principal) if principal else None


def current_principal() -> dict[str, Any]:
    """从当前 MCP HTTP 请求的认证上下文中读取企业身份。"""

    access_token = get_access_token()
    principal = access_token.claims.get("principal") if access_token else None

    if not isinstance(principal, dict):
        raise RuntimeError("MCP 请求缺少有效身份")

    return dict(principal)
