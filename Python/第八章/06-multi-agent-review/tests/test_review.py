"""结构合同与审核—返工流程的离线测试。"""

from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import review_workflow
from contracts import SCENE_FILES, check_repair_scope, load_scenes, validate_review, validate_scenes
from workflow import run_review_loop


ISSUE = {
    "filePath": "/game/scenes/ending-b.json",
    "rule": "世界规则 1：无法恢复对外通信，也无法获得外部救援。",
    "quote": "林澜恢复了对外通信，成功联系地球，救援飞船赶到并接走了所有人。",
    "reason": "外部救援与世界规则冲突。",
    "suggestion": "改为利用休眠降低消耗，保留暂停维修的代价。",
}
FAILED_REVIEW = {"verdict": "needs_revision", "issues": [ISSUE]}
PASSED_REVIEW = {"verdict": "approved", "issues": []}


def workspace(directory: str) -> Path:
    """显式复制已知教学资源，不触碰其他文件。"""

    target_root = Path(directory) / "run"
    for relative in review_workflow.FIXTURE_FILES:
        target = target_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(review_workflow.FIXTURES_DIR / relative, target)
    (target_root / "reviews").mkdir()
    return target_root


class ContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original = load_scenes(review_workflow.FIXTURES_DIR)

    def test_defect_fixture_is_structurally_valid(self) -> None:
        self.assertEqual(validate_scenes(self.original), [])

    def test_scene_schema_rejects_wrong_type_and_extra_field(self) -> None:
        entries = copy.deepcopy(self.original)
        entries[0]["data"]["ending"] = "false"
        self.assertEqual(validate_scenes(entries)[0]["rule"], "schema")
        entries = copy.deepcopy(self.original)
        entries[0]["data"]["extra"] = "not allowed"
        self.assertEqual(validate_scenes(entries)[0]["rule"], "schema")

    def test_missing_target_and_duplicate_id(self) -> None:
        entries = copy.deepcopy(self.original)
        entries[0]["data"]["choices"][0]["nextSceneId"] = "missing"
        self.assertIn("missing_target", [issue["rule"] for issue in validate_scenes(entries)])
        entries[2]["data"]["id"] = "ending-a"
        self.assertIn("duplicate_id", [issue["rule"] for issue in validate_scenes(entries)])

    def test_unreachable_scene_and_cycle(self) -> None:
        entries = copy.deepcopy(self.original)
        entries[0]["data"]["choices"][1]["nextSceneId"] = "ending-a"
        self.assertIn("unreachable", [issue["rule"] for issue in validate_scenes(entries)])
        entries[0]["data"]["choices"][1]["nextSceneId"] = "scene-01"
        self.assertIn("cycle", [issue["rule"] for issue in validate_scenes(entries)])

    def test_ending_count_dead_end_and_ending_choices(self) -> None:
        entries = copy.deepcopy(self.original)
        entries[0]["data"]["choices"] = []
        self.assertIn("dead_end", [issue["rule"] for issue in validate_scenes(entries)])
        entries[0]["data"]["ending"] = True
        self.assertIn("ending_count", [issue["rule"] for issue in validate_scenes(entries)])
        entries[0]["data"]["choices"] = self.original[0]["data"]["choices"]
        self.assertIn("ending_choices", [issue["rule"] for issue in validate_scenes(entries)])

    def test_review_requires_real_quote_and_consistent_verdict(self) -> None:
        self.assertEqual(validate_review(FAILED_REVIEW, self.original), FAILED_REVIEW)
        with self.assertRaisesRegex(ValueError, "不一致"):
            validate_review({**FAILED_REVIEW, "verdict": "approved"}, self.original)
        with self.assertRaisesRegex(ValueError, "不存在"):
            validate_review({**FAILED_REVIEW, "issues": [{**ISSUE, "quote": "虚构引用"}]}, self.original)
        with self.assertRaises(Exception):
            validate_review({**FAILED_REVIEW, "issues": [{**ISSUE, "filePath": "/outside.json"}]}, self.original)

    def test_repair_scope_rejects_other_file_structure_or_no_change(self) -> None:
        after = copy.deepcopy(self.original)
        after[1]["raw"] += "\n"
        with self.assertRaisesRegex(ValueError, "未授权"):
            check_repair_scope(self.original, after, [ISSUE["filePath"]])
        after[1] = copy.deepcopy(self.original[1])
        after[2]["data"]["ending"] = False
        after[2]["raw"] = json.dumps(after[2]["data"], ensure_ascii=False)
        with self.assertRaisesRegex(ValueError, "分支结构"):
            check_repair_scope(self.original, after, [ISSUE["filePath"]])
        with self.assertRaisesRegex(ValueError, "没有产生"):
            check_repair_scope(self.original, self.original, [ISSUE["filePath"]])

    def test_invalid_json_stops_delivery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = workspace(directory)
            (root / SCENE_FILES[2].lstrip("/")).write_text("{broken", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "不是合法 JSON"):
                load_scenes(root)


class WorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_repair_then_recheck_ready_and_keep_other_files_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = workspace(directory)
            original = load_scenes(root)
            reviews = 0
            assignments: list[dict] = []

            async def delegate(task: dict) -> None:
                nonlocal reviews
                assignments.append(task)
                if task["assignee"] == "continuity-reviewer":
                    report = FAILED_REVIEW if reviews == 0 else PASSED_REVIEW
                    reviews += 1
                    (root / task["writeFiles"][0].lstrip("/")).write_text(
                        json.dumps(report, ensure_ascii=False), encoding="utf-8"
                    )
                else:
                    self.assertEqual(task["writeFiles"], [ISSUE["filePath"]])
                    data = {
                        **original[2]["data"],
                        "content": "大家进入休眠舱降低消耗，代价是暂停维修。",
                    }
                    (root / task["writeFiles"][0].lstrip("/")).write_text(
                        json.dumps(data, ensure_ascii=False), encoding="utf-8"
                    )

            result = await run_review_loop(root, delegate, log=lambda _: None)
            self.assertEqual(result, {
                "status": "ready", "repairCount": 1,
                "reportPath": "/reviews/review-2.json",
                "changedFiles": [ISSUE["filePath"]],
            })
            self.assertEqual(reviews, 2)
            self.assertEqual([task["assignee"] for task in assignments], [
                "continuity-reviewer", "scene-writer", "continuity-reviewer",
            ])
            self.assertEqual(load_scenes(root)[1]["raw"], original[1]["raw"])
            self.assertEqual(json.loads((root / "result.json").read_text(encoding="utf-8")), result)

    async def test_maximum_two_repairs_then_human_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = workspace(directory)
            repairs = reviews = 0

            async def delegate(task: dict) -> None:
                nonlocal repairs, reviews
                if task["assignee"] == "continuity-reviewer":
                    reviews += 1
                    (root / task["writeFiles"][0].lstrip("/")).write_text(
                        json.dumps(FAILED_REVIEW, ensure_ascii=False), encoding="utf-8"
                    )
                else:
                    repairs += 1
                    data = load_scenes(root)[2]["data"]
                    data["title"] = f"仍有问题的版本 {repairs}"
                    (root / task["writeFiles"][0].lstrip("/")).write_text(
                        json.dumps(data, ensure_ascii=False), encoding="utf-8"
                    )

            result = await run_review_loop(root, delegate, log=lambda _: None)
            self.assertEqual(result["status"], "needs_human_review")
            self.assertEqual(result["repairCount"], 2)
            self.assertEqual((repairs, reviews), (2, 3))

    async def test_incomplete_report_or_review_time_scene_change_cannot_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = workspace(directory)

            async def incomplete(task: dict) -> None:
                (root / task["writeFiles"][0].lstrip("/")).write_text(
                    '{"verdict":"approved"}', encoding="utf-8"
                )

            with self.assertRaises(Exception):
                await run_review_loop(root, incomplete, log=lambda _: None)

            async def changed_during_review(task: dict) -> None:
                (root / task["writeFiles"][0].lstrip("/")).write_text(
                    json.dumps(PASSED_REVIEW), encoding="utf-8"
                )
                data = load_scenes(root)[2]["data"]
                data["title"] = "审核时被改动"
                (root / ISSUE["filePath"].lstrip("/")).write_text(
                    json.dumps(data, ensure_ascii=False), encoding="utf-8"
                )

            with self.assertRaisesRegex(ValueError, "审核期间"):
                await run_review_loop(root, changed_during_review, log=lambda _: None)

    async def test_structural_error_stops_before_delegation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = workspace(directory)
            (root / ISSUE["filePath"].lstrip("/")).write_text("{}", encoding="utf-8")

            async def no_delegate(task: dict) -> None:
                self.fail("结构错误时不应调用模型")

            with self.assertRaisesRegex(ValueError, "结构校验失败"):
                await run_review_loop(root, no_delegate, log=lambda _: None)

    async def test_validate_mode_never_constructs_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(review_workflow, "WORKSPACES_ROOT", Path(directory)),
                patch.object(review_workflow, "ChatDeepSeek") as model_class,
            ):
                self.assertEqual(await review_workflow.run("validate"), 0)
                model_class.assert_not_called()
                with self.assertRaisesRegex(ValueError, "只支持"):
                    await review_workflow.run("unknown")


if __name__ == "__main__":
    unittest.main()
