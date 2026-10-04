"""固定失联太空站样本；Replay 不使用模型，预设缺陷也明确标记。"""

import json
import re
from copy import deepcopy
from pathlib import Path

_data = json.loads(Path(__file__).with_name("replay_data.json").read_text(encoding="utf-8"))
replay_brief = _data["brief"]
replay_world = _data["world"]
replay_characters = _data["characters"]
replay_outline = _data["outline"]
defect_quote = _data["defectQuote"]


def replay_revised_outline(feedback: str) -> dict:
    outline = deepcopy(replay_outline)
    if re.search("代价", feedback):
        scene_id = "ending-01"
        summary = "修复空气循环以后，船员保住清醒维修的机会；食物消耗加快，而且所有设备都只能由站内人员维护。"
    elif re.search("悬疑|紧张", feedback):
        scene_id = "scene-03"
        summary = "休眠舱忽然传来断续的敲击声。苏雅检查医疗储备，船员情绪越来越紧张，玩家必须决定如何调查下一步。"
    else:
        raise ValueError("Replay 只演示“明确结局代价”或“增加悬疑感”的大纲修改；自定义要求请使用 AI 模式。")
    next(item for item in outline["scenes"] if item["id"] == scene_id)["summary"] = summary
    return outline


def replay_scenes(defect: bool = False) -> list[dict]:
    scenes = deepcopy(_data["scenes"])
    if defect:
        next(item for item in scenes if item["id"] == "ending-02")["content"] = (
            "林澜让大家进入休眠，维修暂时停止。" + defect_quote
        )
    return scenes


def replay_report(defect: bool) -> dict:
    return {"verdict": "needs_revision", "issues": [{
        "filePath": "/scenes/ending-02.json", "rule": replay_world["rules"][0], "quote": defect_quote,
        "reason": "这个结局依靠对外通信和救援飞船解决困境，违反失联世界规则。",
        "suggestion": "去掉外部救援，保留休眠降低消耗和维修停滞的代价。",
    }]} if defect else {"verdict": "approved", "issues": []}


def replay_revised_scene(scene_id: str, instruction: str | None = None) -> dict:
    base = next((item for item in replay_scenes() if item["id"] == scene_id), None)
    if base is None:
        raise ValueError(f"Replay 没有场景 {scene_id}。")
    if instruction and not re.search("紧张|悬疑|压迫|对话|细节|更简洁", instruction):
        raise ValueError("Replay 只演示固定场景的表达调整；自定义要求请使用 AI 模式。")
    if instruction:
        base["content"] = ("警报声一遍遍撞向舱壁，林澜看见每个人都在等她作出决定。" +
                           base["content"] + "她把话压低，说出这个选择的代价。")
    return base
