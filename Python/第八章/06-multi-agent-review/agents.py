"""按任务单配置审核者或编写者，并强制总导演只委派一次。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from deepagents.middleware.filesystem import FilesystemPermission
from langchain.agents.middleware import AgentMiddleware


ROLES = {
    "continuity-reviewer": {
        "description": "对照世界规则审核场景正文，输出含原文引用的 JSON 问题报告。",
        "system_prompt": """你是剧情一致性审核者。读取任务单指定的 Skill、规则、场景和报告 Schema。
逐项核对场景正文与世界规则。关注明确冲突，不因个人审美要求返工，也不推测文件没有提供的设备属性。
同一个根本问题只记录一次。修改建议也必须符合全部世界规则，禁止建议等待外部救援或恢复对外通信。
只审核任务单指定的当前文件，不参考之前的审核结论。
问题引用 quote 必须逐字摘录对应文件 content 字段中的原文。
存在冲突时 verdict 为 needs_revision；没有冲突时为 approved 且 issues 为空。
将纯 JSON 报告写入指定路径。只写审核报告，保持游戏文件不变。
最终只回复报告路径和问题数量。""",
    },
    "scene-writer": {
        "description": "根据审核问题，只修复被授权场景的标题和正文。",
        "system_prompt": """你是场景编写者。读取任务单指定的 Skill、世界规则、场景和审核报告。
仅修改 writeFiles 中的文件，只修改 title 和 content，保留 id、ending、choices。
根据问题原因进行实质修改，保留这个选择原有的收益和代价，不要把两个结局改成相同结果。
输出符合 scene.schema.json 的纯 JSON 文件，完成后重新读取核对。
最终只回复修改文件路径和修改摘要。""",
    },
}


class WorkerTraceMiddleware(AgentMiddleware):
    """只输出子 Agent 的工具和文件路径，不改变执行结果。"""

    def __init__(self, assignee: str) -> None:
        self.assignee = assignee

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        call = request.tool_call
        print(f"[{self.assignee}] {call['name']} {call.get('args', {}).get('file_path', '')}")
        return await handler(request)


class DelegationBoundaryMiddleware(AgentMiddleware):
    """限制总导演只调用一次指定子 Agent，并传递原始完整任务单。"""

    def __init__(self, assignee: str, assignment: dict[str, Any]) -> None:
        self.assignee = assignee
        self.assignment = assignment
        self.dispatched = False

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        call = request.tool_call
        args = call.get("args") or {}
        if call["name"] != "task" or args.get("subagent_type") != self.assignee or self.dispatched:
            raise RuntimeError("本阶段只允许向指定角色委派一次任务。")

        self.dispatched = True
        print(f"\n[总导演] task → {self.assignee}")

        # Python SDK 的 ToolCallRequest.override 对应 Node 版替换 toolCall。
        # 强制使用程序给出的原始任务单，防止模型转述时遗漏修改范围和验收条件。
        original_description = json.dumps(self.assignment, ensure_ascii=False, separators=(",", ":"))
        modified = request.override(tool_call={
            **call,
            "args": {**args, "description": original_description},
        })
        return await handler(modified)


async def delegate_task(model: Any, workspace_dir: Path, assignment: dict[str, Any]) -> None:
    """总导演通过 task 调用指定角色；阶段和文件权限由工作流决定。"""

    assignee = assignment["assignee"]
    write_files = assignment["writeFiles"]
    role = ROLES.get(assignee)
    if role is None:
        raise ValueError(f"未知执行角色：{assignee}")

    boundary = DelegationBoundaryMiddleware(assignee, assignment)
    director = create_deep_agent(
        model=model,
        backend=FilesystemBackend(root_dir=workspace_dir, virtual_mode=True),
        # 总导演默认不可写入，必须委派给当前阶段的子 Agent。
        permissions=[FilesystemPermission(operations=["write"], paths=["/**"], mode="deny")],
        subagents=[{
            "name": assignee,
            **role,
            "mode": "isolated",
            "skills": ["/skills/"],
            "permissions": [
                FilesystemPermission(operations=["write"], paths=write_files, mode="allow"),
                FilesystemPermission(operations=["write"], paths=["/**"], mode="deny"),
            ],
            "middleware": [WorkerTraceMiddleware(assignee)],
        }],
        system_prompt="""你是总导演。当前处于已确定的检查或返工阶段。
将收到的完整 JSON 任务单原样作为 description，
使用 task 委派给其中的 assignee，等待完成后简短回复。

本阶段只调用一次 task，无需使用其他工具。
下一阶段由程序根据实际文件决定。""",
        middleware=[boundary],
    )

    # 子 Agent 的具体任务由 task.description 传递；总导演本身不改文件。
    await director.ainvoke(
        {"messages": [{
            "role": "user",
            "content": json.dumps(assignment, ensure_ascii=False, separators=(",", ":")),
        }]},
        {"recursion_limit": 40},
    )
    if not boundary.dispatched:
        raise RuntimeError("总导演没有实际委派任务，停止交付。")
