"""一轮任务的取消信号与事件出口；旧轮次不能继续向页面发送结果。"""

import asyncio
import inspect
import re
import time
from uuid import uuid4


class TurnCancelled(Exception):
    pass


class CancelSignal:
    def __init__(self):
        self._event = asyncio.Event()
        self.reason = TurnCancelled("本轮已停止")

    @property
    def aborted(self):
        return self._event.is_set()

    def abort(self, reason=None):
        if not self.aborted:
            self.reason = reason if isinstance(reason, Exception) else TurnCancelled(reason or "本轮已停止")
            self._event.set()

    def throw_if_aborted(self):
        if self.aborted:
            raise self.reason

    async def run(self, awaitable):
        """把取消传给可取消的网络协程；不用于已经开始的同步 Docker 查询。"""
        if self.aborted:
            if inspect.iscoroutine(awaitable):
                awaitable.close()
            self.throw_if_aborted()
        task = asyncio.ensure_future(awaitable)
        stopped = asyncio.create_task(self._event.wait())
        try:
            await asyncio.wait((task, stopped), return_when=asyncio.FIRST_COMPLETED)
            self.throw_if_aborted()
            return await task
        finally:
            # 即使外层任务被取消，也等待网络协程的 finally 关闭连接，不遗留后台请求。
            if not task.done():
                task.cancel()
            stopped.cancel()
            await asyncio.gather(task, stopped, return_exceptions=True)


class Turn:
    def __init__(self, identity, deliver):
        self.id = identity
        self.signal = CancelSignal()
        self.started = time.perf_counter()
        self._deliver = deliver

    def send(self, event, data=None):
        if not self.signal.aborted:
            self._deliver({"event": event, "data": {**(data or {}), "turnId": self.id}})

    def cancel(self):
        self.signal.abort()


class TurnSlot:
    """每个浏览器连接独立管理轮次；替换以前先取消上一轮。"""
    def __init__(self):
        self.current = None

    def begin(self, identity, deliver):
        if not isinstance(identity, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", identity):
            raise ValueError("turnId 无效")
        if self.current and self.current.id == identity:
            raise ValueError("每轮需要使用新的 turnId")
        if self.current:
            self.current.cancel()
        turn = Turn(identity, lambda packet: deliver(packet) if self.current is turn else None)
        self.current = turn
        return turn

    def cancel(self, identity=None):
        if self.current and (not identity or self.current.id == identity):
            self.current.cancel()


def event_id():
    return str(uuid4())
