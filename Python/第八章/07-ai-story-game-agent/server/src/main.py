"""FastAPI 入口：初始化 PostgreSQL / Checkpoint，再提供工作台 API。"""

import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from pydantic import ValidationError

from .agents import AgentExecutionService
from .builder import GameBuilderService
from .errors import StoryError
from .repository import ProjectRepository
from .story_controller import build_router
from .story_service import StoryService
from .workspace import APP_ROOT, WorkspaceService


def create_app(repo=None, workspace=None, checkpointer=None, agents=None) -> FastAPI:
    # 注入接口只用于离线测试；正常启动始终使用 PostgreSQL Repository / Saver。
    repo = repo if repo is not None else ProjectRepository()
    workspace = workspace if workspace is not None else WorkspaceService()
    checkpointer = checkpointer if checkpointer is not None else AsyncPostgresSaver(repo.pool)
    agents = agents if agents is not None else AgentExecutionService(workspace)
    stories = StoryService(repo, workspace, agents, GameBuilderService(workspace), checkpointer)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            await repo.setup()
            if hasattr(checkpointer, "setup"):
                await checkpointer.setup()
            await stories.start()
            print(f"Story API: http://127.0.0.1:{os.getenv('PORT', '4312')}")
            yield
        finally:
            await stories.close()
            await repo.close()

    app = FastAPI(title="剧情工坊 Python API", lifespan=lifespan)
    app.state.stories = stories
    app.state.repo = repo
    app.state.workspace = workspace
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5184", "http://127.0.0.1:5184"],
                       allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(StoryError)
    async def business_error(request, error):
        return JSONResponse({"statusCode": error.status_code, "message": str(error)}, status_code=error.status_code)

    async def validation_error(request, error):
        messages = [f"{'.'.join(str(item) for item in issue['loc'])}: {issue['msg']}" for issue in error.errors()]
        return JSONResponse({"statusCode": 400, "message": messages}, status_code=400)

    app.add_exception_handler(ValidationError, validation_error)
    app.add_exception_handler(RequestValidationError, validation_error)
    app.include_router(build_router(stories, repo, workspace))
    built_web = APP_ROOT / "dist" / "web"
    if built_web.is_dir():
        app.mount("/", StaticFiles(directory=built_web, html=True), name="web")
    return app


if __name__ == "__main__":
    uvicorn.run(create_app(), host="127.0.0.1", port=int(os.getenv("PORT", "4312")))
