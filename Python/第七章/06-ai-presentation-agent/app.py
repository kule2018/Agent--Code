"""FastAPI 入口：提供演示文稿 Agent API，并托管独立的静态演示页面。"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Iterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from langgraph.checkpoint.postgres import PostgresSaver

from presentation_exporter import PresentationExporter
from presentation_graph import PresentationGraphService
from presentation_model import PresentationModelService
from presentation_repository import PostgresPresentationRepository, get_postgres_uri
from presentation_service import PresentationService
from presentation_types import (
    ApplyChangeInput,
    CreatePresentationInput,
    ReviewOutlineInput,
    RevisePageInput,
)


PROJECT_ROOT = Path(__file__).resolve().parent
WEB_ROOT = PROJECT_ROOT / "web"


@asynccontextmanager
async def lifespan(app: FastAPI) -> Iterator[None]:
    """启动时建立仓储与 Checkpoint；关闭时释放 PostgreSQL 连接。"""

    repository = PostgresPresentationRepository(get_postgres_uri())
    repository.setup()
    with PostgresSaver.from_conn_string(get_postgres_uri()) as checkpointer:
        checkpointer.setup()
        models = PresentationModelService()
        graph = PresentationGraphService(
            repository=repository,
            models=models,
            exporter=PresentationExporter(),
            checkpointer=checkpointer,
        )
        app.state.presentation_service = PresentationService(repository, graph, models)
        yield
    repository.close()


app = FastAPI(title="AI 演示文稿制作 Agent", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(ValueError)
async def handle_business_error(_request: Request, error: ValueError) -> JSONResponse:
    """与 Node 版一致，把可预期的业务错误返回为可读的 400 消息。"""

    return JSONResponse(status_code=400, content={"message": str(error)})


def service(request: Request) -> PresentationService:
    return request.app.state.presentation_service


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True, "service": "ai-presentation-agent"}


@app.get("/api/presentations/meta")
def meta(request: Request) -> dict[str, object]:
    return service(request).get_meta()


@app.get("/api/presentations")
def list_presentations(request: Request) -> list[dict[str, object]]:
    return [item.model_dump(mode="json") for item in service(request).list()]


@app.get("/api/presentations/{presentation_id}")
def get_presentation(presentation_id: str, request: Request) -> dict[str, object]:
    return service(request).get(presentation_id).model_dump(mode="json")


@app.post("/api/presentations")
def create_presentation(input_data: CreatePresentationInput, request: Request) -> dict[str, object]:
    return service(request).create(input_data).model_dump(mode="json")


@app.post("/api/presentations/{presentation_id}/review")
def review_presentation(
    presentation_id: str,
    input_data: ReviewOutlineInput,
    request: Request,
) -> dict[str, object]:
    return service(request).review(presentation_id, input_data).model_dump(mode="json")


@app.post("/api/presentations/{presentation_id}/continue")
def continue_pages(presentation_id: str, request: Request) -> dict[str, object]:
    return service(request).continue_pages(presentation_id).model_dump(mode="json")


@app.post("/api/presentations/{presentation_id}/pages/{page_id}/revise")
def revise_page(
    presentation_id: str,
    page_id: str,
    input_data: RevisePageInput,
    request: Request,
) -> dict[str, object]:
    return service(request).revise_page(
        presentation_id,
        page_id,
        input_data.changeRequest,
    ).model_dump(mode="json")


@app.post("/api/presentations/{presentation_id}/changes")
def apply_change(
    presentation_id: str,
    input_data: ApplyChangeInput,
    request: Request,
) -> dict[str, object]:
    presentation, plan = service(request).apply_change(presentation_id, input_data)
    return {
        "presentation": presentation.model_dump(mode="json"),
        "plan": plan.model_dump(mode="json"),
    }


@app.post("/api/presentations/{presentation_id}/export")
def export_presentation(presentation_id: str, request: Request) -> dict[str, object]:
    return service(request).export(presentation_id).model_dump(mode="json")


@app.get("/api/presentations/{presentation_id}/download")
def download_presentation(presentation_id: str, request: Request) -> FileResponse:
    path, filename = service(request).get_download(presentation_id)
    return FileResponse(path, filename=filename)


app.mount("/static", StaticFiles(directory=WEB_ROOT), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB_ROOT / "index.html")
