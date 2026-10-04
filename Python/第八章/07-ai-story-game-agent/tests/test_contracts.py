"""分支验收、状态条件、批准大纲和报告引用的确定性测试。"""

import unittest
from copy import deepcopy

from pydantic import ValidationError

from server.src.contracts import (BriefSchema, SceneSchema, assert_outline, assert_review, assert_scene,
                                  game_from_outline, validate_game)
from server.src.replay import (defect_quote, replay_brief, replay_characters, replay_outline,
                              replay_report, replay_scenes)
from shared.engine import available_choices, choose, current_scene, start_game


def game():
    return game_from_outline(replay_brief, replay_outline, replay_characters, replay_scenes())


class ContractTests(unittest.TestCase):
    def test_all_three_endings_are_actually_reachable(self):
        assert_outline(replay_brief, replay_outline, replay_characters)
        value = game()
        paths = validate_game(value)
        self.assertEqual(paths, {
            "ending-01": ["scene-01:repair", "scene-02:control", "scene-04:restart"],
            "ending-02": ["scene-01:medical", "scene-03:control", "scene-04:sleep"],
            "ending-03": ["scene-01:medical", "scene-03:consult", "scene-05:team"],
        })
        for ending, path in paths.items():
            session = start_game(value)
            for step in path:
                scene_id, choice_id = step.split(":")
                self.assertEqual(session["sceneId"], scene_id)
                session = choose(value, session, choice_id)
            self.assertEqual(session["sceneId"], ending)
            self.assertTrue(current_scene(value, session)["ending"])

    def test_prior_choice_changes_control_room_options_without_mutating_history(self):
        value = game()
        original = start_game(value)
        with_key = choose(value, choose(value, original, "repair"), "control")
        without_key = choose(value, choose(value, original, "medical"), "control")
        self.assertEqual([item["id"] for item in available_choices(current_scene(value, with_key), with_key["flags"])],
                         ["restart", "sleep"])
        self.assertEqual([item["id"] for item in available_choices(current_scene(value, without_key), without_key["flags"])],
                         ["sleep"])
        with self.assertRaisesRegex(ValueError, "不可选"):
            choose(value, without_key, "restart")
        self.assertEqual(original, start_game(value))

    def test_missing_target_unknown_flag_and_duplicate_ids(self):
        value = game()
        value["scenes"][0]["choices"][0]["to"] = "missing"
        with self.assertRaisesRegex(ValueError, "不存在"):
            validate_game(value)
        value = game()
        value["scenes"][3]["choices"][0]["when"] = {"unavailable": True}
        with self.assertRaisesRegex(ValueError, "未知状态"):
            validate_game(value)
        value = game()
        value["scenes"][7]["id"] = "ending-02"
        with self.assertRaisesRegex(ValueError, "ID 重复"):
            validate_game(value)

    def test_cycle_dead_end_and_conditionally_unreachable_scene(self):
        value = game()
        value["scenes"][1]["choices"][0]["to"] = "scene-01"
        with self.assertRaisesRegex(ValueError, "循环"):
            validate_game(value)
        value = game()
        for choice in value["scenes"][1]["choices"]:
            choice["when"] = {"hasKey": False}
        with self.assertRaisesRegex(ValueError, "没有可选项"):
            validate_game(value)
        value = game()
        value["scenes"][3]["choices"][0]["when"] = {"hasKey": True, "trustedEngineer": True}
        with self.assertRaisesRegex(ValueError, "状态条件"):
            validate_game(value)

    def test_structure_cannot_change_but_dictionary_order_can(self):
        value = replay_scenes()[0]
        reordered = {**value, "choices": [{key: item[key] for key in reversed(item)} for item in value["choices"]]}
        self.assertEqual(assert_scene(replay_outline, reordered, value["id"]), value)
        altered = deepcopy(value)
        altered["choices"][0]["to"] = "ending-01"
        with self.assertRaisesRegex(ValueError, "分支结构"):
            assert_scene(replay_outline, altered, value["id"])

    def test_review_requires_real_quote_and_matching_verdict(self):
        scenes = replay_scenes(True)
        self.assertIn(defect_quote, scenes[6]["content"])
        self.assertEqual(len(assert_review(replay_report(True), scenes)["issues"]), 1)
        forged = replay_report(True)
        forged["issues"][0]["quote"] = "不存在的原文"
        with self.assertRaisesRegex(ValueError, "引用了不存在"):
            assert_review(forged, scenes)
        with self.assertRaisesRegex(ValueError, "不一致"):
            assert_review({**replay_report(True), "verdict": "approved"}, scenes)

    def test_schema_rejects_wrong_types_extra_fields_and_trims_brief(self):
        with self.assertRaises(ValidationError):
            SceneSchema.parse({**replay_scenes()[0], "ending": "false"})
        with self.assertRaises(ValidationError):
            SceneSchema.parse({**replay_scenes()[0], "script": "not allowed"})
        self.assertEqual(BriefSchema.parse({**replay_brief, "title": "  失联太空站  "}), replay_brief)
        with self.assertRaises(ValidationError):
            BriefSchema.parse({**replay_brief, "characterCount": True})

    def test_text_lengths_use_same_utf16_units_as_node(self):
        self.assertEqual(BriefSchema.parse({**replay_brief, "title": "😀"})["title"], "😀")
        with self.assertRaises(ValidationError):
            BriefSchema.parse({**replay_brief, "title": "😀" * 41})
        scene = {**replay_scenes()[0], "content": "😀" * 15}
        self.assertEqual(SceneSchema.parse(scene)["content"], "😀" * 15)
