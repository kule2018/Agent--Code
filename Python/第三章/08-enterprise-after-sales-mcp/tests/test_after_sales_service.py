"""企业售后业务层离线测试。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from after_sales_service import (  # noqa: E402
    cancel_batch_review,
    get_job_snapshot,
    get_order,
    preview_refund,
    reset_demo_state,
    start_batch_review,
    submit_refund,
)
from data import PRINCIPALS_BY_TOKEN  # noqa: E402


class AfterSalesServiceTest(unittest.TestCase):
    """验证租户、规则、幂等和长任务行为。"""

    def setUp(self) -> None:
        reset_demo_state()
        self.blue_service = PRINCIPALS_BY_TOKEN["token-blue-service"]
        self.blue_finance = PRINCIPALS_BY_TOKEN["token-blue-finance"]
        self.star_service = PRINCIPALS_BY_TOKEN["token-star-service"]

    def test_same_order_id_is_isolated_by_tenant(self) -> None:
        blue = get_order(self.blue_service, "A1024")
        star = get_order(self.star_service, "A1024")

        self.assertEqual(blue["order"]["productName"], "全自动咖啡机")
        self.assertEqual(star["order"]["productName"], "学习平板")

    def test_refund_rules_keep_original_thresholds(self) -> None:
        expensive = preview_refund(self.blue_service, "A1024", "质量问题")
        fresh = preview_refund(self.blue_service, "A1026", "不想要了")
        shipped = preview_refund(self.star_service, "A1024", "不想要了")

        self.assertTrue(expensive["preview"]["eligible"])
        self.assertTrue(expensive["preview"]["manualReview"])
        self.assertFalse(fresh["preview"]["eligible"])
        self.assertEqual(fresh["preview"]["conclusion"], "生鲜商品不支持无理由退款。")
        self.assertFalse(shipped["preview"]["eligible"])

    def test_submit_refund_is_idempotent_inside_tenant(self) -> None:
        first = submit_refund(
            self.blue_service,
            order_id="A1024",
            reason="质量问题",
            idempotency_key="course-key-1001",
        )
        second = submit_refund(
            self.blue_service,
            order_id="A1024",
            reason="质量问题",
            idempotency_key="course-key-1001",
        )

        self.assertFalse(first["duplicated"])
        self.assertTrue(second["duplicated"])
        self.assertEqual(
            first["refundRequest"]["refundId"],
            second["refundRequest"]["refundId"],
        )

    def test_batch_job_progress_and_result(self) -> None:
        current = 1000.0
        started = start_batch_review(
            self.blue_finance,
            ["A1024", "A1025", "A1026"],
            now_ms=lambda: current,
        )
        job_id = started["job"]["jobId"]

        at_25 = get_job_snapshot(
            self.blue_finance,
            job_id,
            now_ms=lambda: current + 700,
        )
        at_70 = get_job_snapshot(
            self.blue_finance,
            job_id,
            now_ms=lambda: current + 1200,
        )
        completed = get_job_snapshot(
            self.blue_finance,
            job_id,
            now_ms=lambda: current + 1700,
        )

        self.assertEqual(at_25["job"]["progress"], 25)
        self.assertEqual(at_70["job"]["progress"], 70)
        self.assertEqual(completed["job"]["progress"], 100)
        self.assertEqual(
            completed["job"]["result"],
            {
                "total": 3,
                "autoApproved": 1,
                "manualReview": 1,
                "rejected": 1,
                "details": completed["job"]["result"]["details"],
            },
        )

    def test_customer_service_cannot_start_or_cancel_finance_job(self) -> None:
        forbidden = start_batch_review(
            self.blue_service,
            ["A1024"],
        )
        self.assertEqual(forbidden["error"]["code"], "FORBIDDEN")

        started = start_batch_review(
            self.blue_finance,
            ["A1024"],
            now_ms=lambda: 1000,
        )
        cancelled = cancel_batch_review(
            self.blue_service,
            started["job"]["jobId"],
        )
        self.assertEqual(cancelled["error"]["code"], "FORBIDDEN")


if __name__ == "__main__":
    unittest.main()
