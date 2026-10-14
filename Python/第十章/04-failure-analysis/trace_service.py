"""本节自定义的本地 Trace：保存输入快照、父子关系、输出、异常与耗时。"""

from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime, timezone
import inspect
import math
from time import perf_counter
from uuid import uuid4


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def round_ms(value, digits=2):
    # 对齐原例 Math.round 的正数四舍五入，不使用 Python 的偶数舍入。
    factor = 10 ** digits
    return math.floor(value * factor + 0.5) / factor


class TraceService:
    def __init__(self):
        self.trace_id = str(uuid4())
        self.spans = []
        # 对应 AsyncLocalStorage：每个并发任务保留自己的父步骤，不能用全局“当前父节点”。
        self._parent = ContextVar(f"trace_parent_{self.trace_id}", default=None)

    def _start(self, name, kind, value):
        span = {"id": str(uuid4()), "parentId": self._parent.get(), "name": name, "kind": kind,
                "startedAt": timestamp(), "durationMs": 0, "status": "running", "input": deepcopy(value)}
        self.spans.append(span)
        start = perf_counter()
        token = self._parent.set(span["id"])
        return span, start, token

    @staticmethod
    def _complete(span, output):
        # 输入和输出都保存当时副本。以后追加消息或修改业务对象，不会倒改旧记录。
        span["output"] = deepcopy(output)
        span["status"] = "completed"
        return output

    def _end(self, span, start, token):
        self._parent.reset(token)
        span["durationMs"] = round_ms((perf_counter() - start) * 1000)

    def capture(self, name, kind, value, operation):
        """包住一次同步调用：记录错误后仍然抛出，由业务层决定是否捕获。"""
        span, start, token = self._start(name, kind, value)
        try:
            return self._complete(span, operation())
        except Exception as error:
            span["status"], span["error"] = "error", str(error)
            raise
        finally:
            self._end(span, start, token)

    async def capture_async(self, name, kind, value, operation):
        """异步操作使用这个入口；ContextVar 在 asyncio 并发任务中同样隔离父节点。"""
        span, start, token = self._start(name, kind, value)
        try:
            output = operation()
            if inspect.isawaitable(output):
                output = await output
            return self._complete(span, output)
        except BaseException as error:
            # 取消也要结束 running 状态并恢复上下文，然后继续向上抛出。
            span["status"], span["error"] = "error", str(error)
            raise
        finally:
            self._end(span, start, token)

    def snapshot(self):
        return {"traceId": self.trace_id, "spans": deepcopy(self.spans)}
