"""从本项目启动 API，确认就绪后启动 Vue 工作台；退出时关闭自己启动的进程。"""

import os
import signal
import subprocess
import sys
from pathlib import Path

from wait_for_api import wait_for_api

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    api_url = f"http://127.0.0.1:{os.getenv('PORT', '4312')}"
    environment = {**os.environ, "STORY_BASE_URL": api_url}
    processes: list[subprocess.Popen] = []
    try:
        server = subprocess.Popen([sys.executable, "-m", "server.src.main"], cwd=ROOT,
                                  env=environment, start_new_session=True)
        processes.append(server)
        wait_for_api(api_url, server)
        web = subprocess.Popen(["npm", "run", "dev:web"], cwd=ROOT, env=environment, start_new_session=True)
        processes.append(web)
        while True:
            for process in processes:
                if process.poll() is not None:
                    raise SystemExit(process.returncode)
            try:
                web.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
    except KeyboardInterrupt:
        pass
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


if __name__ == "__main__":
    main()
