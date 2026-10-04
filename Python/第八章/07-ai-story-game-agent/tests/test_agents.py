"""实际运行 Deep Agents；只替换模型回复，不调用任何模型 API。"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from langchain.agents.middleware.types import ToolCallRequest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph

from server.src.agents import AgentExecutionService, DelegationBoundary, WorkerTrace
from server.src.replay import replay_brief
from server.src.workspace import WorkspaceService


class OfflineModel(BaseChatModel):
    fail_once: bool = True
    child_assignments: list[dict] = []
    attempt_unauthorized_write: bool = False

    @property
    def _llm_type(self):
        return "offline-story-model"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        assignment = json.loads(next(item.content for item in reversed(messages) if isinstance(item, HumanMessage)))
        director = any(isinstance(item, SystemMessage) and "你是剧情总导演" in str(item.content) for item in messages)
        results = [item for item in messages if isinstance(item, ToolMessage)]

        def call(name, args):
            return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": str(uuid4())}])

        if director:
            reply = AIMessage(content="已交付") if results else call("task", {
                "subagent_type": assignment["assignee"], "description": "模型的简化任务，会被程序原始任务单覆盖",
            })
        elif not results:
            self.child_assignments.append(assignment)
            reply = call("read_file", {"file_path": assignment["skillPath"]})
        elif assignment["sceneId"] == "scene-2" and self.fail_once:
            self.fail_once = False
            raise TimeoutError("模拟角色读取 Skill 后模型请求超时")
        elif self.attempt_unauthorized_write and len(results) == 1:
            reply = call("write_file", {"file_path": "/revisions/1/brief.md", "content": "不应允许的写入"})
        elif len(results) == (2 if self.attempt_unauthorized_write else 1):
            reply = call("write_file", {"file_path": assignment["writeFiles"][0],
                                        "content": json.dumps({"id": assignment["sceneId"]})})
        else:
            reply = AIMessage(content=assignment["writeFiles"][0])
        return ChatResult(generations=[ChatGeneration(message=reply)])


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_child_redelegates_after_outer_graph_resume(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"DEEPSEEK_API_KEY": "offline-test-key"}):
            workspace = WorkspaceService(Path(directory))
            project = {"id": str(uuid4()), "mode": "ai"}
            await workspace.prepare(project["id"], 1, {**replay_brief, "mode": "ai"})
            model = OfflineModel()
            agents = AgentExecutionService(workspace, model_factory=lambda: model)
            completed = []
            assignments = []
            delegated = []

            async def event(kind, message, detail=None):
                if kind == "ai_delegate":
                    delegated.append(detail["taskId"])

            async def scenes(state):
                for scene_id in ["scene-1", "scene-2"]:
                    if scene_id in completed:
                        continue
                    task_id = str(uuid4())
                    assignment = {"taskId": task_id, "projectId": project["id"], "revision": 1,
                        "assignee": "scene-writer", "goal": f"编写 {scene_id}", "sceneId": scene_id,
                        "readFiles": [], "writeFiles": await workspace.stage(project["id"], task_id, [f"{scene_id}.json"]),
                        "skillPath": "/skills/scene-writing/SKILL.md", "acceptanceCriteria": [], "inputManifest": {}}
                    assignments.append(assignment)
                    await agents.execute(project, assignment, event)
                    self.assertEqual(await workspace.read_json(project["id"], assignment["writeFiles"][0]), {"id": scene_id})
                    completed.append(scene_id)
                return {}

            graph = (StateGraph(dict).add_node("scenes", scenes).add_edge(START, "scenes").add_edge("scenes", END)
                     .compile(checkpointer=InMemorySaver()))
            config = {"configurable": {"thread_id": project["id"]}}
            with self.assertRaises(Exception):
                await graph.ainvoke({"projectId": project["id"]}, config)
            self.assertEqual(completed, ["scene-1"])
            await graph.ainvoke(None, config)
            self.assertEqual(completed, ["scene-1", "scene-2"])
            self.assertEqual([item["sceneId"] for item in assignments], ["scene-1", "scene-2", "scene-2"])
            self.assertNotEqual(assignments[1]["writeFiles"], assignments[2]["writeFiles"])
            self.assertEqual(delegated, [item["taskId"] for item in assignments])
            self.assertEqual(model.child_assignments, assignments)
            self.assertEqual((await graph.aget_state(config)).next, ())

    async def test_actual_filesystem_permissions_block_non_candidate_write(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"DEEPSEEK_API_KEY": "offline-test-key"}):
            workspace = WorkspaceService(Path(directory))
            project = {"id": str(uuid4()), "mode": "ai"}
            await workspace.prepare(project["id"], 1, {**replay_brief, "mode": "ai"})
            before = await workspace.read_text(project["id"], "/revisions/1/brief.md")
            task_id = str(uuid4())
            assignment = {"taskId": task_id, "assignee": "scene-writer", "sceneId": "scene-1",
                "writeFiles": await workspace.stage(project["id"], task_id, ["scene-1.json"]),
                "skillPath": "/skills/scene-writing/SKILL.md"}

            async def event(kind, message, detail=None):
                pass

            agents = AgentExecutionService(workspace, model_factory=lambda: OfflineModel(fail_once=False, attempt_unauthorized_write=True))
            await agents.execute(project, assignment, event)
            self.assertEqual(await workspace.read_text(project["id"], "/revisions/1/brief.md"), before)
            self.assertEqual(await workspace.read_json(project["id"], assignment["writeFiles"][0]), {"id": "scene-1"})

    async def test_director_and_worker_tool_boundaries(self):
        async def event(kind, message, detail=None):
            pass

        assignment = {"taskId": "one", "assignee": "scene-writer", "skillPath": "/skills/scene-writing/SKILL.md"}
        boundary = DelegationBoundary(assignment, event)
        request = ToolCallRequest(tool_call={"name": "task", "id": "call-one",
            "args": {"subagent_type": "scene-writer", "description": "被改写"}}, tool=None, state={}, runtime=None)
        forwarded = []

        async def handler(value):
            forwarded.append(value.tool_call)
            return ToolMessage(content="完成", tool_call_id="call-one")

        await boundary.awrap_tool_call(request, handler)
        self.assertEqual(json.loads(forwarded[0]["args"]["description"]), assignment)
        with self.assertRaisesRegex(RuntimeError, "只允许"):
            await boundary.awrap_tool_call(request, handler)
        worker = WorkerTrace(assignment, event)
        with self.assertRaisesRegex(RuntimeError, "角色不能执行"):
            await worker.awrap_tool_call(request.override(tool_call={"name": "execute", "args": {}, "id": "execute"}), handler)
