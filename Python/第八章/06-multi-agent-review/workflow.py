"""从实际文件验收：审核、局部返工、重新审核，最多返工两次。"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from contracts import (
    SCENE_FILES,
    check_repair_scope,
    load_scenes,
    validate_review,
    validate_scenes,
)


async def run_review_loop(
    workspace_dir: Path,
    delegate: Callable[[dict[str, Any]], Awaitable[None]],
    max_repairs: int = 2,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    """始终以磁盘文件为准；通过后才标记 ready。"""

    repair_count = 0
    changed_files: dict[str, None] = {}  # 保留首次修改的顺序，相当于 Node 的 Set。

    while True:
        # 每轮重读 Workspace，先检查 JSON 格式与固定分支结构。
        scenes = load_scenes(workspace_dir)
        errors = validate_scenes(scenes)
        if errors:
            raise ValueError(f"结构校验失败：{json.dumps(errors, ensure_ascii=False)}")
        log(f"\n[程序校验] 第 {repair_count + 1} 轮：三个场景、两个结局，结构通过。")

        # 每轮审核写独立文件，避免覆盖上轮结论。
        report_path = f"/reviews/review-{repair_count + 1}.json"
        review_task = {
            "assignee": "continuity-reviewer",
            "goal": "检查各场景是否违反世界规则，保存逐条问题；无明确冲突时通过。",
            "readFiles": [
                "/game/world.md", *SCENE_FILES, "/contracts/review.schema.json",
            ],
            "writeFiles": [report_path],
            "skillPath": "/skills/story-quality/SKILL.md",
            "acceptanceCriteria": [
                "按 review.schema.json 交付报告，quote 原样引用场景正文。",
                "问题必须说明违反什么规则、影响哪个文件、建议怎样修改。",
                "只审核当前文件，保持世界观和场景不变。",
            ],
        }
        await delegate(review_task)

        # Reviewer 只准写报告；场景原文字节变化则拒绝放行。
        after_review = load_scenes(workspace_dir)
        if any(current["raw"] != old["raw"] for old, current in zip(scenes, after_review, strict=True)):
            raise ValueError("审核期间场景被修改，当前报告不能用于放行。")
        report = validate_review(
            json.loads((workspace_dir / report_path.lstrip("/")).read_text(encoding="utf-8")),
            scenes,
        )
        log(f"[审核报告] {report['verdict']}，问题数：{len(report['issues'])}")
        for issue in report["issues"]:
            log(
                f"{issue['filePath']}\n原文：{issue['quote']}\n"
                f"原因：{issue['reason']}\n建议：{issue['suggestion']}"
            )

        # 审核通过，或两次返工后仍未通过：停止调用模型并写最终状态。
        if report["verdict"] == "approved" or repair_count >= max_repairs:
            result = {
                "status": "ready" if report["verdict"] == "approved" else "needs_human_review",
                "repairCount": repair_count,
                "reportPath": report_path,
                "changedFiles": list(changed_files),
            }
            (workspace_dir / "result.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            log(f"\n[最终状态] {result['status']}；已返工 {repair_count} 次。")
            return result

        # 只把本轮报告指出的文件交给场景编写者，其他文件不可修改。
        affected_files = list(dict.fromkeys(issue["filePath"] for issue in report["issues"]))
        repair_task = {
            "assignee": "scene-writer",
            "goal": "根据审核报告修复明确冲突，保留各分支的不同后果。",
            "readFiles": [
                "/game/world.md", *SCENE_FILES, report_path, "/contracts/scene.schema.json",
            ],
            "writeFiles": affected_files,
            "skillPath": "/skills/story-quality/SKILL.md",
            "acceptanceCriteria": [
                "只修改授权文件的 title 和 content，保留 id、ending、choices。",
                "保留两个选择的收益和代价，不增加外部救援。",
                "其他文件保持不变，保存合法 JSON 并重新读取核对。",
            ],
        }
        log(f"\n[局部返工] 允许修改：{', '.join(affected_files)}")
        await delegate(repair_task)

        # 重新读取并比较：只允许授权文件变化，分支结构保持原样。
        after_repair = load_scenes(workspace_dir)
        changed = check_repair_scope(scenes, after_repair, affected_files)
        for path in changed:
            changed_files[path] = None
        log(f"[修改核对] 实际变化：{', '.join(changed)}；其余场景原文保持不变。")
        repair_count += 1
