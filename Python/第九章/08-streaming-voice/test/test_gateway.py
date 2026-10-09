"""仅启停本测试自己的随机本机端口；验证真实 HTTP/WebSocket 与取消并发。"""

import asyncio
import json
import socket
import unittest

import httpx2
import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from server.main import create_app
from server.turn import TurnCancelled
from server.voice_gateway import Session, VoiceGateway, ask_parameters
from server.voice_service import VoiceService
from test_streaming import DECISION, RESULT, FakeModel, fixture


class FakeService:
    def __init__(self):
        self.sql_entered, self.sql_release, self.sql_finished = (asyncio.Event() for _ in range(3))
        self.stream_entered, self.stream_closed = asyncio.Event(), asyncio.Event()
        self.questions = []

    async def answer(self, turn, question, mode):
        self.questions.append((turn.id, question, mode))
        service = self
        class PausedModel(FakeModel):
            async def explain(self, *args):
                try:
                    yield "仅按已导入"
                    service.stream_entered.set()
                    await turn.signal.run(asyncio.Event().wait())
                finally:
                    service.stream_closed.set()
        deps = fixture(PausedModel() if question == "慢回答" else FakeModel())
        if question == "慢查询":
            async def execute(*args):
                self.sql_entered.set()
                try:
                    await self.sql_release.wait()
                    return RESULT
                finally:
                    self.sql_finished.set()
            deps["execute"] = execute
        await VoiceService().answer(turn, question, mode, deps)


class FakeRecognition:
    def __init__(self, signal, emit):
        self.signal, self.emit = signal, emit
        self.audio = []
        self.finished, self.closed = asyncio.Event(), asyncio.Event()
        emit("asr.ready", {})
        self.done = asyncio.create_task(self.run())

    async def run(self):
        try:
            await self.signal.run(self.finished.wait())
        finally:
            self.closed.set()

    def append(self, audio):
        if audio == "bad":
            raise ValueError("音频块格式错误")
        self.audio.append(audio)
        self.emit("asr.partial", {"text": "各区域销售额"})

    def finish(self):
        self.emit("asr.final", {"text": "各区域销售额"})
        self.finished.set()


class GatewayWireTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.service = FakeService()
        self.recognitions = []
        def recognition(signal, emit):
            result = FakeRecognition(signal, emit)
            self.recognitions.append(result)
            return result
        self.gateway = VoiceGateway(self.service, recognition_factory=recognition)
        self.app = create_app(self.gateway, env={})
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.port = self.listener.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(
            self.app, log_level="critical", ws="websockets-sansio", ws_max_size=32 * 1024,
            lifespan="on", timeout_graceful_shutdown=2,
        ))
        self.running = asyncio.create_task(self.server.serve(sockets=[self.listener]))
        async with asyncio.timeout(2):
            while not self.server.started:
                if self.running.done():
                    await self.running
                await asyncio.sleep(0.005)

    async def asyncTearDown(self):
        self.service.sql_release.set()
        self.server.should_exit = True
        await asyncio.wait_for(self.running, 3)
        self.listener.close()
        self.assertEqual(self.gateway.sessions, {})

    def websocket(self, **kwargs):
        return connect(f"ws://127.0.0.1:{self.port}/voice", origin="http://localhost:5186", proxy=None, **kwargs)

    async def send(self, ws, event, data):
        await ws.send(json.dumps({"event": event, "data": data}, ensure_ascii=False))

    async def ask(self, ws, identity, question="正常查询", mode="stream"):
        await self.send(ws, "ask", {"turnId": identity, "question": question, "mode": mode})

    async def receive(self, ws):
        return json.loads(await asyncio.wait_for(ws.recv(), 1))

    async def until(self, ws, event):
        packets = []
        async with asyncio.timeout(2):
            while True:
                packet = await self.receive(ws)
                packets.append(packet)
                if packet["event"] == event:
                    return packets

    async def test_health_and_real_websocket_event_envelopes(self):
        async with httpx2.AsyncClient(trust_env=False) as client:
            response = await client.get(f"http://127.0.0.1:{self.port}/api/health")
            self.assertEqual(response.json(), {"ok": True})
        async with self.websocket() as ws:
            await self.ask(ws, "query-1", "  正常查询  ")
            packets = await self.until(ws, "done")
        self.assertTrue(all(p["data"]["turnId"] == "query-1" for p in packets))
        self.assertEqual(self.service.questions, [("query-1", "正常查询", "stream")])
        self.assertEqual(next(p["data"]["rows"] for p in packets if p["event"] == "query.result"), RESULT["rows"])
        self.assertEqual([p["data"]["seq"] for p in packets if p["event"] == "audio.segment"], [0, 1])
        self.assertLess(next(i for i, p in enumerate(packets) if p["event"] == "text.done"), len(packets) - 1)

    async def test_origin_and_host_are_rejected_before_accept(self):
        url = f"ws://127.0.0.1:{self.port}/voice"
        for origin in (None, "https://localhost:5186", "http://localhost:5185", "http://evil.test:5186"):
            with self.subTest(origin=origin), self.assertRaises(InvalidStatus) as caught:
                async with connect(url, origin=origin, proxy=None):
                    self.fail("不应接受来源")
            self.assertEqual(caught.exception.response.status_code, 403)
        # 普通 HTTP Host 不是 URL 的网关路由；直接构造握手检查 Host 白名单。
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(("GET /voice HTTP/1.1\r\nHost: evil.test\r\nUpgrade: websocket\r\n"
                      "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                      "Origin: http://localhost:5186\r\n\r\n").encode())
        await writer.drain()
        self.assertIn(b"403", await asyncio.wait_for(reader.readline(), 1))
        writer.close()
        await writer.wait_closed()
        self.assertEqual(self.service.questions, [])

    async def test_invalid_requests_duplicate_id_and_oversized_frame(self):
        async with self.websocket() as ws:
            for data, message in (({}, "问题或模式无效"),
                                  ({"turnId": "invalid/id", "question": "问题", "mode": "stream"}, "turnId 无效"),
                                  ({"turnId": "one", "question": "问题", "mode": "wrong"}, "问题或模式无效")):
                await self.send(ws, "ask", data)
                self.assertEqual((await self.receive(ws))["data"]["text"], message)
            await ws.send("not-json")
            await ws.send("[]")
            await self.ask(ws, "one")
            await self.until(ws, "done")
            await self.ask(ws, "one")
            self.assertEqual((await self.receive(ws))["data"]["text"], "每轮需要使用新的 turnId")
        async with self.websocket() as ws:
            await ws.send("x" * (32 * 1024 + 1))
            with self.assertRaises(ConnectionClosed) as caught:
                await ws.recv()
            self.assertEqual(caught.exception.rcvd.code, 1009)

    async def test_cancel_during_sql_keeps_reader_responsive_and_discards_late_result(self):
        async with self.websocket() as ws:
            await self.ask(ws, "old", "慢查询")
            await asyncio.wait_for(self.service.sql_entered.wait(), 1)
            await self.send(ws, "cancel", {"turnId": "old"})
            await self.ask(ws, "new")
            packets = await self.until(ws, "done")
            self.assertFalse(self.service.sql_finished.is_set())
            self.service.sql_release.set()
            await asyncio.wait_for(self.service.sql_finished.wait(), 1)
            # 再发一轮充当屏障；旧查询不能在后续结果中插入 query.result/done。
            await self.ask(ws, "third")
            packets += await self.until(ws, "done")
        self.assertFalse(any(p["data"].get("turnId") == "old" and p["event"] not in {"status"} for p in packets))
        self.assertEqual([p["data"]["turnId"] for p in packets if p["event"] == "done"], ["new", "third"])

    async def test_cancel_stream_closes_model_before_next_question(self):
        async with self.websocket() as ws:
            await self.ask(ws, "old", "慢回答")
            packets = await self.until(ws, "answer.delta")
            await self.send(ws, "cancel", {"turnId": "wrong"})
            self.assertFalse(self.service.stream_closed.is_set())
            await self.send(ws, "cancel", {"turnId": "old"})
            await asyncio.wait_for(self.service.stream_closed.wait(), 1)
            await self.ask(ws, "new", mode="buffered")
            packets += await self.until(ws, "done")
        self.assertEqual([p["data"]["turnId"] for p in packets if p["event"] == "done"], ["new"])

    async def test_recognition_partial_finish_cancel_and_old_audio(self):
        async with self.websocket() as ws:
            await self.send(ws, "listen", {"turnId": "listen-1"})
            self.assertEqual((await self.receive(ws))["event"], "asr.ready")
            await self.send(ws, "audio", {"turnId": "wrong", "audio": "ignored"})
            await self.send(ws, "audio", {"turnId": "listen-1", "audio": "AAAA"})
            self.assertEqual((await self.receive(ws))["event"], "asr.partial")
            await self.send(ws, "finish", {"turnId": "listen-1"})
            self.assertEqual((await self.receive(ws))["event"], "asr.final")
            await self.send(ws, "listen", {"turnId": "listen-2"})
            await self.receive(ws)
            await self.send(ws, "cancel", {"turnId": "listen-2"})
            await asyncio.wait_for(self.recognitions[1].closed.wait(), 1)
            await self.ask(ws, "query")
            packets = await self.until(ws, "done")
        self.assertEqual(self.recognitions[0].audio, ["AAAA"])
        self.assertEqual(self.service.questions, [("query", "正常查询", "stream")])
        self.assertTrue(all(p["data"]["turnId"] == "query" for p in packets))

    async def test_disconnect_cancels_recognition_and_connections_are_independent(self):
        async with self.websocket() as a, self.websocket() as b:
            await self.send(a, "listen", {"turnId": "same-id"})
            await self.receive(a)
            await self.ask(b, "same-id")
            await self.until(b, "done")
            self.assertFalse(self.recognitions[0].closed.is_set())
            await a.close()
            await asyncio.wait_for(self.recognitions[0].closed.wait(), 1)
            await self.ask(b, "next")
            await self.until(b, "done")

    async def test_turn_timeout_cancels_incomplete_model_without_done(self):
        self.gateway.turn_timeout = 0.03
        async with self.websocket() as ws:
            await self.ask(ws, "timeout", "慢回答")
            packets = await self.until(ws, "error")
            self.assertEqual(packets[-1]["data"]["text"], "本轮超过 120 秒，已停止")
            await asyncio.wait_for(self.service.stream_closed.wait(), 1)
        self.assertFalse(any(p["event"] in {"done", "audio.segment"} for p in packets))


class GatewayBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def test_question_trim_utf16_and_schema(self):
        self.assertEqual(ask_parameters({"turnId": "a", "question": " " * 3000 + "问" + " " * 3000, "mode": "stream"}), ("a", "问", "stream"))
        self.assertIsNotNone(ask_parameters({"turnId": "a", "question": "😀" * 1000, "mode": "stream"}))
        for question in ("😀" * 1001, "\ufeff \n", None, 123):
            self.assertIsNone(ask_parameters({"turnId": "a", "question": question, "mode": "stream"}))

    async def test_backpressure_closes_own_socket_and_cancels_turn(self):
        class SlowSocket:
            def __init__(self):
                self.entered, self.closed = asyncio.Event(), asyncio.Event()
            async def send_text(self, text):
                self.entered.set()
                await asyncio.Event().wait()
            async def close(self):
                self.closed.set()
        socket = SlowSocket()
        session = Session(socket, max_buffer=60)
        turn = session.slot.begin("one", session.deliver)
        turn.send("answer.delta", {"text": "x" * 100})
        await socket.entered.wait()
        turn.send("answer.delta", {"text": "next"})
        await asyncio.wait_for(socket.closed.wait(), 1)
        self.assertTrue(turn.signal.aborted)
        self.assertFalse(session.active)
        await session.dispose()


if __name__ == "__main__":
    unittest.main()
