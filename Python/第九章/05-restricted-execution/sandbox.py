"""宿主调度：构造受限容器、只提供授权输入、检查返回结构并回收本次任务。"""

import json
import math
import queue
import shutil
import subprocess
import threading
import time
from uuid import uuid4

from build_image import IMAGE_NAME, PROJECT_DIR
from runtime.model import utf16_length


OUTPUT_LIMIT = 64 * 1024
JOB_ROOT = PROJECT_DIR / ".work" / "jobs"


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _slice(value, length):
    return value.encode("utf-16-le", errors="surrogatepass")[:length * 2].decode("utf-16-le", errors="surrogatepass")


def container_args(name, input_directory):
    """参数全部由应用构造，模型不能提供镜像、挂载目录或资源配置。"""
    directory = str(input_directory)
    # Docker --mount 用英文逗号分隔配置，路径不能夹带额外配置项。
    if "," in directory:
        raise ValueError("本课挂载路径不能包含英文逗号。")
    return [
        "create", "--name", name, "--label", "agent-course=chapter9-05",
        "--network", "none",               # 不提供外部网络路由。
        "--read-only",                     # 根文件系统只读。
        "--user", "1000:1000",             # 使用非 root 用户。
        "--cap-drop", "ALL",               # 移除 Linux capabilities。
        "--security-opt", "no-new-privileges=true",
        "--cpus", "1",                     # 最多相当于 1 个 CPU 的额度。
        "--memory", "256m", "--memory-swap", "256m",  # 不额外使用 swap。
        "--pids-limit", "64",              # 限制进程和线程数量。
        "--init",                          # 回收僵尸进程，转发终止信号。
        "--log-driver", "none",            # 不让任务输出持续占用宿主日志磁盘。
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
        "--mount", f"type=bind,source={directory},target=/input,readonly",
        IMAGE_NAME,
    ]


def _collect_process(child, timeout_ms, byte_limit, *, on_stop=None, combined=True):
    """实时读取两个管道，有界队列避免先无限缓冲再检查；停止动作由宿主指定。"""
    events = queue.Queue(maxsize=16)
    cancelled = threading.Event()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    deadline = time.monotonic() + timeout_ms / 1000

    def read_stream(name, stream):
        def publish(data):
            while not cancelled.is_set():
                try:
                    events.put((name, data), timeout=0.1)
                    return
                except queue.Full:
                    pass
        try:
            while not cancelled.is_set():
                data = stream.read1(8192)
                if not data:
                    break
                publish(data)
        finally:
            publish(None)

    readers = [threading.Thread(target=read_stream, args=(name, stream), daemon=True)
               for name, stream in (("stdout", child.stdout), ("stderr", child.stderr))]
    for reader in readers:
        reader.start()
    stopped = None
    remaining_streams = 2
    counts = {"stdout": 0, "stderr": 0}
    try:
        while remaining_streams:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                stopped = "timeout"
                break
            try:
                name, data = events.get(timeout=remaining)
            except queue.Empty:
                stopped = "timeout"
                break
            if data is None:
                remaining_streams -= 1
                continue
            counts[name] += len(data)
            size = sum(counts.values()) if combined else max(counts.values())
            if size > byte_limit:
                stopped = "output_limit"
                break
            buffers[name].extend(data)
        if stopped:
            # 任务进程超时/超量时先删除整个容器；仅杀 docker 客户端不能停止容器。
            try:
                if on_stop is not None:
                    on_stop(stopped)
            finally:
                if child.poll() is None:
                    child.kill()
            child.wait()
        else:
            try:
                child.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                stopped = "timeout"
                try:
                    if on_stop is not None:
                        on_stop(stopped)
                finally:
                    if child.poll() is None:
                        child.kill()
                child.wait()
        return {"stdout": buffers["stdout"].decode("utf-8", errors="replace"),
                "stderr": buffers["stderr"].decode("utf-8", errors="replace"),
                "exitCode": child.returncode, "stopped": stopped}
    finally:
        cancelled.set()
        if child.poll() is None:
            child.kill()
        child.wait()
        for reader in readers:
            reader.join(timeout=1)
        child.stdout.close()
        child.stderr.close()


def docker(args):
    """Docker 管理命令限制为 15 秒、每个输出流 1 MiB；不通过 shell 拼接参数。"""
    child = subprocess.Popen(["docker", *args], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    result = _collect_process(child, 15000, 1024 * 1024, combined=False)
    if result["stopped"] == "timeout":
        raise RuntimeError("Docker 管理命令超时。")
    if result["stopped"] == "output_limit":
        raise RuntimeError("Docker 管理命令输出超过 1 MiB。")
    if result["exitCode"] != 0:
        raise RuntimeError(result["stderr"].strip() or f"Docker 命令失败，退出码 {result['exitCode']}")
    return result["stdout"].strip()


def start_and_collect(name, timeout_ms):
    def stop(_status):
        try:
            docker(["rm", "--force", name])
        except Exception as error:
            raise RuntimeError(f"容器停止失败：{name}；{error}") from error
    child = subprocess.Popen(["docker", "start", "--attach", name], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return _collect_process(child, timeout_ms, OUTPUT_LIMIT, on_stop=stop)


def validate_result(result):
    """宿主再检查输出表格；格式正确仍不能证明业务算法和统计口径正确。"""
    if not isinstance(result, dict) or not isinstance(result.get("rows"), list) or len(result["rows"]) > 100:
        raise ValueError("结果必须包含至多 100 行的 rows。")
    if result.get("truncated") is True:
        raise ValueError("查询结果被截断，请缩小查询范围后再分析。")
    for row in result["rows"]:
        if not isinstance(row, dict) or len(row) > 20:
            raise ValueError("结果行结构错误。")
        for key, value in row.items():
            number = isinstance(value, (int, float)) and not isinstance(value, bool)
            try:
                finite = number and math.isfinite(value)
            except OverflowError:
                finite = False
            if (not isinstance(key, str) or utf16_length(key) > 64
                    or not (value is None or isinstance(value, bool) or finite
                            or (isinstance(value, str) and utf16_length(value) <= 1000))):
                raise ValueError("结果字段超出允许的类型或长度。")
    return {"rows": result["rows"]}


def _write_input(file, content):
    file.write_text(content, encoding="utf-8")
    file.chmod(0o444)


def run_sandbox(task, *, database_path=None, timeout_ms=5000):
    """每个任务独立容器，只暴露本次输入；数据库路径只能由应用传入。"""
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 30000:
        raise ValueError("执行时限必须为 100 至 30000 毫秒。")
    kind = task.get("kind") if isinstance(task, dict) else None
    if kind == "sql":
        if not database_path or not isinstance(task.get("sql"), str) or utf16_length(task["sql"]) > 12000:
            raise ValueError("SQL 任务参数无效。")
    elif kind == "code":
        if not isinstance(task.get("code"), str) or len(task["code"].encode("utf-8")) > 16 * 1024:
            raise ValueError("分析代码过长或格式错误。")
        validate_result({"rows": task.get("rows")})
        if len(_json(task["rows"]).encode("utf-8")) > OUTPUT_LIMIT:
            raise ValueError("输入数据超过 64 KiB。")
    else:
        raise ValueError("只允许 sql 或 code 任务。")

    job_id = str(uuid4())
    name = f"course-analysis-{job_id}"
    job_directory = JOB_ROOT / job_id
    input_directory = job_directory / "input"
    started = time.monotonic()
    created = False
    try:
        input_directory.mkdir(parents=True, exist_ok=True)
        request = {"kind": kind, "sql": task["sql"]} if kind == "sql" else {"kind": kind}
        _write_input(input_directory / "request.json", _json(request))
        if kind == "sql":
            # 复制关闭连接的课程数据库，不直接挂载原件；生产环境需要一致性快照。
            shutil.copyfile(database_path, input_directory / "data.duckdb")
            (input_directory / "data.duckdb").chmod(0o444)
        else:
            # 分析容器只拿有限 rows 和源码，不包含数据库或其他课程文件。
            _write_input(input_directory / "rows.json", _json(task["rows"]))
            _write_input(input_directory / "analysis.py", task["code"])
        input_directory.chmod(0o555)

        # 创建异常也要尝试清理，以免 Docker 已创建容器但客户端返回失败。
        created = True
        docker(container_args(name, input_directory))
        details = json.loads(docker(["inspect", name]))[0]
        execution = {
            "network": details["HostConfig"]["NetworkMode"],
            "readOnly": details["HostConfig"]["ReadonlyRootfs"],
            "memoryBytes": details["HostConfig"]["Memory"],
            "nanoCpus": details["HostConfig"]["NanoCpus"],
            "user": details["Config"]["User"], "pidsLimit": details["HostConfig"]["PidsLimit"],
            "mounts": [{"destination": mount["Destination"], "writable": mount["RW"]} for mount in details["Mounts"]],
        }
        output = start_and_collect(name, timeout_ms)
        if output["stopped"]:
            report = {"status": output["stopped"], "error": "超过执行时限，容器已终止。"
                      if output["stopped"] == "timeout" else "输出超过 64 KiB，容器已终止。"}
        else:
            finished = json.loads(docker(["inspect", name]))[0]
            if finished["State"]["OOMKilled"]:
                report = {"status": "resource_limit", "error": "容器触及内存限制。"}
            else:
                try:
                    message = json.loads(output["stdout"], parse_constant=lambda value: _invalid_json(value))
                    if output["exitCode"] != 0 or message.get("ok") is not True:
                        error = _slice(message["error"], 1600) if isinstance(message.get("error"), str) else "执行失败。"
                        report = {"status": "rejected" if error.startswith("POLICY:") else "failed", "error": error}
                    else:
                        report = {"status": "completed", "result": validate_result(message.get("result"))}
                except Exception as error:
                    report = {"status": "invalid_result", "error": f"未返回约定的 JSON 表格：{error}"}
        report = {"jobId": job_id, "containerName": name, "kind": kind, **report,
                  "execution": execution, "elapsedMs": int((time.monotonic() - started) * 1000)}
    finally:
        # 只清理本次生成的准确容器名，不批量删除其他任务；失败时不宣称 cleanedUp。
        if created:
            existing = docker(["ps", "--all", "--quiet", "--filter", f"name=^/{name}$"])
            if existing:
                docker(["rm", "--force", name])
        try:
            input_directory.chmod(0o755)
        except OSError:
            pass
        if job_directory.exists():
            shutil.rmtree(job_directory)
    return {**report, "cleanedUp": True}


def _invalid_json(value):
    raise ValueError(f"不是有效 JSON：{value}")
