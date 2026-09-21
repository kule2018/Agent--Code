"""使用 PostgreSQL JSONB 保存完整聚合对象的仓储实现。"""

from __future__ import annotations

import os
from typing import Protocol

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from presentation_types import Presentation


DEFAULT_POSTGRES_URI = "postgresql://presentation_course:presentation_course@localhost:5436/presentation_agent"


def get_postgres_uri() -> str:
    """从进程环境读取连接地址；没有配置时使用课程 Docker 默认地址。"""

    return os.getenv("POSTGRES_URI", DEFAULT_POSTGRES_URI)


class PresentationRepository(Protocol):
    def setup(self) -> None: ...

    def save(self, presentation: Presentation) -> None: ...

    def find_by_id(self, presentation_id: str) -> Presentation | None: ...

    def list(self) -> list[Presentation]: ...

    def ping(self) -> None: ...

    def close(self) -> None: ...


class PostgresPresentationRepository:
    """JSONB 使课程可以聚焦领域规则，而不把每一个字段拆成数据库列。"""

    def __init__(self, connection_string: str | None = None) -> None:
        self._connection = psycopg.connect(connection_string or get_postgres_uri(), row_factory=dict_row)

    def setup(self) -> None:
        with self._connection.cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS presentations (
                    id TEXT PRIMARY KEY,
                    thread_id TEXT UNIQUE NOT NULL,
                    data JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
        self._connection.commit()

    def save(self, presentation: Presentation) -> None:
        with self._connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO presentations (id, thread_id, data, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET thread_id = EXCLUDED.thread_id,
                    data = EXCLUDED.data,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    presentation.id,
                    presentation.threadId,
                    Jsonb(presentation.model_dump(mode="json")),
                    presentation.createdAt,
                    presentation.updatedAt,
                ),
            )
        self._connection.commit()

    def find_by_id(self, presentation_id: str) -> Presentation | None:
        with self._connection.cursor() as cursor:
            cursor.execute("SELECT data FROM presentations WHERE id = %s", (presentation_id,))
            row = cursor.fetchone()
        return Presentation.model_validate(row["data"]) if row else None

    def list(self) -> list[Presentation]:
        with self._connection.cursor() as cursor:
            cursor.execute("SELECT data FROM presentations ORDER BY updated_at DESC")
            rows = cursor.fetchall()
        return [Presentation.model_validate(row["data"]) for row in rows]

    def ping(self) -> None:
        with self._connection.cursor() as cursor:
            cursor.execute("SELECT 1")

    def close(self) -> None:
        self._connection.close()


class InMemoryPresentationRepository:
    """离线测试使用的 Fake Repository，不连接也不写入 PostgreSQL。"""

    def __init__(self) -> None:
        self.items: dict[str, Presentation] = {}

    def setup(self) -> None:
        return None

    def save(self, presentation: Presentation) -> None:
        self.items[presentation.id] = presentation.model_copy(deep=True)

    def find_by_id(self, presentation_id: str) -> Presentation | None:
        value = self.items.get(presentation_id)
        return value.model_copy(deep=True) if value else None

    def list(self) -> list[Presentation]:
        return sorted(
            (item.model_copy(deep=True) for item in self.items.values()),
            key=lambda item: item.updatedAt,
            reverse=True,
        )

    def ping(self) -> None:
        return None

    def close(self) -> None:
        return None
