"""检查 Python、PostgreSQL 与模型模式是否满足启动条件。"""

from __future__ import annotations

import os
import sys

from presentation_repository import PostgresPresentationRepository, get_postgres_uri


def main() -> None:
    if sys.version_info < (3, 11):
        raise RuntimeError("需要 Python 3.11 或更高版本。")

    repository = PostgresPresentationRepository(get_postgres_uri())
    try:
        repository.ping()
        print(f"Python：{sys.version.split()[0]}")
        print("PostgreSQL：连接成功")
        print(f"模型模式：{'AI' if os.getenv('MODEL_MODE') == 'ai' else 'Replay'}")
        if os.getenv("MODEL_MODE") == "ai" and not os.getenv("DEEPSEEK_API_KEY"):
            raise RuntimeError("AI 模式缺少 DEEPSEEK_API_KEY。")
    finally:
        repository.close()


if __name__ == "__main__":
    main()
