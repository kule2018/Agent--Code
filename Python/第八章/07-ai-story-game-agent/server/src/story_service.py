"""LangGraph 管阶段，应用独立验收任务产物、持久化项目并发布游戏。"""

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any, TypedDict
from uuid import uuid4

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from .agents import AgentExecutionService
from .builder import GameBuilderService, digest
from .contracts import (BriefSchema, CharactersSchema, OutlineSchema, WorldSchema,
                        assert_outline, assert_review, assert_scene, game_from_outline, string_length)
from .errors import BadRequest, Conflict
from .project import STOPPED, now_iso
from .replay import replay_brief
from .workspace import WorkspaceService


class Flow(TypedDict, total=False):
    projectId: str
    decision: str
    feedback: str
    sceneId: str
    instruction: str


class StoryService:
    def __init__(self, repo: Any, workspace: WorkspaceService, agents: AgentExecutionService,
                 builder: GameBuilderService, checkpointer: Any) -> None:
        self.repo = repo
        self.workspace = workspace
        self.agents = agents
        self.builder = builder
        self.running: dict[str, asyncio.Task] = {}
        self.pending_reviews: set[str] = set()
        self.background: set[asyncio.Task] = set()
        self.shutting_down = False
        self.graph = self.create_graph(checkpointer)

    def config(self, project_id: str) -> dict:
        return {"configurable": {"thread_id": project_id}, "recursion_limit": 35}

    def create_graph(self, checkpointer: Any) -> Any:
        async def world(state: Flow) -> dict:
            await self.prepare_world(state["projectId"])
            return {}

        async def outline(state: Flow) -> dict:
            await self.prepare_outline(state["projectId"], state.get("feedback", ""))
            return {"feedback": ""}

        async def approval(state: Flow) -> dict:
            project = await self.repo.get(state["projectId"])
            # interrupt 的恢复值才是批准、修改或拒绝决定；暂停不占用 HTTP 请求。
            answer = interrupt({"type": "outline_review", "outlineVersion": project["outlineVersion"]})
            decision = answer["decision"]
            if decision == "approve":
                await self.patch(project["id"], {"approvedOutlineVersion": project["outlineVersion"],
                                                 "status": "writing_scenes"})
                await self.emit(project["id"], "outline_approved", f"Outline v{project['outlineVersion']} 已批准")
            elif decision == "revise":
                await self.patch(project["id"], {"outlineVersion": project["outlineVersion"] + 1,
                                                 "outline": None, "status": "designing_outline"})
                await self.emit(project["id"], "outline_revision",
                                f"根据反馈生成 Outline v{project['outlineVersion'] + 1}",
                                {"feedback": answer.get("feedback", "")})
            else:
                await self.patch(project["id"], {"status": "cancelled"})
                await self.emit(project["id"], "cancelled", "用户拒绝大纲，制作停止")
            return {"decision": decision, "feedback": answer.get("feedback", "")}

        async def scenes(state: Flow) -> dict:
            await self.prepare_scenes(state["projectId"])
            return {}

        async def review(state: Flow) -> dict:
            await self.review_and_release(state["projectId"])
            return {}

        async def rewrite_scene(state: Flow) -> dict:
            # 将单场景改写也纳入 Checkpoint；失败后仍由同一个 retry 入口恢复。
            project = await self.repo.get(state["projectId"])
            await self.write_scene(project, state["sceneId"], state["instruction"])
            return {}

        graph = StateGraph(Flow)
        for name, node in (("world", world), ("outline", outline), ("approval", approval),
                           ("scenes", scenes), ("review", review), ("rewrite_scene", rewrite_scene)):
            graph.add_node(name, node)
        graph.add_edge(START, "world")
        graph.add_edge("world", "outline")
        graph.add_edge("outline", "approval")
        graph.add_conditional_edges("approval", lambda state: state["decision"],
                                    {"approve": "scenes", "revise": "outline", "reject": END})
        graph.add_edge("scenes", "review")
        graph.add_edge("review", END)
        graph.add_edge("rewrite_scene", "review")
        return graph.compile(checkpointer=checkpointer)

    def spawn(self, work: Awaitable) -> None:
        task = asyncio.create_task(work)
        self.background.add(task)

        def finished(completed: asyncio.Task) -> None:
            self.background.discard(completed)
            if not completed.cancelled() and completed.exception():
                logging.error("后台制作失败", exc_info=completed.exception())

        task.add_done_callback(finished)

    async def start(self) -> None:
        for project in await self.repo.list():
            if project["status"] not in STOPPED | {"awaiting_outline_review", "needs_human_review"}:
                self.spawn(self.run(project["id"], None))

    async def close(self) -> None:
        # 关闭时取消当前执行，Checkpoint 保留已完成阶段，启动时继续同一 thread。
        self.shutting_down = True
        tasks = list(self.background)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def create(self, value: Any) -> dict:
        brief = BriefSchema.parse(value)
        if brief["mode"] == "replay" and brief != {**replay_brief, "replayScenario": brief["replayScenario"]}:
            raise BadRequest("Replay 只能使用预设的失联太空站制作要求；自定义创意请使用 AI 模式。")
        project_id = str(uuid4())
        now = now_iso()
        project = {
            "id": project_id, "runId": project_id, "version": 1, "revision": 1,
            "mode": brief["mode"], "brief": brief, "status": "queued",
            "world": None, "characters": None, "outline": None, "outlineVersion": 1,
            "approvedOutlineVersion": None, "review": None, "repairCount": 0,
            "latestReleaseId": None, "releaseIds": [], "failure": None,
            "activeRole": None, "currentTask": None, "tasks": [], "createdAt": now, "updatedAt": now,
        }
        await self.workspace.prepare(project_id, 1, brief)
        await self.repo.create(project)
        await self.emit(project_id, "created", "Replay 预设演示已开始" if brief["mode"] == "replay" else "AI 真实制作已开始")
        self.spawn(self.run(project_id, {"projectId": project_id}))
        return project

    async def review_outline(self, project_id: str, value: dict) -> None:
        if project_id in self.pending_reviews:
            raise Conflict("审核请求正在处理，请稍后刷新。")
        self.pending_reviews.add(project_id)
        try:
            project = await self.repo.get(project_id)
            if project["status"] != "awaiting_outline_review":
                raise Conflict("当前不在大纲审核阶段。")
            if project["outlineVersion"] != value["outlineVersion"]:
                raise Conflict(f"当前待审核的是 Outline v{project['outlineVersion']}。")
            if value["decision"] == "revise" and not value.get("feedback", "").strip():
                raise BadRequest("请填写修改意见。")
            if (project["mode"] == "replay" and value["decision"] == "revise"
                    and not re.search("代价|悬疑|紧张", value.get("feedback", ""))):
                raise BadRequest("Replay 只演示“明确结局代价”或“增加悬疑感”的大纲修改；自定义要求请使用 AI 模式。")
            state = await self.graph.aget_state(self.config(project_id))
            if "approval" not in state.next:
                raise Conflict("工作流没有停在大纲审核位置。")
        except BaseException:
            self.pending_reviews.discard(project_id)
            raise

        async def resume() -> None:
            try:
                await self.run(project_id, Command(resume=value))
            finally:
                self.pending_reviews.discard(project_id)

        self.spawn(resume())

    async def cancel(self, project_id: str) -> None:
        project = await self.repo.get(project_id)
        if project["status"] in {"ready", "cancelled"}:
            raise Conflict("当前项目已结束。")
        # 先持久化取消状态，再取消执行，迟到的产物不能被提交。
        await self.patch(project_id, {"status": "cancelled", "activeRole": None, "currentTask": None})
        task = self.running.get(project_id)
        if task:
            task.cancel()
        await self.emit(project_id, "cancelled", "用户停止了当前制作")

    async def retry(self, project_id: str) -> None:
        project = await self.repo.get(project_id)
        if project["status"] not in {"failed", "needs_human_review"}:
            raise Conflict("当前没有需要重试的任务。")
        await self.patch(project_id, {
            "status": "reviewing" if project["outline"] else "queued", "failure": None,
            # 请求失败保留本轮预算；用户继续人工处理状态才开启新的返工预算。
            "repairCount": 0 if project["status"] == "needs_human_review" else project["repairCount"],
        })
        if project["status"] == "needs_human_review":
            self.spawn(self.run_direct(project_id, lambda: self.review_and_release(project_id)))
        else:
            self.spawn(self.run(project_id, None))

    async def revise_scene(self, project_id: str, scene_id: str, instruction: str) -> None:
        project = await self.repo.get(project_id)
        if project["status"] != "ready":
            raise Conflict("只有已发布的游戏可以局部改写。")
        if not project["outline"] or not any(item["id"] == scene_id for item in project["outline"]["scenes"]):
            raise BadRequest("场景不存在。")
        if string_length(instruction.strip()) < 4 or string_length(instruction) > 500:
            raise BadRequest("修改要求应为 4～500 个字。")
        if re.search("增加场景|删除场景|改变分支|新增结局|世界规则", instruction):
            raise BadRequest("这项修改会改变大纲结构，需要重新规划，当前只支持单场景文字改写。")
        if project["mode"] == "replay" and not re.search("紧张|悬疑|压迫|对话|细节|更简洁", instruction):
            raise BadRequest("Replay 只演示固定的文字改写；请使用 AI 模式提交自定义要求。")
        await self.workspace.copy_revision(project_id, project["revision"], project["revision"] + 1)
        await self.patch(project_id, {"revision": project["revision"] + 1, "status": "writing_scenes",
                                      "review": None, "repairCount": 0})
        await self.emit(project_id, "scene_revision", f"创建 Revision {project['revision'] + 1}，只改写 {scene_id}",
                        {"instruction": instruction})

        # 从已经结束的制作图进入改写节点，持久化这次要求和当前执行位置。
        self.spawn(self.run(project_id, Command(goto="rewrite_scene", update={
            "projectId": project_id, "sceneId": scene_id, "instruction": instruction,
        })))

    async def run(self, project_id: str, value: Any) -> None:
        async def invoke() -> None:
            snapshot = await self.graph.aget_state(self.config(project_id))
            next_value = {"projectId": project_id} if value is None and not snapshot.values.get("projectId") else value
            await self.graph.ainvoke(next_value, self.config(project_id))
        await self.run_direct(project_id, invoke)

    async def run_direct(self, project_id: str, work: Callable[[], Awaitable]) -> None:
        if project_id in self.running:
            return
        if (await self.repo.get(project_id))["status"] == "cancelled":
            return
        self.running[project_id] = asyncio.current_task()
        try:
            await work()
        except asyncio.CancelledError:
            # 取消向模型和文件任务传播；关闭时保持可恢复状态，不标记普通失败。
            raise
        except Exception as error:
            project = await self.repo.get(project_id)
            if project["status"] != "cancelled" and not self.shutting_down:
                await self.patch(project_id, {"status": "failed", "failure": str(error),
                                              "activeRole": None, "currentTask": None})
                await self.emit(project_id, "failed", str(error))
        finally:
            self.running.pop(project_id, None)

    async def ensure_active(self, project_id: str) -> None:
        task = asyncio.current_task()
        if (await self.repo.get(project_id))["status"] == "cancelled" or (task and task.cancelling()):
            raise RuntimeError("任务已取消。")

    async def patch(self, project_id: str, changes: dict) -> dict:
        for attempt in range(3):
            project = await self.repo.get(project_id)
            try:
                return await self.repo.save({**project, **changes})
            except Conflict:
                if attempt == 2:
                    raise
        raise Conflict("项目状态更新冲突。")

    async def emit(self, project_id: str, kind: str, message: str, detail: dict | None = None) -> None:
        await self.repo.event(project_id, kind, message, detail or {})

    async def assignment(self, project: dict, role: str, goal: str, reads: list[str],
                         names: list[str], criteria: list[str], **extras: Any) -> dict:
        """任务单记录输入文件 Hash、候选交付路径和角色验收条件。"""
        task_id = str(uuid4())
        writes = await self.workspace.stage(project["id"], task_id, names)
        manifest = {virtual: digest(await self.workspace.read_text(project["id"], virtual)) for virtual in reads}
        skill = {"world-designer": "world-building", "plot-architect": "branch-story-design",
                 "scene-writer": "scene-writing", "continuity-reviewer": "continuity-review"}[role]
        return {"taskId": task_id, "projectId": project["id"], "revision": project["revision"],
                "assignee": role, "goal": goal, "readFiles": reads, "writeFiles": writes,
                "skillPath": f"/skills/{skill}/SKILL.md", "acceptanceCriteria": criteria,
                "inputManifest": manifest, **extras}

    async def task(self, project: dict, assignment: dict, destinations: list[str], validate: Callable) -> Any:
        """执行角色任务，验收真实文件并确认输入未变，再提交正式产物。"""
        await self.ensure_active(project["id"])
        task = {"id": assignment["taskId"], "role": assignment["assignee"], "status": "running",
                "inputs": assignment["readFiles"], "outputs": destinations}
        latest = await self.repo.get(project["id"])
        await self.patch(project["id"], {"activeRole": assignment["assignee"], "currentTask": task["id"],
                                         "tasks": [*latest["tasks"], task]})
        await self.emit(project["id"], "task_started", f"{assignment['assignee']} 开始任务",
                        {"taskId": task["id"], "readFiles": task["inputs"], "writeFiles": task["outputs"]})
        try:
            await self.agents.execute(project, assignment,
                                      lambda kind, message, detail=None: self.emit(project["id"], kind, message, detail))
            await self.ensure_active(project["id"])
            values = [await self.workspace.read_json(project["id"], virtual) for virtual in assignment["writeFiles"]]
            result = validate(values)
            for virtual, previous_hash in assignment["inputManifest"].items():
                if digest(await self.workspace.read_text(project["id"], virtual)) != previous_hash:
                    raise ValueError(f"任务输入已变化：{virtual}")
            await self.ensure_active(project["id"])
            for staged, destination in zip(assignment["writeFiles"], destinations, strict=True):
                await self.workspace.promote(project["id"], staged, destination)
            current = await self.repo.get(project["id"])
            await self.patch(project["id"], {"activeRole": None, "currentTask": None, "tasks": [
                {**item, "status": "completed"} if item["id"] == task["id"] else item for item in current["tasks"]
            ]})
            await self.emit(project["id"], "task_completed", f"{assignment['assignee']} 的文件通过验收",
                            {"taskId": task["id"], "destinations": destinations})
            return result
        except (Exception, asyncio.CancelledError) as error:
            current = await self.repo.get(project["id"])
            await self.patch(project["id"], {"activeRole": None, "currentTask": None, "tasks": [
                {**item, "status": "failed", "error": str(error)} if item["id"] == task["id"] else item
                for item in current["tasks"]
            ]})
            raise

    async def prepare_world(self, project_id: str) -> None:
        """设计世界观与人物；已有成功产物时不重复调用角色。"""
        project = await self.repo.get(project_id)
        if project["world"] and project["characters"]:
            return
        await self.patch(project_id, {"status": "designing_world"})
        base = f"/revisions/{project['revision']}"
        assignment = await self.assignment(project, "world-designer", "设计世界规则与人物档案",
                                            [f"{base}/brief.md", f"{base}/brief.json", "/contracts/world.schema.json",
                                             "/contracts/characters.schema.json"], ["world.json", "characters.json"],
                                            ["符合世界规则", "角色数量与制作要求一致"])
        world, characters = await self.task(project, assignment, [f"{base}/world.json", f"{base}/characters.json"],
                                            lambda values: (WorldSchema.parse(values[0]), CharactersSchema.parse(values[1])))
        if len(characters["characters"]) != project["brief"]["characterCount"]:
            raise ValueError("角色数量不符合制作要求。")
        await self.patch(project_id, {"world": world, "characters": characters})

    async def prepare_outline(self, project_id: str, feedback: str) -> None:
        """用 Schema 和状态可达性两层校验大纲，然后等待人工审核。"""
        project = await self.repo.get(project_id)
        if project["outline"] and project["status"] == "awaiting_outline_review":
            return
        await self.patch(project_id, {"status": "designing_outline"})
        base = f"/revisions/{project['revision']}"
        goal = "根据世界设定设计分支大纲。" + (f"用户修改意见：{feedback}" if feedback else "")
        assignment = await self.assignment(project, "plot-architect", goal,
                                            [f"{base}/brief.md", f"{base}/world.json", f"{base}/characters.json",
                                             "/contracts/outline.schema.json"], ["outline.json"],
                                            ["所有场景、结局和状态路径可达", "角色与场景数量符合要求"])

        def validate(values: list) -> dict:
            value = OutlineSchema.parse(values[0])
            assert_outline(project["brief"], value, project["characters"])
            return value

        outline = await self.task(project, assignment, [f"{base}/outline-v{project['outlineVersion']}.json"], validate)
        await self.patch(project_id, {"outline": outline, "status": "awaiting_outline_review"})
        await self.emit(project_id, "outline_ready", f"Outline v{project['outlineVersion']} 等待人工审核")

    async def prepare_scenes(self, project_id: str) -> None:
        """只编写当前已批准大纲中的场景，失败后逐文件恢复。"""
        project = await self.repo.get(project_id)
        if not project["outline"] or project["approvedOutlineVersion"] != project["outlineVersion"]:
            raise ValueError("当前大纲尚未批准。")
        await self.patch(project_id, {"status": "writing_scenes"})
        for scene in project["outline"]["scenes"]:
            await self.ensure_active(project_id)
            virtual = f"/revisions/{project['revision']}/scenes/{scene['id']}.json"
            try:
                assert_scene(project["outline"], await self.workspace.read_json(project_id, virtual), scene["id"])
                # 失败后恢复整个 scenes 节点，已完成且符合批准大纲的文件直接复用。
                continue
            except Exception:
                await self.write_scene(project, scene["id"])

    async def write_scene(self, project: dict, scene_id: str, instruction: str | None = None,
                          repair: bool = False) -> None:
        """首次编写、用户改写与报告返工共享场景任务，始终保留批准分支。"""
        if not project["outline"]:
            raise ValueError("没有已批准大纲。")
        base = f"/revisions/{project['revision']}"
        reads = [f"{base}/brief.md", f"{base}/world.json", f"{base}/characters.json",
                 f"{base}/outline-v{project['outlineVersion']}.json", "/contracts/scene.schema.json"]
        if repair or instruction:
            reads.append(f"{base}/scenes/{scene_id}.json")
        if repair:
            reads.append(f"{base}/reviews/review-{project['repairCount'] - 1}.json")
        goal = (f"根据审核问题修复 {scene_id} 的正文，不修改任何其他场景。" if repair else
                f"按用户要求改写 {scene_id}：{instruction}" if instruction else
                f"按照已批准大纲编写 {scene_id} 的正文。")
        extras = {"sceneId": scene_id}
        if instruction is not None:
            extras["instruction"] = instruction
        assignment = await self.assignment(project, "scene-writer", goal, reads, [f"{scene_id}.json"],
                                            ["只写本场景标题与正文", "分支结构与批准大纲完全一致"], **extras)
        await self.task(project, assignment, [f"{base}/scenes/{scene_id}.json"],
                        lambda values: assert_scene(project["outline"], values[0], scene_id))

    async def scenes(self, project: dict) -> list[dict]:
        if not project["outline"]:
            raise ValueError("大纲缺失。")
        return [assert_scene(project["outline"], await self.workspace.read_json(project["id"],
                f"/revisions/{project['revision']}/scenes/{item['id']}.json"), item["id"])
                for item in project["outline"]["scenes"]]

    async def review_and_release(self, project_id: str) -> None:
        """审核 → 只返工问题场景 → 再审核，最多两轮；通过后生成独立 Release。"""
        project = await self.repo.get(project_id)
        if not project["outline"] or not project["characters"] or not project["approvedOutlineVersion"]:
            raise ValueError("构建依赖尚未齐全。")
        while True:
            await self.ensure_active(project_id)
            await self.patch(project_id, {"status": "reviewing"})
            project = await self.repo.get(project_id)
            scenes = await self.scenes(project)
            base = f"/revisions/{project['revision']}"
            paths = [f"{base}/scenes/{item['id']}.json" for item in project["outline"]["scenes"]]
            assignment = await self.assignment(project, "continuity-reviewer",
                "检查全部场景是否违反世界设定或人物动机，给出有原文依据的审核报告",
                [f"{base}/brief.md", f"{base}/world.json", f"{base}/characters.json",
                 f"{base}/outline-v{project['outlineVersion']}.json", *paths, "/contracts/review.schema.json"],
                ["review.json"], ["问题引用必须来自真实场景正文", "无问题时 approved 且 issues 为空"])
            report = await self.task(project, assignment, [f"{base}/reviews/review-{project['repairCount']}.json"],
                                     lambda values: assert_review(values[0], scenes))
            await self.patch(project_id, {"review": report})
            await self.emit(project_id, "review_completed", "剧情一致性审核通过" if report["verdict"] == "approved"
                            else f"发现 {len(report['issues'])} 个剧情问题", {"issues": report["issues"]})
            if report["verdict"] == "approved":
                break
            if project["repairCount"] >= 2:
                await self.patch(project_id, {"status": "needs_human_review", "failure": "自动返工已达到两轮，请人工检查。"})
                return
            affected = list(dict.fromkeys(issue["filePath"].removeprefix("/scenes/").removesuffix(".json")
                                          for issue in report["issues"]))
            await self.patch(project_id, {"repairCount": project["repairCount"] + 1})
            project = await self.repo.get(project_id)
            for scene_id in affected:
                await self.write_scene(project, scene_id, repair=True)
            await self.emit(project_id, "repair_completed", f"只返工 {'、'.join(affected)}", {"affected": affected})

        await self.ensure_active(project_id)
        project = await self.repo.get(project_id)
        finished = await self.scenes(project)
        base = f"/revisions/{project['revision']}"
        sources = [f"{base}/world.json", f"{base}/characters.json", f"{base}/outline-v{project['outlineVersion']}.json",
                   *(f"{base}/scenes/{scene['id']}.json" for scene in project["outline"]["scenes"])]
        release = await self.builder.release(project,
                  game_from_outline(project["brief"], project["outline"], project["characters"], finished), sources)
        await self.ensure_active(project_id)
        await self.patch(project_id, {"latestReleaseId": release["id"], "releaseIds": [*project["releaseIds"], release["id"]],
                                      "status": "ready", "failure": None, "activeRole": None})
        await self.emit(project_id, "released", "游戏已通过检查，可以试玩与下载",
                        {"releaseId": release["id"], "endings": list(release["paths"])})
