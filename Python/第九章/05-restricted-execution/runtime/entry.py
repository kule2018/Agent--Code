"""容器入口：执行只读 SQL 或分析模块，标准输出只返回一份 JSON。"""

import asyncio
import errno
import importlib.util
import inspect
import json
import sys
from pathlib import Path

from query_worker import run_read_only_query


async def _await_result(value):
    return await value


def main():
    # 本入口只在受限容器内运行；输入目录由宿主固定为 /input。
    request = json.loads(Path("/input/request.json").read_text(encoding="utf-8"))
    if request["kind"] == "sql":
        result = run_read_only_query("/input/data.duckdb", request["sql"])
    elif request["kind"] == "code":
        rows = json.loads(Path("/input/rows.json").read_text(encoding="utf-8"))
        # 对应原示例的动态模块加载。宿主只保存源码，绝不 import / eval 任务代码。
        spec = importlib.util.spec_from_file_location("course_analysis", "/input/analysis.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = module.analyze(rows)
        # 和原示例 await analyze(rows) 一样，同时支持同步与异步分析函数。
        if inspect.isawaitable(result):
            result = asyncio.run(_await_result(result))
    else:
        raise ValueError("不支持的任务类型。")
    sys.stdout.write(json.dumps({"ok": True, "result": result}, ensure_ascii=False,
                                allow_nan=False, separators=(",", ":")))


def error_detail(error):
    # urllib 的网络错误包在 reason 中；优先保留底层 errno，例如 ENETUNREACH。
    detail = getattr(error, "reason", None) or error.__cause__ or error
    code = getattr(detail, "errno", None)
    return errno.errorcode.get(code, str(detail))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = error_detail(error)
        # 对齐原错误长度上限，并允许截断产生的单个代理字符以 JSON 转义返回。
        message = detail.encode("utf-16-le", errors="surrogatepass")[:3200].decode("utf-16-le", errors="surrogatepass")
        output = json.dumps({"ok": False, "error": message}, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.buffer.write(output.encode("utf-8", errors="backslashreplace"))
        sys.exit(1)
