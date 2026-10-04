"""避免前端在 PostgreSQL / Checkpoint 初始化完成前发出请求。"""

import time
from urllib.error import URLError
from urllib.request import urlopen


def wait_for_api(base_url: str, process=None, timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError("后端已退出，请查看上方 API 日志。")
        try:
            with urlopen(f"{base_url}/api/projects/meta", timeout=1) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError):
            pass
        time.sleep(0.25)
    raise RuntimeError("等待 API 30 秒仍未就绪，请检查 PostgreSQL 是否为 healthy。")
