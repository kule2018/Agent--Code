"""固定模型与音频替身验证流水线；不调用云端，也不启动 Docker。"""

import asyncio
import unittest

from server.sentences import SentenceBuffer
from server.turn import CancelSignal, Turn, TurnCancelled, TurnSlot
from server.voice_service import VoiceService


DECISION = {"action": "query", "sql": "SELECT 1", "metric": "未扣退款销售额", "scope": "九月已导入记录"}
RESULT = {"rows": [{"region": "华东", "sales_amount": "1599.00"}]}
TEXT = ["仅按九月已导入记录。", "华东未扣退款销售额为1599.00元。"]


class FakeModel:
    def __init__(self, chunks=TEXT, decision=DECISION):
        self.chunks, self.decision = chunks, decision
        self.explained = False
        self.closed = False

    async def decide(self, *args):
        return self.decision

    async def explain(self, *args):
        self.explained = True
        try:
            for chunk in self.chunks:
                yield chunk
        finally:
            self.closed = True


def fixture(model=None):
    model = FakeModel() if model is None else model
    async def load():
        return {"databasePath": "/unused", "context": {"rules": []}}
    async def execute(*args):
        return RESULT
    async def speak(text, signal):
        return "https://example.test/test-only.wav"
    return {"load": load, "model": lambda: model, "execute": execute, "speak": speak}


class StateTests(unittest.TestCase):
    def test_sentence_cross_chunk_and_decimal_point(self):
        buffer = SentenceBuffer()
        self.assertEqual(buffer.push("华东1599."), [])
        self.assertEqual(buffer.push("00元。华南"), ["华东1599.00元。"])
        self.assertEqual(buffer.push("798元。\n"), ["华南798元。"])
        self.assertEqual(buffer.push("范围仅含导入记录"), [])
        self.assertEqual(buffer.flush(), ["范围仅含导入记录"])
        self.assertEqual(buffer.flush(), [])

    def test_all_sentence_delimiters_and_utf16_boundary(self):
        self.assertEqual(SentenceBuffer().push("\ufeff 一。二！三？四；五\n"), ["一。", "二！", "三？", "四；", "五"])
        buffer = SentenceBuffer()
        buffer.push("😀" * 250)
        with self.assertRaisesRegex(ValueError, "单句过长"):
            buffer.push("字")

    def test_turn_replace_cancel_and_reserved_turn_id(self):
        slot, packets = TurnSlot(), []
        old = slot.begin("old", packets.append)
        old.send("answer.delta", {"turnId": "wrong"})
        new = slot.begin("new", packets.append)
        self.assertTrue(old.signal.aborted)
        old.send("audio.segment")
        slot.cancel("old")
        self.assertFalse(new.signal.aborted)
        new.send("answer.delta")
        slot.cancel("new")
        new.send("audio.segment")
        self.assertEqual([p["data"]["turnId"] for p in packets], ["old", "new"])
        for identity in (None, "", ".. /invalid", "中文", "x" * 81, "new"):
            with self.subTest(identity=identity), self.assertRaises(ValueError):
                slot.begin(identity, packets.append)


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_sentence_starts_before_model_finishes(self):
        gate, spoken_event = asyncio.Event(), asyncio.Event()
        class PausedModel(FakeModel):
            async def explain(self, *args):
                yield TEXT[0]
                await gate.wait()
                yield TEXT[1]
        packets, spoken = [], []
        deps = fixture(PausedModel())
        async def speak(text, signal):
            spoken.append(text)
            spoken_event.set()
            return "https://example.test/fake.wav"
        deps["speak"] = speak
        task = asyncio.create_task(VoiceService().answer(Turn("one", packets.append), "问题", "stream", deps))
        try:
            await asyncio.wait_for(spoken_event.wait(), 1)
            self.assertEqual(spoken, [TEXT[0]])
            self.assertFalse(any(p["event"] == "done" for p in packets))
        finally:
            gate.set()
            await task
        self.assertEqual(spoken, TEXT)
        self.assertEqual([p["data"]["seq"] for p in packets if p["event"] == "audio.segment"], [0, 1])
        self.assertEqual(packets[-1]["event"], "done")

    async def test_buffered_waits_for_full_text_and_calls_tts_once(self):
        gate, started = asyncio.Event(), asyncio.Event()
        class PausedModel(FakeModel):
            async def explain(self, *args):
                yield TEXT[0]
                started.set()
                await gate.wait()
                yield TEXT[1]
        packets, spoken = [], []
        deps = fixture(PausedModel())
        async def speak(text, signal):
            spoken.append(text)
            return "https://example.test/fake.wav"
        deps["speak"] = speak
        task = asyncio.create_task(VoiceService().answer(Turn("one", packets.append), "问题", "buffered", deps))
        try:
            await asyncio.wait_for(started.wait(), 1)
            self.assertFalse(any(p["event"] == "answer.delta" for p in packets))
            self.assertEqual(spoken, [])
        finally:
            gate.set()
            await task
        self.assertEqual(spoken, ["".join(TEXT)])
        self.assertEqual(sum(p["event"] == "answer.delta" for p in packets), 1)

    async def test_late_container_result_after_cancel_is_discarded(self):
        gate, entered = asyncio.Event(), asyncio.Event()
        model, packets = FakeModel(), []
        deps = fixture(model)
        async def execute(*args):
            entered.set()
            await gate.wait()
            return RESULT
        deps["execute"] = execute
        turn = Turn("old", packets.append)
        task = asyncio.create_task(VoiceService().answer(turn, "问题", "stream", deps))
        await asyncio.wait_for(entered.wait(), 1)
        turn.cancel()
        gate.set()
        with self.assertRaisesRegex(TurnCancelled, "本轮已停止"):
            await task
        self.assertFalse(model.explained)
        self.assertFalse(any(p["event"] in {"query.result", "audio.segment", "done"} for p in packets))

    async def test_late_tts_even_if_it_ignores_cancel_is_discarded(self):
        gate, entered = asyncio.Event(), asyncio.Event()
        packets, calls = [], []
        deps = fixture()
        async def speak(text, signal):
            calls.append(text)
            entered.set()
            await gate.wait()
            return "https://example.test/late.wav"
        deps["speak"] = speak
        turn = Turn("old", packets.append)
        task = asyncio.create_task(VoiceService().answer(turn, "问题", "stream", deps))
        await asyncio.wait_for(entered.wait(), 1)
        turn.cancel()
        gate.set()
        with self.assertRaises(TurnCancelled):
            await task
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(p["event"] in {"audio.segment", "done"} for p in packets))

    async def test_tts_failure_keeps_text_rows_and_next_segment(self):
        packets, calls = [], []
        deps = fixture()
        async def speak(text, signal):
            calls.append(text)
            if len(calls) == 1:
                raise RuntimeError("供应商不可用")
            return "https://example.test/fake.wav"
        deps["speak"] = speak
        await VoiceService().answer(Turn("one", packets.append), "问题", "stream", deps)
        self.assertEqual(calls, TEXT)
        self.assertTrue(any(p["event"] == "query.result" for p in packets))
        self.assertEqual("".join(p["data"]["text"] for p in packets if p["event"] == "answer.delta"), "".join(TEXT))
        self.assertEqual([p["data"]["seq"] for p in packets if p["event"] == "audio.segment"], [1])
        self.assertEqual([p["data"]["text"] for p in packets if p["event"] == "audio.warning"], ["第 1 段合成失败：供应商不可用"])
        self.assertEqual(packets[-1]["event"], "done")

    async def test_broken_model_stream_preserves_partial_text_not_success(self):
        class BrokenModel(FakeModel):
            async def explain(self, *args):
                try:
                    yield "仅按"
                    raise RuntimeError("流断开")
                finally:
                    self.closed = True
        model, packets = BrokenModel(), []
        with self.assertRaisesRegex(RuntimeError, "流断开"):
            await VoiceService().answer(Turn("one", packets.append), "问题", "stream", fixture(model))
        self.assertTrue(model.closed)
        self.assertTrue(any(p["event"] == "error" for p in packets))
        self.assertFalse(any(p["event"] in {"done", "audio.segment"} for p in packets))

    async def test_clarify_and_empty_do_not_explain_or_synthesize(self):
        for decision, rows in (({"action": "clarify", "question": "请补充指标。"}, RESULT["rows"]), (DECISION, [])):
            with self.subTest(action=decision["action"]):
                model, packets = FakeModel(decision=decision), []
                deps = fixture(model)
                async def execute(*args):
                    return {"rows": rows}
                async def speak(*args):
                    self.fail("不应调用 TTS")
                deps.update(execute=execute, speak=speak)
                await VoiceService().answer(Turn("one", packets.append), "问题", "stream", deps)
                self.assertFalse(model.explained)
                self.assertEqual(packets[-1]["event"], "done")

    async def test_answer_sentence_and_segment_limits_close_stream(self):
        cases = ((["字" * 601], "长度上限"), (["字" * 501], "单句过长"), (["句。" * 25], "分段过多"), (["  "], "空回答"))
        for chunks, message in cases:
            with self.subTest(message=message):
                model, packets = FakeModel(chunks), []
                with self.assertRaisesRegex(ValueError, message):
                    await VoiceService().answer(Turn("one", packets.append), "问题", "stream", fixture(model))
                self.assertTrue(model.closed)
                self.assertFalse(any(p["event"] == "done" for p in packets))
        # 24 段与 600 UTF-16 单元的完整后返回均在原例上限内。
        for chunks, mode in ((["句。" * 24], "stream"), (["😀" * 300], "buffered")):
            await VoiceService().answer(Turn("one", lambda _: None), "问题", mode, fixture(FakeModel(chunks)))

    async def test_network_signal_cancels_and_waits_for_cleanup(self):
        signal, entered, closed = CancelSignal(), asyncio.Event(), asyncio.Event()
        async def network():
            try:
                entered.set()
                await asyncio.Event().wait()
            finally:
                closed.set()
        task = asyncio.create_task(signal.run(network()))
        await entered.wait()
        signal.abort("用户取消")
        with self.assertRaisesRegex(TurnCancelled, "用户取消"):
            await task
        self.assertTrue(closed.is_set())
        async def never():
            self.fail("已经取消，不应再发请求")
        with self.assertRaises(TurnCancelled):
            await signal.run(never())


if __name__ == "__main__":
    unittest.main()
