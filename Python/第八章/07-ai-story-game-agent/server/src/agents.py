"""AI / Replay 共用任务单；AI 由总导演委派隔离角色写候选文件。"""

import os
from collections.abc import Awaitable, Callable
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from deepagents.middleware.filesystem import FilesystemPermission
from langchain.agents.middleware import AgentMiddleware
from langchain_deepseek import ChatDeepSeek

from .replay import (defect_quote, replay_characters, replay_outline, replay_report,
                     replay_revised_outline, replay_revised_scene, replay_scenes, replay_world)
from .workspace import WorkspaceService, json_text

AgentEvent = Callable[[str, str, dict | None], Awaitable[None]]
ROLE_PROFILES = {
    "world-designer": {
        "description": "根据制作要求设计世界规则和人物档案，并保存两个 JSON 文件。",
        "system_prompt": "你是世界观设计师。先读取任务单中的 Skill、brief 和交付 Schema。遵守用户明确提出的世界规则，生成世界观和指定数量的人物。把完整 JSON 写入各自路径，再读取核对。只返回路径与简短摘要。",
    },
    "plot-architect": {
        "description": "根据世界规则和人物设计可玩的有限分支剧情大纲。",
        "system_prompt": "你是剧情策划。先读取 Skill、brief、世界规则、人物和 outline Schema。按照 brief 规定的场景总数与结局数设计剧情，两个布尔状态以内优先。所有选项可达且至少一处因前面选择改变后续可选项。每个普通场景提供两个选择，结局没有选择。仅交付 JSON 文件路径和简短说明。",
    },
    "scene-writer": {
        "description": "按照已批准的大纲只编写当前场景的标题和正文。",
        "system_prompt": "你是场景编剧。先读取 Skill、世界观、大纲、角色和相邻场景摘要。只编写任务指定场景，保留大纲给出的 id、ending 与 choices，不更改分支、条件或效果。若是返工，根据报告修复明确问题，保留选项原有收益与代价。写入 JSON 后重新读取，最后只汇报路径与摘要。",
    },
    "continuity-reviewer": {
        "description": "对照世界规则、人物和剧情大纲，输出带真实原文引用的审核报告。",
        "system_prompt": "你是剧情一致性审核者。先读取 Skill、世界观、人物、大纲、场景和 review Schema。只报告明确的世界规则、人物或时间线冲突，不猜测未提供的设定，也不因个人审美要求返工。同一根本问题只报告一次。quote 必须逐字摘录受影响场景 content 中的原文；建议不得违反其他规则。只写任务指定的审核报告，不修改场景。",
    },
}


class WorkerTrace(AgentMiddleware):
    def __init__(self, assignment: dict, event: AgentEvent) -> None:
        self.assignment = assignment
        self.event = event
        self.skill_read = False

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        call = request.tool_call
        if call["name"] not in {"read_file", "write_file", "edit_file", "ls", "glob", "grep", "search"}:
            raise RuntimeError(f"角色不能执行 {call['name']}。")
        file_path = str(call["args"].get("file_path", call["args"].get("path", "")))
        # 与源案例相同，这个标记证明发起读取；文件是否可读由实际工具执行决定。
        if call["name"] == "read_file" and file_path == self.assignment["skillPath"]:
            self.skill_read = True
        await self.event("ai_tool", f"{self.assignment['assignee']} 调用 {call['name']}",
                         {"taskId": self.assignment["taskId"], "filePath": file_path})
        return await handler(request)


class DelegationBoundary(AgentMiddleware):
    def __init__(self, assignment: dict, event: AgentEvent) -> None:
        self.assignment = assignment
        self.event = event
        self.dispatched = False

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        call = request.tool_call
        if (call["name"] != "task" or call["args"].get("subagent_type") != self.assignment["assignee"]
                or self.dispatched):
            raise RuntimeError("本阶段只允许向指定角色委派一次任务。")
        self.dispatched = True
        await self.event("ai_delegate", f"总导演调用 task 委派 {self.assignment['assignee']}",
                         {"taskId": self.assignment["taskId"]})
        # Python SDK 使用 request.override；完整任务单由程序持有，不由模型转述。
        return await handler(request.override(tool_call={
            **call, "args": {**call["args"], "description": json_text(self.assignment, pretty=False)},
        }))


class AgentExecutionService:
    def __init__(self, workspace: WorkspaceService, model_factory: Callable[[], Any] | None = None) -> None:
        self.workspace = workspace
        self.model_factory = model_factory

    async def execute(self, project: dict, assignment: dict, event: AgentEvent) -> None:
        if project["mode"] == "replay":
            await self.run_replay(project, assignment, event)
        else:
            # Python 用 asyncio Task 的取消机制向下传播取消，无需另传 AbortSignal。
            await self.run_ai(project, assignment, event)

    async def run_replay(self, project: dict, assignment: dict, event: AgentEvent) -> None:
        await event("replay_delegate", f"预设演示：总导演委派 {assignment['assignee']}",
                    {"taskId": assignment["taskId"]})
        outputs = assignment["writeFiles"]
        role = assignment["assignee"]
        if role == "world-designer":
            await self.workspace.write_json(project["id"], outputs[0], replay_world)
            await self.workspace.write_json(project["id"], outputs[1], replay_characters)
        elif role == "plot-architect":
            outline = replay_revised_outline(assignment["goal"]) if project["outlineVersion"] > 1 else replay_outline
            await self.workspace.write_json(project["id"], outputs[0], outline)
        elif role == "scene-writer":
            if assignment.get("instruction"):
                scene = replay_revised_scene(assignment["sceneId"], assignment["instruction"])
            elif "审核问题" in assignment["goal"]:
                scene = replay_revised_scene(assignment["sceneId"])
            else:
                scene = next((item for item in replay_scenes(project["brief"]["replayScenario"] == "defect")
                              if item["id"] == assignment["sceneId"]), None)
            if scene is None:
                raise ValueError(f"Replay 缺少场景：{assignment['sceneId']}")
            await self.workspace.write_json(project["id"], outputs[0], scene)
        elif role == "continuity-reviewer":
            content = await self.workspace.read_text(project["id"],
                                                     f"/revisions/{project['revision']}/scenes/ending-02.json")
            await self.workspace.write_json(project["id"], outputs[0], replay_report(defect_quote in content))
        else:
            raise ValueError(f"未知执行角色：{role}")
        await event("replay_artifact", "预设角色产物已写入候选目录", {"paths": outputs})

    async def run_ai(self, project: dict, assignment: dict, event: AgentEvent) -> None:
        if not os.getenv("DEEPSEEK_API_KEY"):
            raise RuntimeError("AI 模式需要在本机配置 DEEPSEEK_API_KEY。")
        role = assignment["assignee"]
        profile = ROLE_PROFILES[role]
        model = self.model_factory() if self.model_factory else ChatDeepSeek(
            model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"), temperature=0, max_retries=1, timeout=120,
        )
        boundary = DelegationBoundary(assignment, event)
        worker = WorkerTrace(assignment, event)
        director = create_deep_agent(
            name="story-director", model=model,
            backend=FilesystemBackend(root_dir=self.workspace.project_root(project["id"]), virtual_mode=True),
            # 制作阶段由外层 Graph 持久化；每次角色任务都重新委派到新候选路径。
            checkpointer=False,
            permissions=[FilesystemPermission(operations=["write"], paths=["/**"], mode="deny")],
            subagents=[{
                "name": role, **profile, "mode": "isolated", "skills": ["/skills/"],
                "permissions": [
                    FilesystemPermission(operations=["write"], paths=assignment["writeFiles"], mode="allow"),
                    FilesystemPermission(operations=["write"], paths=["/**"], mode="deny"),
                ],
                "middleware": [worker],
            }],
            system_prompt="""你是剧情总导演。当前阶段已经确定任务单和角色。
请调用一次 task，把完整 JSON 任务单委派给 assignee。等待该角色完成后只回复交付路径与简短摘要。
你不直接写文件，也不调用其他工具。""",
            middleware=[boundary],
        )
        await director.ainvoke({"messages": [{"role": "user", "content": json_text(assignment, pretty=False)}]},
                               {"recursion_limit": 45})
        if not boundary.dispatched:
            raise RuntimeError("总导演没有委派任务。")
        if not worker.skill_read:
            raise RuntimeError(f"{role} 没有读取指定 Skill。")
        for virtual_path in assignment["writeFiles"]:
            await self.workspace.read_text(project["id"], virtual_path)
