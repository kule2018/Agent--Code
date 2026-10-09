"""本机假 ASR 与纯状态验证：真实 WebSocket 通信，但没有云端调用。"""

import asyncio
import base64
import json
import unittest
from types import SimpleNamespace
from uuid import UUID

from websockets.asyncio.server import serve

from server.asr import Recognition, asr_config, open_recognition
from server.turn import CancelSignal, TurnCancelled


ENV = {"DASHSCOPE_API_KEY": "fake-key", "DASHSCOPE_BASE_URL": "https://test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"}


def state(emit=lambda *_: None):
    result = Recognition.__new__(Recognition)
    result.ready, result.ending, result.settled = True, False, False
    result.items, result.bytes, result.queued_bytes = {}, 0, 0
    result.emit, result.outbox = emit, asyncio.Queue()
    result.socket = SimpleNamespace(transport=SimpleNamespace(get_write_buffer_size=lambda: 0))
    return result


class AsrStateTests(unittest.TestCase):
    def test_config_domains_and_no_arbitrary_key_destination(self):
        self.assertEqual(asr_config(ENV), {"key": "fake-key", "url": "wss://test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime"})
        for base in ("https://dashscope.aliyuncs.com/compatible-mode/v1/",
                     "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                     "https://test.ap-southeast-1.maas.aliyuncs.com:443/compatible-mode/v1"):
            self.assertTrue(asr_config({**ENV, "DASHSCOPE_BASE_URL": base})["url"].startswith("wss://"))
        for base in ("https://evil.test/compatible-mode/v1", "http://dashscope.aliyuncs.com/compatible-mode/v1",
                     "https://u@dashscope.aliyuncs.com/compatible-mode/v1", ENV["DASHSCOPE_BASE_URL"] + "?x=1",
                     "https://dashscope.aliyuncs.com:8000/compatible-mode/v1"):
            with self.subTest(base=base), self.assertRaisesRegex(ValueError, "真实兼容接口"):
                asr_config({**ENV, "DASHSCOPE_BASE_URL": base})
        with self.assertRaisesRegex(ValueError, "请配置"):
            asr_config({})

    def test_partial_final_accumulation_and_late_partial_is_ignored(self):
        events = []
        recognition = state(lambda event, data: events.append((event, data)))
        recognition.handle_event({"type": "conversation.item.created", "item": {"id": "first"}})
        recognition.handle_event({"type": "conversation.item.input_audio_transcription.completed", "item_id": "first", "transcript": " 九月 "})
        recognition.handle_event({"type": "conversation.item.input_audio_transcription.text", "item_id": "first", "text": "错误覆盖"})
        recognition.handle_event({"type": "conversation.item.input_audio_transcription.text", "item_id": "second", "text": "销售", "stash": "额"})
        with self.assertRaisesRegex(ValueError, "未收到完整识别"):
            recognition.handle_event({"type": "session.finished"})
        recognition.handle_event({"type": "conversation.item.input_audio_transcription.completed", "item_id": "second", "transcript": "销售额"})
        self.assertTrue(recognition.handle_event({"type": "session.finished"}))
        self.assertEqual(events[-1], ("asr.final", {"text": "九月销售额"}))
        self.assertFalse(any("错误覆盖" in data.get("text", "") for _, data in events))

    def test_missing_item_provider_errors_and_empty_final_are_rejected(self):
        for event, message in (({"type": "conversation.item.input_audio_transcription.text"}, "缺少句子编号"),
                               ({"type": "conversation.item.input_audio_transcription.completed"}, "缺少句子编号"),
                               ({"type": "error", "error": {"message": "fake upstream error"}}, "fake upstream error"),
                               ({"type": "session.finished"}, "未收到完整识别")):
            with self.subTest(event=event), self.assertRaisesRegex(Exception, message):
                state().handle_event(event)

    def test_item_and_text_limits(self):
        recognition = state()
        for index in range(100):
            recognition.handle_event({"type": "conversation.item.created", "item": {"id": str(index)}})
        with self.assertRaisesRegex(ValueError, "识别内容过长"):
            recognition.handle_event({"type": "conversation.item.created", "item": {"id": "101"}})
        recognition = state()
        recognition.handle_event({"type": "conversation.item.input_audio_transcription.text", "item_id": "1", "text": "😀" * 1000})
        with self.assertRaisesRegex(ValueError, "识别内容过长"):
            recognition.handle_event({"type": "conversation.item.input_audio_transcription.text", "item_id": "1", "text": "😀" * 1001})

    def test_audio_validation_accumulation_and_finish_once(self):
        recognition = state()
        for audio in (None, "", "A===", "invalid?", "A" * 24001):
            with self.subTest(audio_type=type(audio).__name__), self.assertRaisesRegex(ValueError, "音频块格式错误"):
                recognition.append(audio)
        with self.assertRaisesRegex(ValueError, "录音格式错误"):
            state().append(base64.b64encode(bytes(1)).decode())
        with self.assertRaisesRegex(ValueError, "录音过短"):
            recognition.finish()
        recognition.append(base64.b64encode(bytes(3200)).decode())
        recognition.finish()
        recognition.finish()
        self.assertEqual(recognition.outbox.qsize(), 2)
        packets = [json.loads(recognition.outbox.get_nowait()) for _ in range(2)]
        self.assertEqual([p["type"] for p in packets], ["input_audio_buffer.append", "session.finish"])
        for packet in packets:
            UUID(packet["event_id"])
        with self.assertRaisesRegex(ValueError, "不能接收音频"):
            recognition.append("AAAA")
        recognition = state()
        recognition.bytes = 16000 * 2 * 31
        with self.assertRaisesRegex(ValueError, "超过 30 秒"):
            recognition.append("AAA=")
        recognition = state()
        recognition.queued_bytes = 128001
        with self.assertRaisesRegex(ValueError, "网络发送过慢"):
            recognition.append("AAA=")


class AsrWireTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_loopback_protocol_headers_preview_final_and_close(self):
        received, events = [], []
        ready, closed = asyncio.Event(), asyncio.Event()
        async def handler(socket):
            self.assertEqual(socket.request.headers["Authorization"], "Bearer fake-key")
            self.assertEqual(socket.request.headers["OpenAI-Beta"], "realtime=v1")
            try:
                async for raw in socket:
                    message = json.loads(raw)
                    received.append(message)
                    if message["type"] == "session.update":
                        await socket.send(json.dumps({"type": "session.updated"}))
                    if message["type"] == "input_audio_buffer.append":
                        for event in (
                            {"type": "conversation.item.input_audio_transcription.text", "item_id": "first", "text": "九月", "stash": "华东"},
                            {"type": "conversation.item.input_audio_transcription.completed", "item_id": "first", "transcript": "九月华东"},
                            {"type": "conversation.item.input_audio_transcription.text", "item_id": "second", "text": "销售", "stash": "额"},
                        ):
                            await socket.send(json.dumps(event))
                    if message["type"] == "session.finish":
                        await socket.send(json.dumps({"type": "conversation.item.input_audio_transcription.completed", "item_id": "second", "transcript": "销售额"}))
                        await socket.send(json.dumps({"type": "session.finished"}))
            finally:
                closed.set()
        def emit(event, body):
            events.append((event, body.get("text")))
            if event == "asr.ready":
                ready.set()
        async with serve(handler, "127.0.0.1", 0) as server:
            uri = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            recognition = open_recognition(CancelSignal(), emit, {"url": uri, "key": "fake-key"})
            await asyncio.wait_for(ready.wait(), 1)
            recognition.append(base64.b64encode(bytes(3200)).decode())
            recognition.finish()
            await asyncio.wait_for(recognition.done, 2)
            await asyncio.wait_for(closed.wait(), 1)
        self.assertEqual(received[0]["session"], {"input_audio_format": "pcm", "sample_rate": 16000,
                         "input_audio_transcription": {"language": "zh"},
                         "turn_detection": {"type": "server_vad", "threshold": 0, "silence_duration_ms": 600}})
        self.assertEqual([m["type"] for m in received], ["session.update", "input_audio_buffer.append", "session.finish"])
        self.assertEqual(events, [("asr.ready", None), ("asr.partial", "九月华东"), ("asr.partial", "九月华东"),
                                  ("asr.partial", "九月华东销售额"), ("asr.partial", "九月华东销售额"), ("asr.final", "九月华东销售额")])

    async def test_cancel_closes_upstream_websocket(self):
        connected, closed = asyncio.Event(), asyncio.Event()
        async def handler(socket):
            connected.set()
            await socket.wait_closed()
            closed.set()
        async with serve(handler, "127.0.0.1", 0) as server:
            signal = CancelSignal()
            recognition = open_recognition(signal, lambda *_: None,
                                           {"url": f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}", "key": "fake"})
            await asyncio.wait_for(connected.wait(), 1)
            signal.abort("用户取消")
            with self.assertRaisesRegex(TurnCancelled, "用户取消"):
                await asyncio.wait_for(recognition.done, 2)
            await asyncio.wait_for(closed.wait(), 1)

    async def test_timeout_and_premature_close_do_not_emit_final(self):
        for early_close in (False, True):
            async def handler(socket):
                if early_close:
                    await socket.close()
                else:
                    await socket.wait_closed()
            events = []
            async with serve(handler, "127.0.0.1", 0) as server:
                recognition = open_recognition(CancelSignal(), lambda *args: events.append(args),
                                               {"url": f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}", "key": "fake"}, timeout=0.03)
                with self.assertRaisesRegex(Exception, "提前关闭" if early_close else "识别超时"):
                    await asyncio.wait_for(recognition.done, 2)
            self.assertEqual(events, [])

    async def test_handshake_redirect_is_not_followed(self):
        calls = []
        async def unexpected(socket):
            calls.append("redirect followed")
        async with serve(unexpected, "127.0.0.1", 0) as destination:
            async def redirect(socket, request):
                response = socket.respond(302, "redirect")
                response.headers["Location"] = f"ws://127.0.0.1:{destination.sockets[0].getsockname()[1]}"
                return response
            async with serve(unexpected, "127.0.0.1", 0, process_request=redirect) as server:
                recognition = open_recognition(CancelSignal(), lambda *_: None,
                                               {"url": f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}", "key": "fake"})
                with self.assertRaisesRegex(Exception, "302"):
                    await recognition.done
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
