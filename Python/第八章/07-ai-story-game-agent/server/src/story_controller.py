"""本地工作台 API；文件及 Release 由项目登记信息定位。"""

import asyncio
import os

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, StreamingResponse

from .errors import BadRequest
from .workspace import json_text


def build_router(stories, repo, workspace) -> APIRouter:
    router = APIRouter(prefix="/api/projects")

    @router.get("")
    async def list_projects():
        return await repo.list()

    @router.get("/meta")
    async def meta():
        return {"aiConfigured": bool(os.getenv("DEEPSEEK_API_KEY")), "modes": ["replay", "ai"],
                "database": "PostgreSQL", "replayScope": "失联太空站固定样本"}

    @router.post("", status_code=201)
    async def create(value: dict):
        return await stories.create(value)

    @router.get("/{project_id}")
    async def get(project_id: str):
        return await repo.get(project_id)

    @router.get("/{project_id}/events")
    async def events(project_id: str, after: int = 0):
        await repo.get(project_id)
        return await repo.events(project_id, after)

    @router.get("/{project_id}/events/live")
    async def live(project_id: str, request: Request, after: int = 0):
        await repo.get(project_id)
        try:
            last = int(request.headers.get("last-event-id", after))
        except ValueError as error:
            raise BadRequest("事件序号不合法。") from error

        async def generate():
            nonlocal last
            while not await request.is_disconnected():
                for event in await repo.events(project_id, last):
                    last = event["id"]
                    yield f"id: {last}\ndata: {json_text(event, pretty=False)}\n\n"
                await asyncio.sleep(1)

        return StreamingResponse(generate(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @router.post("/{project_id}/outline-review", status_code=201)
    async def review(project_id: str, value: dict):
        if value.get("decision") not in {"approve", "revise", "reject"}:
            raise BadRequest("审核决定不合法。")
        if type(value.get("outlineVersion")) is not int or not isinstance(value.get("feedback", ""), str):
            raise BadRequest("审核版本或修改意见不合法。")
        await stories.review_outline(project_id, value)
        return {"accepted": True}

    @router.post("/{project_id}/revise-scene", status_code=201)
    async def revise(project_id: str, value: dict):
        if not isinstance(value.get("sceneId"), str) or not isinstance(value.get("instruction"), str):
            raise BadRequest("场景 ID 与修改要求不能为空。")
        await stories.revise_scene(project_id, value["sceneId"], value["instruction"])
        return {"accepted": True}

    @router.post("/{project_id}/retry", status_code=201)
    async def retry(project_id: str):
        await stories.retry(project_id)
        return {"accepted": True}

    @router.post("/{project_id}/cancel", status_code=201)
    async def cancel(project_id: str):
        await stories.cancel(project_id)
        return {"accepted": True}

    @router.get("/{project_id}/files")
    async def files(project_id: str):
        project = await repo.get(project_id)
        return await workspace.list_files(project_id, project["revision"])

    @router.get("/{project_id}/file")
    async def file(project_id: str, path: str):
        if path not in await files(project_id):
            raise BadRequest("文件不属于当前项目版本。")
        return {"path": path, "content": await workspace.read_text(project_id, path)}

    async def assert_release(project_id: str, release_id: str):
        if release_id not in (await repo.get(project_id))["releaseIds"]:
            raise BadRequest("游戏版本不属于当前项目。")

    @router.get("/{project_id}/releases/{release_id}/game")
    async def game(project_id: str, release_id: str):
        await assert_release(project_id, release_id)
        return await workspace.read_json(project_id, f"/releases/{release_id}/game.json")

    @router.get("/{project_id}/releases/{release_id}/play")
    async def play(project_id: str, release_id: str):
        await assert_release(project_id, release_id)
        return HTMLResponse(await workspace.read_text(project_id, f"/releases/{release_id}/index.html"))

    @router.get("/{project_id}/releases/{release_id}/download")
    async def download(project_id: str, release_id: str):
        await assert_release(project_id, release_id)
        return HTMLResponse(await workspace.read_text(project_id, f"/releases/{release_id}/index.html"),
                            headers={"Content-Disposition": f'attachment; filename="story-game-{release_id}.html"'})

    return router
