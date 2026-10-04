"""只持久化项目状态与事件；故事正文保存在 Workspace。"""

from __future__ import annotations

import os

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .errors import Conflict, NotFound
from .project import now_iso

# Python 演示使用独立端口与 Docker Volume，避免与 Node 版共享项目及 Checkpoint。
DEFAULT_POSTGRES_URI = "postgresql://story_course:story_course@127.0.0.1:5438/story_agent"


class ProjectRepository:
    def __init__(self, pool: AsyncConnectionPool | None = None) -> None:
        self.pool = pool or AsyncConnectionPool(
            os.getenv("POSTGRES_URI", DEFAULT_POSTGRES_URI), open=False,
            kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        )

    async def setup(self) -> None:
        await self.pool.open(wait=True)
        async with self.pool.connection() as connection:
            await connection.execute("""
                CREATE TABLE IF NOT EXISTS story_projects (
                    id uuid PRIMARY KEY, version integer NOT NULL, data jsonb NOT NULL,
                    updated_at timestamptz NOT NULL DEFAULT now()
                );
                CREATE TABLE IF NOT EXISTS story_events (
                    id bigserial PRIMARY KEY,
                    project_id uuid NOT NULL REFERENCES story_projects(id) ON DELETE CASCADE,
                    kind text NOT NULL, message text NOT NULL,
                    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
                    created_at timestamptz NOT NULL DEFAULT now()
                );
                CREATE INDEX IF NOT EXISTS story_events_project_id_id ON story_events(project_id, id);
            """)

    async def create(self, project: dict) -> dict:
        async with self.pool.connection() as connection:
            await connection.execute("INSERT INTO story_projects (id, version, data) VALUES (%s, %s, %s)",
                                     (project["id"], project["version"], Jsonb(project)))
        return project

    async def get(self, project_id: str) -> dict:
        async with self.pool.connection() as connection:
            cursor = await connection.execute("SELECT data FROM story_projects WHERE id = %s", (project_id,))
            row = await cursor.fetchone()
        if row is None:
            raise NotFound("项目不存在。")
        return row["data"]

    async def list(self) -> list[dict]:
        async with self.pool.connection() as connection:
            cursor = await connection.execute("SELECT data FROM story_projects ORDER BY updated_at DESC LIMIT 50")
            return [row["data"] for row in await cursor.fetchall()]

    async def save(self, project: dict) -> dict:
        # 带旧 version 的条件更新，阻止迟到请求覆盖新的项目状态。
        updated = {**project, "version": project["version"] + 1, "updatedAt": now_iso()}
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                "UPDATE story_projects SET version = %s, data = %s, updated_at = now() "
                "WHERE id = %s AND version = %s RETURNING id",
                (updated["version"], Jsonb(updated), project["id"], project["version"]),
            )
            row = await cursor.fetchone()
        if row is None:
            raise Conflict("项目状态已变化，请刷新后重试。")
        return updated

    @staticmethod
    def normalize_event(row: dict) -> dict:
        return {**row, "id": int(row["id"]), "projectId": str(row["projectId"]),
                "createdAt": row["createdAt"].isoformat(timespec="milliseconds").replace("+00:00", "Z")}

    async def event(self, project_id: str, kind: str, message: str, detail: dict | None = None) -> dict:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                'INSERT INTO story_events (project_id, kind, message, detail) VALUES (%s, %s, %s, %s) '
                'RETURNING id, project_id AS "projectId", kind, message, detail, created_at AS "createdAt"',
                (project_id, kind, message, Jsonb(detail or {})),
            )
            return self.normalize_event(await cursor.fetchone())

    async def events(self, project_id: str, after_id: int = 0) -> list[dict]:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                'SELECT id, project_id AS "projectId", kind, message, detail, created_at AS "createdAt" '
                'FROM story_events WHERE project_id = %s AND id > %s ORDER BY id LIMIT 300',
                (project_id, after_id),
            )
            return [self.normalize_event(row) for row in await cursor.fetchall()]

    async def close(self) -> None:
        await self.pool.close()
