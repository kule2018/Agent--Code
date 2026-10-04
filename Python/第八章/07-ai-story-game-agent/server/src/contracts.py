"""JSON 契约、批准大纲约束，以及考虑玩家状态的可达性验收。"""

from collections import deque
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints, model_validator

from shared.engine import available_choices, choose, current_scene, start_game

Id = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{1,31}$")]
FlagName = Annotated[str, StringConstraints(pattern=r"^[a-z][a-zA-Z0-9]{0,30}$")]
Flags = dict[FlagName, bool]


def string_length(value: str) -> int:
    # 保留 Node 的 UTF-16 长度边界；一个 emoji 在 JavaScript 中占两个单位。
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def text_type(minimum: int, maximum: int | None = None, trim: bool = False):
    def check(value: str) -> str:
        length = string_length(value)
        if length < minimum or (maximum is not None and length > maximum):
            raise ValueError(f"文本长度应为 {minimum}～{maximum or '不限'}。")
        return value

    limits = {"minLength": minimum}
    if maximum is not None:
        limits["maxLength"] = maximum
    return Annotated[str, StringConstraints(strip_whitespace=trim), AfterValidator(check),
                     Field(json_schema_extra=limits)]


def integer_value(value: Any) -> Any:
    # JSON 的 3.0 在 Node 中也满足整数约束，但布尔值不能充当数量。
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


Count = Annotated[int, BeforeValidator(integer_value)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @classmethod
    def parse(cls, value: Any) -> dict:
        return cls.model_validate(value).model_dump()


class BriefSchema(Contract):
    title: text_type(2, 80, trim=True)
    premise: text_type(10, 1000, trim=True)
    genre: text_type(2, 30, trim=True)
    audience: text_type(2, 80, trim=True)
    worldRules: text_type(10, 1000, trim=True)
    characterCount: Count = Field(ge=2, le=4)
    sceneCount: Count = Field(ge=6, le=10)
    endingCount: Count = Field(ge=2, le=3)
    mode: Literal["replay", "ai"]
    replayScenario: Literal["normal", "defect"] = "normal"

    @model_validator(mode="after")
    def check_counts(self) -> "BriefSchema":
        if self.endingCount >= self.sceneCount:
            raise ValueError("结局数必须少于场景总数。")
        return self


class WorldSchema(Contract):
    # 明确规则比泛泛描述更容易在一致性审核阶段逐项核对。
    title: text_type(2)
    summary: text_type(20)
    rules: list[text_type(8)] = Field(min_length=2, max_length=8)


class CharacterSchema(Contract):
    id: Id
    name: text_type(1)
    # goal 是当前目标，motivation 是驱动行动的内在动机，两者用于剧情审核。
    goal: text_type(8)
    motivation: text_type(8)


class CharactersSchema(Contract):
    characters: list[CharacterSchema] = Field(min_length=2, max_length=4)


class ChoiceSchema(Contract):
    id: Id
    text: text_type(2)
    to: Id
    when: Flags = Field(default_factory=dict)
    effects: Flags = Field(default_factory=dict)


class OutlineSceneSchema(Contract):
    id: Id
    summary: text_type(8)
    characterIds: list[Id] = Field(min_length=1)
    ending: bool
    choices: list[ChoiceSchema] = Field(max_length=3)


class OutlineSchema(Contract):
    title: text_type(2)
    startSceneId: Id
    flags: Flags
    scenes: list[OutlineSceneSchema] = Field(min_length=6, max_length=10)


class SceneSchema(Contract):
    id: Id
    title: text_type(2)
    content: text_type(30)
    ending: bool
    choices: list[ChoiceSchema] = Field(max_length=3)


class GameSchema(Contract):
    title: text_type(2)
    premise: text_type(10)
    startSceneId: Id
    flags: Flags
    characters: list[CharacterSchema]
    scenes: list[SceneSchema]


class ReviewIssueSchema(Contract):
    filePath: Annotated[str, StringConstraints(pattern=r"^/scenes/[a-z][a-z0-9-]{1,31}\.json$")]
    rule: text_type(3)
    quote: text_type(3)
    reason: text_type(8)
    suggestion: text_type(8)


class ReviewSchema(Contract):
    verdict: Literal["approved", "needs_revision"]
    issues: list[ReviewIssueSchema] = Field(max_length=10)


def game_from_outline(brief: dict, outline: dict, characters: dict, scenes: list[dict]) -> dict:
    """标题、起点与状态来自批准大纲，正文来自验收后的场景文件。"""
    return {"title": outline["title"], "premise": brief["premise"],
            "startSceneId": outline["startSceneId"], "flags": outline["flags"],
            "characters": characters["characters"], "scenes": scenes}


def assert_outline(brief: dict, outline: dict, characters: dict) -> None:
    if len(outline["scenes"]) != brief["sceneCount"]:
        raise ValueError(f"场景数应为 {brief['sceneCount']}。")
    if len(characters["characters"]) != brief["characterCount"]:
        raise ValueError(f"角色数应为 {brief['characterCount']}。")
    if sum(item["ending"] for item in outline["scenes"]) != brief["endingCount"]:
        raise ValueError(f"结局数应为 {brief['endingCount']}。")
    ids = {item["id"] for item in characters["characters"]}
    if len(ids) != len(characters["characters"]):
        raise ValueError("角色 ID 重复。")
    for scene in outline["scenes"]:
        if any(item not in ids for item in scene["characterIds"]):
            raise ValueError(f"{scene['id']} 引用了不存在的角色。")
    # 尚未写正文时，用摘要组成临时游戏，只验证分支与玩家状态。
    validate_game(game_from_outline(brief, outline, characters, [
        {"id": item["id"], "title": item["id"],
         "content": item["summary"] + "。" * max(0, 30 - string_length(item["summary"])),
         "ending": item["ending"], "choices": item["choices"]} for item in outline["scenes"]
    ]))


def assert_scene(outline: dict, value: Any, expected_id: str) -> dict:
    scene = SceneSchema.parse(value)
    planned = next((item for item in outline["scenes"] if item["id"] == expected_id), None)
    if planned is None or scene["id"] != expected_id:
        raise ValueError(f"场景 ID 不符合任务要求：{expected_id}")
    # 只允许生成 title / content；字典字段顺序变化不影响结构比较。
    if scene["ending"] != planned["ending"] or scene["choices"] != planned["choices"]:
        raise ValueError(f"{expected_id} 修改了已批准的分支结构。")
    return scene


def validate_game(game: dict) -> dict[str, list[str]]:
    """先检查静态图，再模拟所有可达的「场景 + 布尔状态」组合。"""
    GameSchema.parse(game)
    by_id = {item["id"]: item for item in game["scenes"]}
    if len(by_id) != len(game["scenes"]):
        raise ValueError("场景 ID 重复。")
    if len(game["flags"]) > 3:
        raise ValueError("状态变量最多三个。")
    if game["startSceneId"] not in by_id or by_id[game["startSceneId"]]["ending"]:
        raise ValueError("起点必须是普通场景。")
    ending_count = sum(item["ending"] for item in game["scenes"])
    if not ending_count:
        raise ValueError("至少需要一个结局。")
    for scene in game["scenes"]:
        if (scene["ending"] and scene["choices"]) or (not scene["ending"] and len(scene["choices"]) < 2):
            raise ValueError(f"{scene['id']} 的选项数量不符合规则。")
        choice_ids: set[str] = set()
        for choice in scene["choices"]:
            if choice["id"] in choice_ids:
                raise ValueError(f"{scene['id']} 的选项 ID 重复。")
            choice_ids.add(choice["id"])
            if choice["to"] not in by_id:
                raise ValueError(f"{scene['id']} 指向不存在的场景 {choice['to']}。")
            for key in [*choice["when"], *choice["effects"]]:
                if key not in game["flags"]:
                    raise ValueError(f"{scene['id']} 使用了未知状态 {key}。")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(scene_id: str) -> None:
        if scene_id in visiting:
            raise ValueError(f"剧情包含循环：{scene_id}。")
        if scene_id in visited:
            return
        visiting.add(scene_id)
        for choice in by_id[scene_id]["choices"]:
            visit(choice["to"])
        visiting.remove(scene_id)
        visited.add(scene_id)

    visit(game["startSceneId"])
    if len(visited) != len(game["scenes"]):
        raise ValueError("存在从开场无法到达的场景。")

    paths: dict[str, list[str]] = {}
    queue = deque([(start_game(game), [])])
    seen: set[tuple] = set()
    reached: set[str] = set()
    while queue:
        session, path = queue.popleft()
        key = (session["sceneId"], *(session["flags"][flag] for flag in sorted(game["flags"])))
        if key in seen:
            continue
        seen.add(key)
        reached.add(session["sceneId"])
        scene = current_scene(game, session)
        if scene["ending"]:
            paths[scene["id"]] = path
            continue
        options = available_choices(scene, session["flags"])
        if not options:
            raise ValueError(f"{scene['id']} 在某个可达状态下没有可选项。")
        for choice in options:
            queue.append((choose(game, session, choice["id"]), [*path, f"{scene['id']}:{choice['id']}"]))
    if len(reached) != len(game["scenes"]):
        raise ValueError("存在因状态条件永远无法进入的场景。")
    if len(paths) != ending_count:
        raise ValueError("存在无法实际到达的结局。")
    return paths


def assert_review(value: Any, scenes: list[dict]) -> dict:
    report = ReviewSchema.parse(value)
    if (report["verdict"] == "approved") != (len(report["issues"]) == 0):
        raise ValueError("审核结论与问题列表不一致。")
    for issue in report["issues"]:
        scene = next((item for item in scenes if f"/scenes/{item['id']}.json" == issue["filePath"]), None)
        if scene is None or issue["quote"] not in scene["content"]:
            raise ValueError(f"审核报告引用了不存在的场景原文：{issue['filePath']}")
    return report
