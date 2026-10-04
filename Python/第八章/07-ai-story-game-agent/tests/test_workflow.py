"""使用真实 Graph、文件和 HTTP API；仅数据库与模型用测试替身。"""

import asyncio
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from copy import deepcopy
from pathlib import Path

import httpx
from langgraph.checkpoint.memory import InMemorySaver

from server.src.agents import AgentExecutionService
from server.src.builder import GameBuilderService, digest
from server.src.errors import BadRequest, Conflict, NotFound
from server.src.main import create_app
from server.src.replay import replay_brief, replay_report
from server.src.smoke import smoke
from server.src.story_service import StoryService
from server.src.workspace import WorkspaceService
from tests.support import MemoryRepository, wait_state


class WorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.workspace = WorkspaceService(Path(self.directory.name))
        self.repo = MemoryRepository()
        self.saver = InMemorySaver()
        self.agents = AgentExecutionService(self.workspace)
        self.service = StoryService(self.repo, self.workspace, self.agents, GameBuilderService(self.workspace), self.saver)

    async def asyncTearDown(self):
        await self.service.close()
        self.directory.cleanup()

    async def create_pending(self, scenario="normal"):
        project = await self.service.create({**replay_brief, "replayScenario": scenario})
        return await wait_state(self.service, project["id"], "awaiting_outline_review")

    async def test_full_http_smoke_normal_defect_revision_and_stale_approval(self):
        app = create_app(self.repo, self.workspace, self.saver, self.agents)
        with redirect_stdout(io.StringIO()):
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://offline") as client:
                    await smoke(client)
                    self.assertEqual(len(await self.repo.list()), 3)
                    projects = await self.repo.list()
                    for project in projects:
                        release_id = project["latestReleaseId"]
                        manifest = await self.workspace.read_json(project["id"], f"/releases/{release_id}/manifest.json")
                        for virtual, expected in manifest["sources"].items():
                            self.assertEqual(digest(await self.workspace.read_text(project["id"], virtual)), expected)
                        self.assertEqual(digest(await self.workspace.read_text(project["id"], f"/releases/{release_id}/game.json")), manifest["gameHash"])
                        self.assertEqual(digest(await self.workspace.read_text(project["id"], f"/releases/{release_id}/index.html")), manifest["htmlHash"])
                    # API 不允许跨项目访问 Release，也不允许读取未登记文件。
                    one, two = projects[:2]
                    denied = await client.get(f"/api/projects/{one['id']}/releases/{two['latestReleaseId']}/game")
                    self.assertEqual(denied.status_code, 400)
                    denied = await client.get(f"/api/projects/{one['id']}/file", params={"path": "/../secret.json"})
                    self.assertEqual(denied.status_code, 400)
                    bad = await client.post("/api/projects", json={**replay_brief, "title": "自定义故事"})
                    self.assertEqual(bad.status_code, 400)
                    self.assertIn("message", bad.json())

    async def test_pending_outline_survives_service_reconstruction(self):
        pending = await self.create_pending()
        await self.service.close()
        self.service = StoryService(self.repo, self.workspace, self.agents, GameBuilderService(self.workspace), self.saver)
        await self.service.start()
        state = await self.service.graph.aget_state(self.service.config(pending["id"]))
        self.assertEqual(state.next, ("approval",))
        await self.service.review_outline(pending["id"], {"outlineVersion": 1, "decision": "approve"})
        ready = await wait_state(self.service, pending["id"], "ready")
        self.assertEqual(ready["approvedOutlineVersion"], 1)

    async def test_failed_scene_retry_reuses_success_and_new_candidate_path(self):
        pending = await self.create_pending()
        original_execute = self.agents.execute
        attempts = []
        failed_once = False

        async def flaky(project, assignment, event):
            nonlocal failed_once
            if assignment["assignee"] == "scene-writer":
                attempts.append(deepcopy(assignment))
                if assignment["sceneId"] == "scene-02" and not failed_once:
                    failed_once = True
                    raise TimeoutError("模拟场景请求超时")
            await original_execute(project, assignment, event)

        self.agents.execute = flaky
        await self.service.review_outline(pending["id"], {"outlineVersion": 1, "decision": "approve"})
        failed = await wait_state(self.service, pending["id"], "failed")
        self.assertIn("超时", failed["failure"])
        scene_one = await self.workspace.read_text(pending["id"], "/revisions/1/scenes/scene-01.json")
        await self.service.retry(pending["id"])
        await wait_state(self.service, pending["id"], "ready")
        self.assertEqual([item["sceneId"] for item in attempts][:3], ["scene-01", "scene-02", "scene-02"])
        self.assertNotEqual(attempts[1]["writeFiles"], attempts[2]["writeFiles"])
        self.assertEqual(await self.workspace.read_text(pending["id"], "/revisions/1/scenes/scene-01.json"), scene_one)

    async def test_review_limit_and_retry_budget(self):
        pending = await self.create_pending("defect")
        original_execute = self.agents.execute

        async def repeated_conflict(project, assignment, event):
            if assignment["assignee"] != "continuity-reviewer":
                await original_execute(project, assignment, event)
                return
            scene = await self.workspace.read_json(project["id"], "/revisions/1/scenes/ending-02.json")
            report = replay_report(True)
            report["issues"][0]["quote"] = scene["content"][:10]
            await self.workspace.write_json(project["id"], assignment["writeFiles"][0], report)

        self.agents.execute = repeated_conflict
        await self.service.review_outline(pending["id"], {"outlineVersion": 1, "decision": "approve"})
        stopped = await wait_state(self.service, pending["id"], "needs_human_review")
        self.assertEqual(stopped["repairCount"], 2)
        self.assertEqual(stopped["releaseIds"], [])
        self.agents.execute = original_execute
        await self.service.retry(pending["id"])
        ready = await wait_state(self.service, pending["id"], "ready")
        self.assertEqual(ready["repairCount"], 0)

    async def test_failed_retry_preserves_review_counter(self):
        pending = await self.create_pending()
        await self.service.patch(pending["id"], {"status": "failed", "repairCount": 1})
        # 隔离恢复执行，只检查用户重试时更新的返工轮数。
        async def idle(project_id, value):
            return None
        self.service.run = idle
        await self.service.retry(pending["id"])
        self.assertEqual((await self.repo.get(pending["id"]))["repairCount"], 1)

    async def test_input_hash_change_blocks_promotion(self):
        original_execute = self.agents.execute

        async def changed_input(project, assignment, event):
            await original_execute(project, assignment, event)
            await self.workspace.write_text(project["id"], assignment["readFiles"][0], "任务输入被意外修改")

        self.agents.execute = changed_input
        project = await self.service.create(dict(replay_brief))
        failed = await wait_state(self.service, project["id"], "failed")
        self.assertIn("任务输入已变化", failed["failure"])
        with self.assertRaises(NotFound):
            await self.workspace.read_text(project["id"], "/revisions/1/world.json")

    async def test_reject_and_cancel_stop_release(self):
        pending = await self.create_pending()
        await self.service.review_outline(pending["id"], {"outlineVersion": 1, "decision": "reject"})
        stopped = await wait_state(self.service, pending["id"], "cancelled")
        self.assertEqual(stopped["releaseIds"], [])
        entered = asyncio.Event()

        async def blocked(project, assignment, event):
            entered.set()
            await asyncio.Event().wait()

        self.agents.execute = blocked
        project = await self.service.create(dict(replay_brief))
        await asyncio.wait_for(entered.wait(), 1)
        await self.service.cancel(project["id"])
        stopped = await wait_state(self.service, project["id"], "cancelled")
        self.assertEqual(stopped["releaseIds"], [])
        with self.assertRaises(Conflict):
            await self.service.retry(project["id"])

    async def test_workspace_rejects_traversal_and_parent_symlink(self):
        pending = await self.create_pending()
        with self.assertRaises(BadRequest):
            self.workspace.path(pending["id"], "/../../outside.json")
        outside = Path(self.directory.name) / "outside"
        outside.mkdir()
        link = self.workspace.project_root(pending["id"]) / "linked"
        link.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(BadRequest):
            await self.workspace.write_text(pending["id"], "/linked/leak.json", "拒绝")

    async def test_local_revision_failure_can_resume_same_revision(self):
        pending = await self.create_pending()
        await self.service.review_outline(pending["id"], {"outlineVersion": 1, "decision": "approve"})
        original = await wait_state(self.service, pending["id"], "ready")
        original_execute = self.agents.execute
        failed_once = False

        async def flaky(project, assignment, event):
            nonlocal failed_once
            if assignment.get("instruction") and not failed_once:
                failed_once = True
                raise TimeoutError("模拟局部改写超时")
            await original_execute(project, assignment, event)

        self.agents.execute = flaky
        await self.service.revise_scene(pending["id"], "scene-01", "让这里的气氛更紧张")
        await wait_state(self.service, pending["id"], "failed")
        await self.service.retry(pending["id"])
        revised = await wait_state(self.service, pending["id"], "ready")
        self.assertEqual(revised["revision"], 2)
        self.assertEqual(len(revised["releaseIds"]), 2)
        self.assertIn(original["latestReleaseId"], revised["releaseIds"])

    async def test_cancel_before_background_start_cannot_be_resurrected(self):
        project = await self.service.create(dict(replay_brief))
        await self.service.cancel(project["id"])
        stopped = await wait_state(self.service, project["id"], "cancelled")
        await asyncio.sleep(0.05)
        self.assertEqual((await self.repo.get(project["id"]))["status"], "cancelled")
        self.assertEqual(stopped["releaseIds"], [])
