"""企业售后业务服务。

文件作用：
提供租户隔离查询、退款规则、幂等提交、批量审核长任务和审计记录。

章节定位：【本章重点】

建议阅读：
重点理解 tenantId 如何限制数据范围、业务状态为什么独立于 MCP Server
实例，以及退款幂等和长任务状态是如何实现的。
"""

from __future__ import annotations

import copy
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from data import LOGISTICS, ORDERS, POLICIES

# ==================== 跨请求共享的业务状态 ====================

# 业务状态必须放在 MCP Server 请求处理函数之外。
#
# Streamable HTTP 请求之间不会共享协议调用栈；退款单、任务和审计记录
# 属于业务状态，不能跟着某一次协议请求一起销毁。
refund_requests: dict[str, dict[str, Any]] = {}
review_jobs: dict[str, dict[str, Any]] = {}
audit_logs: list[dict[str, Any]] = []


def business_error(code: str, message: str) -> dict[str, Any]:
    """创建统一的业务错误结构。"""

    return {"ok": False, "error": {"code": code, "message": message}}


def _iso_now() -> str:
    """生成与 JavaScript toISOString() 对齐的 UTC 时间文本。"""

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def append_audit(
    principal: dict[str, Any],
    action: str,
    target_id: str,
    detail: dict[str, Any] | None = None,
) -> None:
    """保存一条当前租户的操作审计记录。"""

    audit_logs.append(
        {
            "auditId": str(uuid4()),
            "tenantId": principal["tenantId"],
            "userId": principal["userId"],
            "action": action,
            "targetId": target_id,
            "detail": dict(detail or {}),
            "createdAt": _iso_now(),
        }
    )


# ==================== 多租户只读查询 ====================


def get_order(principal: dict[str, Any], order_id: str) -> dict[str, Any]:
    """根据当前登录人的租户身份查询订单。

    tenantId 只能从 principal 中读取，调用方不能跨租户查询
    其他企业的订单。
    """

    # 同时匹配租户和订单编号，保证订单数据按租户隔离。
    order = next(
        (
            item
            for item in ORDERS
            if item["tenantId"] == principal["tenantId"]
            and item["orderId"] == order_id
        ),
        None,
    )

    if order is None:
        return business_error("ORDER_NOT_FOUND", f"没有找到订单 {order_id}")

    return {"ok": True, "order": copy.deepcopy(order)}


def get_logistics(principal: dict[str, Any], order_id: str) -> dict[str, Any]:
    """查询当前租户订单的物流轨迹。"""

    order_result = get_order(principal, order_id)
    if not order_result["ok"]:
        return order_result

    trace = next(
        (
            item
            for item in LOGISTICS
            if item["tenantId"] == principal["tenantId"]
            and item["orderId"] == order_id
        ),
        None,
    )

    if trace is None:
        return business_error(
            "LOGISTICS_NOT_FOUND",
            f"订单 {order_id} 暂无物流信息",
        )

    return {"ok": True, "logistics": copy.deepcopy(trace)}


def get_policy(principal: dict[str, Any], code: str) -> dict[str, Any]:
    """读取当前租户的一条售后规则。"""

    policy = next(
        (
            item
            for item in POLICIES
            if item["tenantId"] == principal["tenantId"] and item["code"] == code
        ),
        None,
    )

    if policy is None:
        return business_error("POLICY_NOT_FOUND", f"没有找到规则 {code}")

    return {"ok": True, "policy": copy.deepcopy(policy)}


def search_policies(principal: dict[str, Any], query: str) -> dict[str, Any]:
    """按源代码相同的分词、包含匹配和稳定排序检索售后规则。"""

    # JavaScript 版本使用空白和中文标点切分；这里显式逐字符归一化，
    # 避免额外引入分词依赖。
    normalized = query.lower()
    for separator in "，。？！、":
        normalized = normalized.replace(separator, " ")
    words = [word for word in normalized.split() if word]

    results: list[dict[str, Any]] = []
    for item in POLICIES:
        if item["tenantId"] != principal["tenantId"]:
            continue

        searchable = f"{item['title']}\n{item['content']}".lower()
        score = sum(1 for word in words if word in searchable)
        if score > 0:
            results.append({**copy.deepcopy(item), "score": score})

    # Python 的 sort 与 JavaScript 的现代稳定排序一致：
    # 同分规则继续保持原始数据顺序。
    results.sort(key=lambda item: item["score"], reverse=True)
    return {"ok": True, "results": results}


# ==================== 退款规则与幂等提交 ====================


def preview_refund(
    principal: dict[str, Any],
    order_id: str,
    reason: str,
) -> dict[str, Any]:
    """用确定性业务规则判断退款资格，而不是交给模型猜。"""

    order_result = get_order(principal, order_id)
    if not order_result["ok"]:
        return order_result

    order = order_result["order"]
    eligible = True
    manual_review = False
    conclusion = "订单满足自动退款条件。"

    if order["status"] != "delivered":
        eligible = False
        conclusion = "订单尚未签收，不能按已签收退款流程处理。"
    elif order["category"] == "fresh":
        eligible = False
        conclusion = "生鲜商品不支持无理由退款。"
    elif order["signedDays"] > 7:
        eligible = False
        conclusion = f"订单已签收 {order['signedDays']} 天，超过 7 天退款期限。"
    elif order["amount"] > 2000:
        manual_review = True
        conclusion = (
            f"退款金额 {order['amount']} 元，超过 2000 元，需要人工审核。"
        )

    return {
        "ok": True,
        "preview": {
            "orderId": order_id,
            "productName": order["productName"],
            "refundAmount": order["amount"],
            "reason": reason,
            "eligible": eligible,
            "manualReview": manual_review,
            "conclusion": conclusion,
        },
    }


def submit_refund(
    principal: dict[str, Any],
    *,
    order_id: str,
    reason: str,
    idempotency_key: str,
) -> dict[str, Any]:
    """创建退款申请，并用 tenantId + idempotencyKey 防止重复提交。"""

    idempotency_id = f"{principal['tenantId']}:{idempotency_key}"
    existing = refund_requests.get(idempotency_id)

    if existing is not None:
        return {
            "ok": True,
            "duplicated": True,
            "refundRequest": copy.deepcopy(existing),
        }

    preview_result = preview_refund(principal, order_id, reason)
    if not preview_result["ok"]:
        return preview_result

    preview = preview_result["preview"]
    if not preview["eligible"]:
        return business_error("REFUND_NOT_ELIGIBLE", preview["conclusion"])

    refund_request = {
        "refundId": f"REF-{uuid4().hex[:8].upper()}",
        "tenantId": principal["tenantId"],
        "orderId": order_id,
        "amount": preview["refundAmount"],
        "reason": reason,
        "status": "manual_review" if preview["manualReview"] else "approved",
        "createdBy": principal["userId"],
        "createdAt": _iso_now(),
    }

    refund_requests[idempotency_id] = refund_request
    append_audit(
        principal,
        "submit_refund",
        refund_request["refundId"],
        {"orderId": order_id, "idempotencyKey": idempotency_key},
    )

    return {
        "ok": True,
        "duplicated": False,
        "refundRequest": copy.deepcopy(refund_request),
    }


def get_refund_by_idempotency_key(
    principal: dict[str, Any],
    idempotency_key: str,
) -> dict[str, Any] | None:
    """读取当前租户已经由幂等键创建的退款申请。"""

    refund_request = refund_requests.get(
        f"{principal['tenantId']}:{idempotency_key}"
    )
    return copy.deepcopy(refund_request) if refund_request else None


# ==================== 批量审核长任务 ====================


def start_batch_review(
    principal: dict[str, Any],
    order_ids: list[str],
    *,
    now_ms: Callable[[], float] | None = None,
) -> dict[str, Any]:
    """为当前租户启动批量退款审核任务。"""

    # 只有财务角色可以执行批量退款审核。
    if principal["role"] != "finance":
        return business_error("FORBIDDEN", "只有财务角色可以启动批量退款审核")

    # 校验所有订单是否都属于当前租户并且真实存在。
    invalid_order_id = next(
        (
            order_id
            for order_id in order_ids
            if not get_order(principal, order_id)["ok"]
        ),
        None,
    )
    if invalid_order_id is not None:
        return business_error(
            "ORDER_NOT_FOUND",
            f"没有找到订单 {invalid_order_id}",
        )

    clock = now_ms or (lambda: time.time() * 1000)
    job = {
        "jobId": f"JOB-{uuid4().hex[:8].upper()}",
        "tenantId": principal["tenantId"],
        "orderIds": list(order_ids),
        "status": "working",
        "createdBy": principal["userId"],
        "createdAt": clock(),
        "cancelledAt": None,
    }

    review_jobs[job["jobId"]] = job
    append_audit(
        principal,
        "start_batch_review",
        job["jobId"],
        {"orderIds": list(order_ids)},
    )

    return {
        "ok": True,
        "job": get_job_snapshot(
            principal,
            job["jobId"],
            now_ms=clock,
        )["job"],
    }


def get_job_snapshot(
    principal: dict[str, Any],
    job_id: str,
    *,
    now_ms: Callable[[], float] | None = None,
) -> dict[str, Any]:
    """通过已运行时间模拟后台任务进度。

    真实项目可替换为 Celery、RabbitMQ 或企业任务平台。
    """

    job = review_jobs.get(job_id)
    if job is None or job["tenantId"] != principal["tenantId"]:
        return business_error("JOB_NOT_FOUND", f"没有找到任务 {job_id}")

    if job["cancelledAt"] is not None:
        return {
            "ok": True,
            "job": {
                **copy.deepcopy(job),
                "status": "cancelled",
                "progress": 0,
                "message": "任务已取消",
            },
        }

    clock = now_ms or (lambda: time.time() * 1000)
    elapsed = clock() - job["createdAt"]

    if elapsed < 800:
        return {
            "ok": True,
            "job": {
                **copy.deepcopy(job),
                "status": "working",
                "progress": 25,
                "message": "正在读取订单",
            },
        }

    if elapsed < 1600:
        return {
            "ok": True,
            "job": {
                **copy.deepcopy(job),
                "status": "working",
                "progress": 70,
                "message": "正在执行退款规则",
            },
        }

    details = []
    for order_id in job["orderIds"]:
        result = preview_refund(principal, order_id, "批量审核")
        preview = result.get("preview", {})
        error = result.get("error", {})
        details.append(
            {
                "orderId": order_id,
                "eligible": preview.get("eligible", False),
                "manualReview": preview.get("manualReview", False),
                "conclusion": preview.get("conclusion") or error.get("message"),
            }
        )

    return {
        "ok": True,
        "job": {
            **copy.deepcopy(job),
            "status": "completed",
            "progress": 100,
            "message": "批量审核完成",
            "result": {
                "total": len(details),
                "autoApproved": sum(
                    1
                    for item in details
                    if item["eligible"] and not item["manualReview"]
                ),
                "manualReview": sum(
                    1 for item in details if item["manualReview"]
                ),
                "rejected": sum(1 for item in details if not item["eligible"]),
                "details": details,
            },
        },
    }


def cancel_batch_review(
    principal: dict[str, Any],
    job_id: str,
    *,
    now_ms: Callable[[], float] | None = None,
) -> dict[str, Any]:
    """取消尚未完成的批量退款审核任务。"""

    if principal["role"] != "finance":
        return business_error("FORBIDDEN", "只有财务角色可以取消批量退款审核")

    snapshot = get_job_snapshot(principal, job_id, now_ms=now_ms)
    if not snapshot["ok"]:
        return snapshot
    if snapshot["job"]["status"] == "completed":
        return business_error("JOB_ALREADY_COMPLETED", "任务已经完成，无法取消")

    clock = now_ms or (lambda: time.time() * 1000)
    review_jobs[job_id]["cancelledAt"] = clock()
    append_audit(principal, "cancel_batch_review", job_id)
    return get_job_snapshot(principal, job_id, now_ms=clock)


def get_audit_logs(principal: dict[str, Any]) -> list[dict[str, Any]]:
    """返回当前租户自己的审计记录。"""

    return [
        copy.deepcopy(item)
        for item in audit_logs
        if item["tenantId"] == principal["tenantId"]
    ]


def reset_demo_state() -> None:
    """只供离线验证使用：清理进程内的演示业务状态。"""

    refund_requests.clear()
    review_jobs.clear()
    audit_logs.clear()
