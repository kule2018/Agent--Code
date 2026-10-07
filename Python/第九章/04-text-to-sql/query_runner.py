"""父进程管理查询：独立解释器执行、实时限制输出、超时终止，不继承 API Key。"""

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path


WORKER_PATH = Path(__file__).resolve().with_name("query_worker.py")


class QueryError(RuntimeError):
    def __init__(self, message, *, repairable=False):
        super().__init__(message)
        self.repairable = repairable


def execute_query(database_path, sql, *, timeout_ms=5000, max_rows=100):
    """输出超过 64 KiB 或运行超过 5 秒就终止，不把未完成结果交给模型。"""
    if isinstance(max_rows, bool) or not isinstance(max_rows, int) or not 1 <= max_rows <= 100:
        raise ValueError("maxRows 必须在 1 到 100 之间。")
    # 只保留启动解释器需要的系统变量；使用同一个解释器的已安装依赖。
    env = {"PATH": os.environ.get("PATH", "")}
    if os.environ.get("SystemRoot"):
        env["SystemRoot"] = os.environ["SystemRoot"]
    # 固定管道为 UTF-8，-B 禁止生成课程缓存；无需继承主进程的 Python 环境配置。
    worker = subprocess.Popen([sys.executable, "-X", "utf8", "-B", str(WORKER_PATH)], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    deadline = time.monotonic() + timeout_ms / 1000
    events = queue.Queue(maxsize=16)
    stopped = threading.Event()

    def read_stream(name, stream):
        def publish(data):
            while not stopped.is_set():
                try:
                    events.put((name, data), timeout=0.1)
                    return
                except queue.Full:
                    pass
        try:
            while not stopped.is_set():
                data = stream.read1(8192)
                if not data:
                    break
                publish(data)
        finally:
            publish(None)

    readers = [threading.Thread(target=read_stream, args=(name, stream), daemon=True)
               for name, stream in (("stdout", worker.stdout), ("stderr", worker.stderr))]
    for reader in readers:
        reader.start()
    output = bytearray()
    stderr = bytearray()
    open_streams = 2

    def send_input():
        # 写管道也可能阻塞；单独线程发送，父进程的超时计时不受它影响。
        try:
            worker.stdin.write(json.dumps({"databasePath": str(database_path), "sql": sql, "maxRows": max_rows},
                                         ensure_ascii=False, allow_nan=False).encode("utf-8"))
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                worker.stdin.close()
            except BrokenPipeError:
                pass

    writer = threading.Thread(target=send_input, daemon=True)
    writer.start()
    try:
        while open_streams:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise QueryError("查询超时，已终止，不自动重试。")
            try:
                name, data = events.get(timeout=remaining)
            except queue.Empty as error:
                raise QueryError("查询超时，已终止，不自动重试。") from error
            if data is None:
                open_streams -= 1
            elif name == "stdout":
                output.extend(data)
                # 按 UTF-8 字节限制，而不是 Python 字符个数；超过即杀进程。
                if len(output) > 64 * 1024:
                    raise QueryError("查询结果超过 64 KiB，请缩小查询范围。")
            else:
                stderr.extend(data)
                stderr = stderr[-8000:]
        try:
            code = worker.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as error:
            raise QueryError("查询超时，已终止，不自动重试。") from error
        if code != 0:
            detail = stderr.decode("utf-8", errors="replace")[-2000:] or str(code)
            raise QueryError(f"查询进程异常：{detail}")
        result = json.loads(output)
        if not result["ok"]:
            raise QueryError(result["message"], repairable=result.get("repairable", False))
        return {"rows": result["rows"], "truncated": result["truncated"]}
    finally:
        # 所有异常路径都回收子进程，避免超时后查询仍在后台运行。
        stopped.set()
        if worker.poll() is None:
            worker.kill()
        worker.wait()
        writer.join(timeout=1)
        for reader in readers:
            reader.join(timeout=1)
        for stream in (worker.stdin, worker.stdout, worker.stderr):
            if not stream.closed:
                stream.close()
