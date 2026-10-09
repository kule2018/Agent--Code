"""浏览器的录音、提问和取消入口；连接断开也取消当前轮次。"""

import asyncio
import json

from fastapi import WebSocketDisconnect

from .asr import open_recognition
from .turn import TurnSlot
from .voice_service import VoiceService
from speech import trim_text, utf16_length


class Session:
    def __init__(self, socket, max_buffer=512000):
        self.socket = socket
        self.slot = TurnSlot()
        self.asr = None
        self.active = True
        self.max_buffer = max_buffer
        self.queued_bytes = 0
        self.outbox = asyncio.Queue()
        self.tasks = set()
        self.close_task = None
        self.sender = asyncio.create_task(self._send())

    def deliver(self, packet):
        if not self.active:
            return
        if self.queued_bytes > self.max_buffer:
            self.active = False
            self.slot.cancel()
            self.close_task = asyncio.create_task(self.socket.close())
            return
        text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        self.queued_bytes += len(text.encode("utf-8"))
        self.outbox.put_nowait(text)

    async def _send(self):
        try:
            while self.active:
                text = await self.outbox.get()
                try:
                    await self.socket.send_text(text)
                finally:
                    self.queued_bytes -= len(text.encode("utf-8"))
        except (WebSocketDisconnect, RuntimeError, OSError):
            self.active = False
            self.slot.cancel()

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        def finished(done):
            self.tasks.discard(done)
            if not done.cancelled():
                done.exception()  # 错误已经由入口回传，取出异常避免后台任务警告。
        task.add_done_callback(finished)

    async def dispose(self):
        self.active = False
        self.slot.cancel()
        # 已开始的 SQL 不强行取消，等待工作线程里的 finally 完成容器清理。
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.sender.cancel()
        await asyncio.gather(self.sender, return_exceptions=True)
        if self.close_task:
            await asyncio.gather(self.close_task, return_exceptions=True)


def ask_parameters(data):
    if not isinstance(data, dict):
        return None
    identity, question, mode = data.get("turnId"), data.get("question"), data.get("mode")
    # Zod 原例先 trim 问题再检查 2000 上限；turnId 的字符规则由 TurnSlot 检查。
    if (not isinstance(identity, str) or not 1 <= utf16_length(identity) <= 80
            or not isinstance(question, str) or not 1 <= utf16_length(trim_text(question)) <= 2000
            or mode not in ("stream", "buffered")):
        return None
    return identity, trim_text(question), mode


class VoiceGateway:
    def __init__(self, service=None, *, recognition_factory=open_recognition, turn_timeout=120, max_buffer=512000):
        self.service = VoiceService() if service is None else service
        self.recognition_factory = recognition_factory
        self.turn_timeout, self.max_buffer = turn_timeout, max_buffer
        self.sessions = {}

    def begin(self, session, identity):
        session.asr = None
        return session.slot.begin(identity, session.deliver)

    def _invalid(self, session, data, text):
        body = {"text": text}
        if isinstance(data, dict) and "turnId" in data:
            body["turnId"] = data["turnId"]
        session.deliver({"event": "error", "data": body})

    async def ask(self, session, data):
        parsed = ask_parameters(data)
        if not parsed:
            self._invalid(session, data, "问题或模式无效")
            return
        identity, question, mode = parsed
        try:
            turn = self.begin(session, identity)
        except ValueError as error:
            self._invalid(session, data, str(error))
            return
        def expired():
            turn.send("error", {"text": "本轮超过 120 秒，已停止"})
            turn.cancel()
        timer = asyncio.get_running_loop().call_later(self.turn_timeout, expired)
        try:
            await self.service.answer(turn, question, mode)
        except Exception as error:
            turn.send("error", {"text": str(error)})
            turn.cancel()
        finally:
            timer.cancel()

    async def listen(self, session, data):
        try:
            turn = self.begin(session, data.get("turnId") if isinstance(data, dict) else None)
        except ValueError as error:
            self._invalid(session, data, str(error))
            return
        try:
            # 同步创建识别会话，后台任务等待 done；接收循环仍能处理 audio/finish/cancel。
            session.asr = self.recognition_factory(turn.signal, lambda event, body=None: turn.send(event, body))
            await session.asr.done
        except Exception as error:
            turn.send("error", {"text": str(error)})
            turn.cancel()

    def audio(self, session, data):
        current = session.slot.current
        if not current or current.id != data.get("turnId") or current.signal.aborted:
            return
        try:
            if session.asr:
                session.asr.append(data.get("audio"))
        except Exception as error:
            current.send("error", {"text": str(error)})
            session.slot.cancel()

    def finish(self, session, data):
        current = session.slot.current
        if not current or current.id != data.get("turnId"):
            return
        try:
            if session.asr:
                session.asr.finish()
        except Exception as error:
            current.send("error", {"text": str(error)})
            session.slot.cancel()

    async def handle(self, socket):
        await socket.accept()
        session = Session(socket, self.max_buffer)
        self.sessions[socket] = session
        try:
            while session.active:
                message = await socket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                raw = message.get("text")
                if raw is None:
                    raw = message.get("bytes") or b""
                size = len(raw.encode("utf-8")) if isinstance(raw, str) else len(raw)
                if size > 32 * 1024:
                    await socket.close(code=1009)
                    break
                try:
                    packet = json.loads(raw)
                except (ValueError, UnicodeError):
                    continue
                if not isinstance(packet, dict):
                    continue
                event, data = packet.get("event"), packet.get("data")
                if event == "ask":
                    session.spawn(self.ask(session, data))
                elif event == "listen":
                    session.spawn(self.listen(session, data))
                elif isinstance(data, dict):
                    if event == "audio":
                        self.audio(session, data)
                    elif event == "finish":
                        self.finish(session, data)
                    elif event == "cancel" and isinstance(data.get("turnId"), str):
                        session.slot.cancel(data["turnId"])
        except WebSocketDisconnect:
            pass
        finally:
            await session.dispose()
            self.sessions.pop(socket, None)

    async def shutdown(self):
        for session in list(self.sessions.values()):
            session.slot.cancel()
            if session.active:
                await session.socket.close()
