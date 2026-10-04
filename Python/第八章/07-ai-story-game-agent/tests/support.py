"""Repository 测试替身，只用于临时文件和离线 API 测试。"""

import asyncio
from copy import deepcopy

from server.src.errors import Conflict, NotFound
from server.src.project import now_iso


class MemoryRepository:
    def __init__(self):
        self.projects = {}
        self.log = []

    async def setup(self):
        pass

    async def close(self):
        pass

    async def create(self, project):
        self.projects[project["id"]] = deepcopy(project)
        return deepcopy(project)

    async def get(self, project_id):
        if project_id not in self.projects:
            raise NotFound("项目不存在。")
        return deepcopy(self.projects[project_id])

    async def list(self):
        return sorted(deepcopy(list(self.projects.values())), key=lambda item: item["updatedAt"], reverse=True)[:50]

    async def save(self, project):
        if self.projects[project["id"]]["version"] != project["version"]:
            raise Conflict("项目状态已变化，请刷新后重试。")
        next_project = {**deepcopy(project), "version": project["version"] + 1, "updatedAt": now_iso()}
        self.projects[project["id"]] = next_project
        return deepcopy(next_project)

    async def event(self, project_id, kind, message, detail=None):
        event = {"id": len(self.log) + 1, "projectId": project_id, "kind": kind, "message": message,
                 "detail": deepcopy(detail or {}), "createdAt": now_iso()}
        self.log.append(event)
        return deepcopy(event)

    async def events(self, project_id, after_id=0):
        return deepcopy([event for event in self.log if event["projectId"] == project_id and event["id"] > after_id][:300])


async def wait_state(service, project_id, expected, outline_version=None):
    for _ in range(1000):
        value = await service.repo.get(project_id)
        if value["status"] == expected and (outline_version is None or value["outlineVersion"] == outline_version):
            # 确认后台执行已经离开当前轮，防止审批请求和初次运行抢同一个 thread。
            if project_id not in service.running:
                return value
        if value["status"] == "failed" and expected != "failed":
            raise AssertionError(value["failure"])
        await asyncio.sleep(0.002)
    raise AssertionError(f"项目没有进入 {expected}：{await service.repo.get(project_id)}")
