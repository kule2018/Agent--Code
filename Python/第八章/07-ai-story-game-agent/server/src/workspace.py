"""项目隔离、候选文件提交与 Revision 文件快照。"""

import json
import os
import re
import shutil
import stat
from pathlib import Path
from uuid import uuid4

from .contracts import CharactersSchema, OutlineSchema, ReviewSchema, SceneSchema, WorldSchema
from .errors import BadRequest, NotFound

APP_ROOT = Path(__file__).resolve().parents[2]
SKILL_NAMES = ("world-building", "branch-story-design", "scene-writing", "continuity-review")


def json_text(value: object, pretty: bool = True) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2 if pretty else None,
                      separators=None if pretty else (",", ":"), allow_nan=False)


class WorkspaceService:
    def __init__(self, root: Path | None = None) -> None:
        # 默认资源位置由本文件确定，启动目录改变也不会读取另一套课程代码。
        self.root = (root or APP_ROOT / "workspaces").resolve()

    def project_root(self, project_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f-]{36}", project_id):
            raise BadRequest("项目 ID 不合法。")
        return self.root / project_id

    def path(self, project_id: str, virtual_path: str) -> Path:
        if not isinstance(virtual_path, str) or not virtual_path.startswith("/") or "\\" in virtual_path or "\0" in virtual_path:
            raise BadRequest("文件路径不合法。")
        base = self.project_root(project_id)
        # abspath 先校验 ..；再逐级拒绝符号链接，防止经父目录逃出 Workspace。
        target = Path(os.path.abspath(base / virtual_path.lstrip("/")))
        if target == base or not target.is_relative_to(base):
            raise BadRequest("不能访问项目外的文件。")
        for candidate in [base, *reversed(target.parents), target]:
            if candidate.is_relative_to(base) and candidate.is_symlink():
                raise BadRequest("只允许访问项目内的普通文件与目录。")
        return target

    async def prepare(self, project_id: str, revision: int, brief: dict) -> None:
        for directory in (f"/revisions/{revision}/scenes", f"/revisions/{revision}/reviews",
                          "/staging", "/releases", "/contracts"):
            self.path(project_id, directory).mkdir(parents=True, exist_ok=True)
        # 明确复制四份公开 Skill，不扫描或复制环境文件。
        for name in SKILL_NAMES:
            await self.write_text(project_id, f"/skills/{name}/SKILL.md",
                                  (APP_ROOT / "server" / "skills" / name / "SKILL.md").read_text(encoding="utf-8"))
        for name, schema in (("world", WorldSchema), ("characters", CharactersSchema),
                             ("outline", OutlineSchema), ("scene", SceneSchema), ("review", ReviewSchema)):
            await self.write_json(project_id, f"/contracts/{name}.schema.json", schema.model_json_schema())
        await self.write_json(project_id, f"/revisions/{revision}/brief.json", brief)
        await self.write_text(project_id, f"/revisions/{revision}/brief.md",
                              f"# {brief['title']}\n\n题材：{brief['genre']}\n目标玩家：{brief['audience']}\n\n"
                              f"{brief['premise']}\n\n硬性规则：{brief['worldRules']}\n\n"
                              f"角色 {brief['characterCount']} 名，场景 {brief['sceneCount']} 个，其中结局 {brief['endingCount']} 个。\n")

    async def stage(self, project_id: str, task_id: str, names: list[str]) -> list[str]:
        self.path(project_id, f"/staging/{task_id}").mkdir(parents=True, exist_ok=True)
        return [f"/staging/{task_id}/{name}" for name in names]

    async def read_text(self, project_id: str, virtual_path: str) -> str:
        target = self.path(project_id, virtual_path)
        try:
            if not stat.S_ISREG(target.lstat().st_mode):
                raise BadRequest("只允许读取普通文件。")
            return target.read_text(encoding="utf-8")
        except FileNotFoundError as error:
            raise NotFound(f"没有找到文件：{virtual_path}") from error

    async def read_json(self, project_id: str, virtual_path: str) -> object:
        try:
            return json.loads(await self.read_text(project_id, virtual_path))
        except json.JSONDecodeError as error:
            raise BadRequest(f"文件不是合法 JSON：{virtual_path}") from error

    async def write_text(self, project_id: str, virtual_path: str, content: str) -> None:
        target = self.path(project_id, virtual_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f"{target.name}.{uuid4()}.tmp")
        with temporary.open("x", encoding="utf-8", newline="") as file:
            file.write(content)
        temporary.replace(target)

    async def write_json(self, project_id: str, virtual_path: str, value: object) -> None:
        await self.write_text(project_id, virtual_path, json_text(value))

    async def promote(self, project_id: str, staged: str, destination: str) -> None:
        # 只在应用完成 Schema、业务与输入 Hash 校验之后提交候选文件。
        await self.write_text(project_id, destination, await self.read_text(project_id, staged))

    async def copy_revision(self, project_id: str, old: int, new: int) -> None:
        # Revision 只包含本项目登记的 md / json 产物，不复制任何其他文件。
        for virtual in await self.list_files(project_id, old):
            destination = virtual.replace(f"/revisions/{old}/", f"/revisions/{new}/", 1)
            await self.promote(project_id, virtual, destination)

    async def list_files(self, project_id: str, revision: int) -> list[str]:
        root = self.path(project_id, f"/revisions/{revision}")
        results: list[str] = []
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink() and not name.startswith(".env")]
            for name in files:
                if name == ".env" or name.startswith(".env."):
                    continue
                target = Path(directory) / name
                if target.suffix in (".md", ".json") and not target.is_symlink():
                    results.append("/" + target.relative_to(self.project_root(project_id)).as_posix())
        return sorted(results)

    async def discard_stage(self, project_id: str, task_id: str) -> None:
        target = self.path(project_id, f"/staging/{task_id}")
        if target.exists():
            shutil.rmtree(target)
