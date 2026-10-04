"""按布尔状态筛选选项，执行选择后返回新的游戏 Session。"""

from copy import deepcopy


def start_game(game: dict) -> dict:
    return {"sceneId": game["startSceneId"], "flags": dict(game["flags"]), "history": []}


def current_scene(game: dict, session: dict) -> dict:
    for scene in game["scenes"]:
        if scene["id"] == session["sceneId"]:
            return scene
    raise ValueError(f"场景不存在：{session['sceneId']}")


def available_choices(scene: dict, flags: dict) -> list[dict]:
    return [choice for choice in scene["choices"]
            if all(flags.get(key) is value for key, value in choice["when"].items())]


def choose(game: dict, session: dict, choice_id: str) -> dict:
    scene = current_scene(game, session)
    choice = next((item for item in available_choices(scene, session["flags"])
                   if item["id"] == choice_id), None)
    if choice is None:
        raise ValueError("这个选项当前不可选。")
    if not any(item["id"] == choice["to"] for item in game["scenes"]):
        raise ValueError(f"选项目标不存在：{choice['to']}")
    return {
        "sceneId": choice["to"],
        "flags": {**session["flags"], **choice["effects"]},
        "history": [*deepcopy(session["history"]), {"sceneId": scene["id"], "choiceId": choice_id}],
    }
