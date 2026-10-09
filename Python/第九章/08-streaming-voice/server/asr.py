"""把 PCM 音频块交给实时 ASR，分别回传预览文本和最终文本。"""

import asyncio
import base64
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from .turn import event_id


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "07-voice-interaction"))
from speech import _trusted_url, trim_text, utf16_length  # noqa: E402


def asr_config(env=None):
    """从 07 已使用的兼容地址取得同地域 WebSocket 地址，Key 始终留在服务端。"""
    env = os.environ if env is None else env
    if not env.get("DASHSCOPE_API_KEY") or not env.get("DASHSCOPE_BASE_URL"):
        raise ValueError("请配置 DASHSCOPE_API_KEY 和 DASHSCOPE_BASE_URL")
    try:
        base = _trusted_url(env["DASHSCOPE_BASE_URL"])
    except ValueError as error:
        raise ValueError("请填写百炼北京或新加坡地域的真实兼容接口地址") from error
    return {"key": env["DASHSCOPE_API_KEY"],
            "url": f"wss://{urlsplit(base).netloc}/api-ws/v1/realtime?model=qwen3-asr-flash-realtime"}


class _NoRedirectConnect(connect):
    def process_redirect(self, error):
        # websockets 17.2 默认支持握手重定向；本例与 ws 默认行为一致，直接拒绝。
        return error


class Recognition:
    def __init__(self, signal, emit, config, connect_impl, timeout):
        signal.throw_if_aborted()
        self.signal, self.emit, self.config = signal, emit, config
        self.connect_impl, self.timeout = connect_impl, timeout
        self.ready = self.ending = self.settled = False
        self.bytes = 0
        self.items = {}  # 按 item_id 保留插入顺序，临时结果不能覆盖已确认的句子。
        self.socket = None
        self.outbox = asyncio.Queue()
        self.queued_bytes = 0
        self.done = asyncio.create_task(self._run())

    def preview(self):
        return "".join(item["text"] for item in self.items.values())

    def _packet(self, kind, body=None):
        return json.dumps({"event_id": event_id(), "type": kind, **(body or {})},
                          ensure_ascii=False, separators=(",", ":"))

    def _enqueue(self, kind, body=None):
        text = self._packet(kind, body)
        self.queued_bytes += len(text.encode("utf-8"))
        self.outbox.put_nowait(text)

    async def _sender(self):
        while True:
            text = await self.outbox.get()
            try:
                await self.socket.send(text)
            finally:
                self.queued_bytes -= len(text.encode("utf-8"))

    async def _run(self):
        try:
            # 最长等待 45 秒；取消时关闭连接，不伪造最终识别文字。
            async with asyncio.timeout(self.timeout):
                await self.signal.run(self._recognize())
        except TimeoutError as error:
            raise RuntimeError("识别超时，请重新录音") from error
        except ConnectionClosed as error:
            # 上游也可能在 session.update 发出前就断开；统一提示，不产生 asr.final。
            raise RuntimeError("识别连接提前关闭，请重新录音") from error
        finally:
            self.settled = True

    async def _recognize(self):
        async with self.connect_impl(
            self.config["url"],
            additional_headers={"Authorization": f"Bearer {self.config['key']}", "OpenAI-Beta": "realtime=v1"},
            open_timeout=10, max_size=256 * 1024, proxy=None, ping_interval=None,
        ) as socket:
            self.socket = socket
            # 建立连接后先配置 16kHz/PCM/中文与服务端 VAD，再接收音频。
            await socket.send(self._packet("session.update", {"session": {
                "input_audio_format": "pcm", "sample_rate": 16000,
                "input_audio_transcription": {"language": "zh"},
                "turn_detection": {"type": "server_vad", "threshold": 0, "silence_duration_ms": 600},
            }}))
            sender = asyncio.create_task(self._sender())
            receiver = asyncio.create_task(self._receive(socket))
            try:
                # 发送失败也要结束接收，不能只等待上游最终文字直到超时。
                done, _ = await asyncio.wait((sender, receiver), return_when=asyncio.FIRST_COMPLETED)
                if sender in done:
                    await sender
                await receiver
            finally:
                sender.cancel()
                receiver.cancel()
                await asyncio.gather(sender, receiver, return_exceptions=True)
                self.socket = None

    async def _receive(self, socket):
        async for raw in socket:
            if self.handle_event(json.loads(raw)):
                return
        raise RuntimeError("识别连接提前关闭，请重新录音")

    def handle_event(self, event):
        """更新各句文本；只有 session.finished 且所有非空句都已确认，才发 asr.final。"""
        kind = event.get("type")
        if kind == "session.updated" and not self.ready:
            self.ready = True
            self.emit("asr.ready", {})
        item = event.get("item") or {}
        if kind == "conversation.item.created" and item.get("id") and item["id"] not in self.items:
            self.items[item["id"]] = {"text": "", "final": False}
        if kind in {"conversation.item.input_audio_transcription.text", "conversation.item.input_audio_transcription.completed"}:
            identity = event.get("item_id")
            if not identity:
                raise ValueError("识别结果缺少句子编号")
            if kind.endswith(".text"):
                if not (self.items.get(identity) or {}).get("final"):
                    self.items[identity] = {"text": (event.get("text") or "") + (event.get("stash") or ""), "final": False}
                    self.emit("asr.partial", {"text": self.preview()})
            else:
                self.items[identity] = {"text": trim_text(str(event.get("transcript") or "")), "final": True}
                self.emit("asr.partial", {"text": self.preview()})
        if kind in {"conversation.item.input_audio_transcription.failed", "error"}:
            raise RuntimeError((event.get("error") or {}).get("message") or "ASR 服务返回错误")
        if len(self.items) > 100 or utf16_length(self.preview()) > 2000:
            raise ValueError("识别内容过长，请缩短问题")
        if kind == "session.finished":
            text = trim_text(self.preview())
            if not text or any(item["text"] and not item["final"] for item in self.items.values()):
                raise ValueError("未收到完整识别结果，请重新录音")
            self.emit("asr.final", {"text": text})
            return True
        return False

    def append(self, audio):
        if not self.ready or self.ending or self.settled:
            raise ValueError("当前识别会话不能接收音频")
        if not isinstance(audio, str) or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", audio) or len(audio) > 24000:
            raise ValueError("音频块格式错误")
        # 对齐 Buffer.from 的宽松 Base64 解码；浏览器正常发送的是带 padding 的完整块。
        data = audio.rstrip("=")
        if len(data) % 4 == 1:
            data = data[:-1]
        chunk = base64.b64decode(data + "=" * (-len(data) % 4))
        self.bytes += len(chunk)
        if len(chunk) % 2 or self.bytes > 16000 * 2 * 31:
            raise ValueError("录音格式错误或超过 30 秒")
        buffered = self.socket.transport.get_write_buffer_size() if self.socket else 0
        if buffered + self.queued_bytes > 128000:
            raise ValueError("网络发送过慢，请重新录音")
        # Python send 是异步的：排队后立即返回，保持网关仍能接收 cancel。
        self._enqueue("input_audio_buffer.append", {"audio": audio})

    def finish(self):
        if self.ending or self.settled:
            return
        if not self.ready or self.bytes < 3200:
            raise ValueError("录音过短，请至少说一句完整的问题")
        self.ending = True
        # VAD 由服务端提交各句；结束整段录音只发 session.finish，不发 commit。
        self._enqueue("session.finish")


def open_recognition(signal, emit, config=None, *, connect_impl=_NoRedirectConnect, timeout=45):
    signal.throw_if_aborted()
    return Recognition(signal, emit, asr_config() if config is None else config, connect_impl, timeout)
