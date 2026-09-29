"""场景与审核报告的格式合同，以及不依赖模型的确定性验收。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError


SCENE_FILES = [
    "/game/scenes/scene-01.json",
    "/game/scenes/ending-a.json",
    "/game/scenes/ending-b.json",
]
NonEmpty = Annotated[str, StringConstraints(min_length=1)]


class ChoiceSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    text: NonEmpty
    next_scene_id: NonEmpty = Field(alias="nextSceneId")


class SceneSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: NonEmpty
    title: NonEmpty
    content: NonEmpty
    ending: bool
    choices: list[ChoiceSchema]


class ReviewIssueSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    file_path: Literal[
        "/game/scenes/scene-01.json",
        "/game/scenes/ending-a.json",
        "/game/scenes/ending-b.json",
    ] = Field(alias="filePath")
    rule: NonEmpty
    quote: NonEmpty
    reason: NonEmpty
    suggestion: NonEmpty


class ReviewSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    verdict: Literal["approved", "needs_revision"]
    issues: list[ReviewIssueSchema] = Field(max_length=10)


def load_scenes(workspace_dir: Path) -> list[dict[str, Any]]:
    """只读取固定场景清单，保留原文供局部修改前后比较。"""

    entries: list[dict[str, Any]] = []
    for file_path in SCENE_FILES:
        raw = (workspace_dir / file_path.lstrip("/")).read_text(encoding="utf-8")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(f"{file_path} 不是合法 JSON，停止交付。") from error
        entries.append({"filePath": file_path, "raw": raw, "data": data})
    return entries


def validate_scenes(entries: list[dict[str, Any]]) -> list[dict[str, str]]:
    """校验固定的三场景、双结局结构；本例明确禁止循环分支。"""

    issues: list[dict[str, str]] = []

    def add(file_path: str, rule: str, reason: str) -> None:
        issues.append({"filePath": file_path, "rule": rule, "reason": reason})

    for entry in entries:
        try:
            SceneSchema.model_validate(entry["data"])
        except ValidationError as error:
            add(entry["filePath"], "schema", error.errors()[0]["msg"])
    if issues:
        return issues

    by_id: dict[str, dict[str, Any]] = {}
    for entry in entries:
        file_path, data = entry["filePath"], entry["data"]
        if data["id"] in by_id:
            add(file_path, "duplicate_id", f"场景 ID 重复：{data['id']}")
        by_id[data["id"]] = entry
        if data["ending"] and data["choices"]:
            add(file_path, "ending_choices", "结局不能继续提供选项。")
        if not data["ending"] and not data["choices"]:
            add(file_path, "dead_end", "非结局场景必须有选项。")

    if "scene-01" not in by_id:
        add(SCENE_FILES[0], "missing_start", "缺少起始场景 scene-01。")
    if sum(1 for entry in entries if entry["data"]["ending"]) != 2:
        add("/game/scenes", "ending_count", "本次要求恰好两个结局。")
    for entry in entries:
        for choice in entry["data"]["choices"]:
            if choice["nextSceneId"] not in by_id:
                add(entry["filePath"], "missing_target", f"选项指向不存在的场景：{choice['nextSceneId']}")
    if issues:
        return issues

    visited: set[str] = set()
    visiting: set[str] = set()

    def visit(scene_id: str) -> None:
        if scene_id in visiting:
            add(by_id[scene_id]["filePath"], "cycle", "本例要求有限分支，不能形成循环。")
            return
        if scene_id in visited:
            return
        visited.add(scene_id)
        visiting.add(scene_id)
        for choice in by_id[scene_id]["data"]["choices"]:
            visit(choice["nextSceneId"])
        visiting.remove(scene_id)

    visit("scene-01")
    for entry in entries:
        if entry["data"]["id"] not in visited:
            add(entry["filePath"], "unreachable", f"从开场无法到达 {entry['data']['id']}。")
    return issues


def validate_review(value: Any, entries: list[dict[str, Any]]) -> dict[str, Any]:
    """审核结论必须与问题列表一致，且 quote 来自本次场景正文。"""

    report = ReviewSchema.model_validate(value).model_dump(by_alias=True)
    if (report["verdict"] == "approved") != (len(report["issues"]) == 0):
        raise ValueError("审核结论与问题列表不一致，停止交付。")
    for issue in report["issues"]:
        entry = next((item for item in entries if item["filePath"] == issue["filePath"]), None)
        if entry is None or issue["quote"] not in entry["data"]["content"]:
            raise ValueError(f"审核报告引用了正文中不存在的内容：{issue['filePath']}")
    return report


def check_repair_scope(
    before: list[dict[str, Any]], after: list[dict[str, Any]], allowed_files: list[str]
) -> list[str]:
    """只允许改问题文件的标题和正文，原文及分支结构都要逐一核对。"""

    changed: list[str] = []
    for old in before:
        current = next((entry for entry in after if entry["filePath"] == old["filePath"]), None)
        if current is None:
            raise ValueError(f"返工删除了场景：{old['filePath']}")
        if old["raw"] == current["raw"]:
            continue
        if old["filePath"] not in allowed_files:
            raise ValueError(f"修改了未授权文件：{old['filePath']}")

        # 字段顺序和空白可变；id、ending、choices 的结构不能变。
        def structure(data: dict[str, Any]) -> dict[str, Any]:
            return {name: data.get(name) for name in ("id", "ending", "choices")}

        if structure(old["data"]) != structure(current["data"]):
            raise ValueError(f"本次正文返工不允许改变分支结构：{old['filePath']}")
        changed.append(old["filePath"])
    if not changed:
        raise ValueError("返工没有产生文件变化，停止继续消耗模型调用。")
    return changed
