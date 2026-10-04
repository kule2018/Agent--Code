"""离线 HTML 的实际脚本、事件续传，以及 PostgreSQL 查询边界。"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from langgraph.checkpoint.memory import InMemorySaver

from server.src.builder import GameBuilderService
from server.src.contracts import game_from_outline, validate_game
from server.src.errors import Conflict, NotFound
from server.src.main import create_app
from server.src.repository import ProjectRepository
from server.src.replay import replay_brief, replay_characters, replay_outline, replay_scenes
from server.src.story_controller import build_router
from server.src.workspace import WorkspaceService
from tests.support import MemoryRepository, wait_state


class DeliveryTests(unittest.TestCase):
    def test_offline_html_executes_all_endings_restart_and_text_only_content(self):
        value = game_from_outline(replay_brief, replay_outline, replay_characters, replay_scenes())
        value["title"] = "标题 {{ENGINE}} <script>不会执行</script>"
        value["scenes"][0]["content"] += "</script><script>globalThis.hacked=true</script>"
        html = GameBuilderService(WorkspaceService()).offline_html(value)
        self.assertIn("data:image/jpeg;base64,", html)
        self.assertIn("{{ENGINE}} &lt;script&gt;不会执行&lt;/script&gt;", html)
        self.assertEqual(len(re.findall(r"<script>", html)), 2)
        node = shutil.which("node")
        self.assertIsNotNone(node, "请安装前端所需的 Node.js 22 或更新版本后运行此验证")
        # 不启动服务，不加载远程资源，直接运行下载 HTML 的两段固定脚本。
        script = r"""
import { readFileSync } from 'node:fs'; import vm from 'node:vm'; import assert from 'node:assert/strict';
const input=JSON.parse(readFileSync(0,'utf8')); const elements=new Map();
const element=()=>({textContent:'',children:[],onclick:null,replaceChildren(){this.children=[]},append(child){this.children.push(child)}});
const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement(){return element()}};
const context=vm.createContext({document});for(const match of input.html.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInContext(match[1],context);
assert.equal(vm.runInContext('globalThis.hacked',context),undefined);assert.equal(elements.get('content').textContent,input.game.scenes[0].content);
const endings=[];for(const [ending,path] of Object.entries(input.paths)){elements.get('restart').onclick();for(const step of path){const [sceneId,choiceId]=step.split(':');assert.equal(vm.runInContext('session.sceneId',context),sceneId);const choice=input.game.scenes.find(s=>s.id===sceneId).choices.find(c=>c.id===choiceId);const button=elements.get('choices').children.find(b=>b.textContent===choice.text);assert.ok(button);button.onclick()}assert.equal(vm.runInContext('session.sceneId',context),ending);assert.equal(elements.get('choices').children.length,0);endings.push(ending)}
elements.get('restart').onclick();assert.equal(vm.runInContext('session.history.length',context),0);console.log(JSON.stringify(endings));
"""
        result = subprocess.run([node, "--input-type=module", "-e", script], input=json.dumps({
            "html": html, "game": value, "paths": validate_game(value),
        }), text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ["ending-01", "ending-02", "ending-03"])


class EventTests(unittest.IsolatedAsyncioTestCase):
    async def test_sse_resumes_after_last_event_id(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = MemoryRepository()
            app = create_app(repo, WorkspaceService(Path(directory)), InMemorySaver())
            stories = app.state.stories
            try:
                project = await stories.create(dict(replay_brief))
                await wait_state(stories, project["id"], "awaiting_outline_review")
                events = await repo.events(project["id"])
                after = events[1]["id"]
                router = build_router(stories, repo, app.state.workspace)
                route = next(item for item in router.routes if item.path.endswith("/events/live"))

                async def connected():
                    return False

                request = SimpleNamespace(headers={"last-event-id": str(after)}, is_disconnected=connected)
                response = await route.endpoint(project["id"], request, after=0)
                chunk = await anext(response.body_iterator)
                await response.body_iterator.aclose()
                self.assertTrue(response.media_type.startswith("text/event-stream"))
                data = json.loads(chunk.split("data: ", 1)[1])
                self.assertGreater(data["id"], after)
                self.assertIn(f"id: {data['id']}\n", chunk)
            finally:
                await stories.close()


class FakePool:
    def __init__(self):
        self.calls = []
        self.rows = []
        self.opened = self.closed = False

    async def open(self, **kwargs):
        self.opened = True

    async def close(self):
        self.closed = True

    @asynccontextmanager
    async def connection(self):
        yield self

    async def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self

    async def fetchone(self):
        return self.rows.pop(0) if self.rows else None

    async def fetchall(self):
        rows, self.rows = self.rows, []
        return rows


class RepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_postgres_setup_version_guard_and_json_parameters(self):
        pool = FakePool()
        repo = ProjectRepository(pool)
        await repo.setup()
        self.assertTrue(pool.opened)
        self.assertIn("CREATE TABLE IF NOT EXISTS story_projects", pool.calls[0][0])
        project = {"id": "project-id", "version": 1, "brief": {"title": "失联太空站"}}
        await repo.create(project)
        self.assertEqual(pool.calls[-1][1][2].obj, project)
        pool.rows = [{"id": "project-id"}]
        saved = await repo.save(project)
        self.assertEqual(saved["version"], 2)
        self.assertIn("AND version = %s", pool.calls[-1][0])
        self.assertEqual(pool.calls[-1][1][-1], 1)
        self.assertEqual(pool.calls[-1][1][1].obj, saved)
        with self.assertRaises(Conflict):
            await repo.save(project)
        with self.assertRaises(NotFound):
            await repo.get("missing")
        await repo.close()
        self.assertTrue(pool.closed)

    async def test_event_cursor_sort_limit_and_datetime_normalization(self):
        pool = FakePool()
        repo = ProjectRepository(pool)
        pool.rows = [{"id": 8, "projectId": "project-id", "kind": "released", "message": "完成", "detail": {},
                      "createdAt": datetime(2026, 10, 4, tzinfo=timezone.utc)}]
        events = await repo.events("project-id", 7)
        self.assertEqual(events[0]["createdAt"], "2026-10-04T00:00:00.000Z")
        self.assertEqual(pool.calls[-1][1], ("project-id", 7))
        self.assertIn("ORDER BY id LIMIT 300", pool.calls[-1][0])
