"""普通代码构建离线游戏；AI 只交付 JSON，不生成可执行脚本。"""

import base64
import re
from hashlib import sha256
from html import escape
from uuid import uuid4

from .contracts import validate_game
from .project import now_iso
from .workspace import APP_ROOT, WorkspaceService, json_text


def digest(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


class GameBuilderService:
    def __init__(self, workspace: WorkspaceService) -> None:
        self.workspace = workspace

    async def release(self, project: dict, game: dict, sources: list[str]) -> dict:
        # 发布前验证每一个结局都存在真实可选路径，再生成独立 Release。
        paths = validate_game(game)
        release_id = str(uuid4())
        base = f"/releases/{release_id}"
        game_text = json_text(game)
        html = self.offline_html(game)
        await self.workspace.write_text(project["id"], f"{base}/game.json", game_text)
        await self.workspace.write_text(project["id"], f"{base}/index.html", html)
        hashes = {virtual: digest(await self.workspace.read_text(project["id"], virtual)) for virtual in sources}
        await self.workspace.write_json(project["id"], f"{base}/manifest.json", {
            "releaseId": release_id, "revision": project["revision"],
            "outlineVersion": project["approvedOutlineVersion"], "createdAt": now_iso(),
            "paths": paths, "sources": hashes, "gameHash": digest(game_text), "htmlHash": digest(html),
        })
        return {"id": release_id, "paths": paths}

    def offline_html(self, game: dict) -> str:
        # Python 直接嵌入经过维护的浏览器引擎，不依赖 Node 或在线打包服务。
        engine = (APP_ROOT / "shared" / "browser_engine.js").read_text(encoding="utf-8")
        image = (APP_ROOT / "web" / "public" / "station.jpg").read_bytes()
        background = "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")
        # 关闭 </script> 注入入口；正文显示全部使用 textContent。
        data = json_text(game, pretty=False).replace("<", "\\u003c").replace(">", "\\u003e")
        template = (APP_ROOT / "server" / "templates" / "game.html").read_text(encoding="utf-8")
        values = {"TITLE": escape(game["title"], quote=True), "BACKGROUND": background,
                  "ENGINE": engine, "GAME": data}
        # 一次替换模板标记，避免用户正文中的相同标记被当成模板再次处理。
        return re.sub(r"\{\{(TITLE|BACKGROUND|ENGINE|GAME)\}\}", lambda match: values[match[1]], template)
