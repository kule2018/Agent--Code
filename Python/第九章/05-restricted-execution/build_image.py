"""只打包固定运行器、锁定依赖和 Python 04 的查询实现，不发送整个课程目录。"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent
# 使用独立标签，构建 Python 运行时不会覆盖同一章节的 Node 镜像。
IMAGE_NAME = "agent-course-analysis-python:chapter9-05"


def build_image():
    work = PROJECT_DIR / ".work"
    work.mkdir(parents=True, exist_ok=True)
    context = Path(tempfile.mkdtemp(prefix="build-", dir=work))
    try:
        for name in ("Dockerfile", "requirements.lock", "entry.py", "model.py"):
            shutil.copyfile(PROJECT_DIR / "runtime" / name, context / name)
        # 容器继续使用 Python 04 的 SQL AST 检查和只读连接，不维护另一份查询逻辑。
        shutil.copyfile(PROJECT_DIR.parent / "04-text-to-sql" / "query_worker.py", context / "query_worker.py")
        result = subprocess.run(["docker", "build", "--tag", IMAGE_NAME, str(context)], check=False)
        if result.returncode != 0:
            raise RuntimeError(f"镜像构建失败，退出码 {result.returncode}")
    finally:
        shutil.rmtree(context)


if __name__ == "__main__":
    try:
        build_image()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
