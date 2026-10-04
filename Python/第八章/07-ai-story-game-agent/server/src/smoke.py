"""针对已运行 API 的 Replay 验证；运行后会留下项目和发布文件。"""

import asyncio
import os

import httpx

from .contracts import validate_game
from .replay import defect_quote, replay_brief


async def smoke(client: httpx.AsyncClient) -> None:
    async def api(path: str, body: dict | None = None):
        response = await (client.get(f"/api/projects{path}") if body is None else
                          client.post(f"/api/projects{path}", json=body))
        if not response.is_success:
            raise RuntimeError(response.text)
        return response.json()

    async def wait_for(project_id: str, state: str, outline_version: int | None = None):
        for _ in range(120):
            project = await api(f"/{project_id}")
            if project["status"] == state and (outline_version is None or project["outlineVersion"] == outline_version):
                return project
            if project["status"] == "failed":
                raise RuntimeError(project["failure"])
            await asyncio.sleep(0.25)
        raise TimeoutError(f"等待项目 {project_id} 超时。")

    for scenario in ("normal", "defect"):
        created = await api("", {**replay_brief, "replayScenario": scenario})
        project_id = created["id"]
        pending = await wait_for(project_id, "awaiting_outline_review")
        assert pending["outlineVersion"] == 1
        await api(f"/{project_id}/outline-review", {"outlineVersion": 1, "decision": "approve"})
        ready = await wait_for(project_id, "ready")
        release_path = f"/{project_id}/releases/{ready['latestReleaseId']}"
        game = await api(f"{release_path}/game")
        assert len(validate_game(game)) == 3
        assert ready["repairCount"] == (1 if scenario == "defect" else 0)
        assert not any(defect_quote in scene["content"] for scene in game["scenes"])
        download = await client.get(f"/api/projects{release_path}/download")
        assert download.status_code == 200
        assert "data:image/jpeg;base64," in download.text and "StoryEngine.startGame(game)" in download.text
        if scenario == "defect":
            events = await api(f"/{project_id}/events")
            assert any(event["kind"] == "repair_completed" for event in events)
            old_content = game["scenes"][0]["content"]
            await api(f"/{project_id}/revise-scene", {"sceneId": "scene-01", "instruction": "让这里的气氛更紧张"})
            revised = await wait_for(project_id, "ready")
            assert revised["revision"] == 2 and len(revised["releaseIds"]) == 2
            next_game = await api(f"/{project_id}/releases/{revised['latestReleaseId']}/game")
            old_game = await api(f"{release_path}/game")
            assert next_game["scenes"][0]["content"] != old_content
            assert old_game["scenes"][0]["content"] == old_content
            assert next_game["scenes"][1:] == game["scenes"][1:]
            validate_game(next_game)
        print(f"{scenario}: {project_id}，3 个结局，返工 {ready['repairCount']} 轮，Release {ready['latestReleaseId']}")

    created = await api("", dict(replay_brief))
    project_id = created["id"]
    first = await wait_for(project_id, "awaiting_outline_review")
    await api(f"/{project_id}/outline-review", {"outlineVersion": 1, "decision": "revise", "feedback": "让结局的代价更明确"})
    second = await wait_for(project_id, "awaiting_outline_review", 2)
    assert second["outline"]["scenes"][5]["summary"] != first["outline"]["scenes"][5]["summary"]
    stale = await client.post(f"/api/projects/{project_id}/outline-review", json={"outlineVersion": 1, "decision": "approve"})
    assert stale.status_code == 409 and "Outline v2" in stale.text
    await api(f"/{project_id}/outline-review", {"outlineVersion": 2, "decision": "approve"})
    assert (await wait_for(project_id, "ready"))["status"] == "ready"
    print(f"outline revision: {project_id}，旧版本审核被拒绝，Outline v2 发布成功")


async def main() -> None:
    async with httpx.AsyncClient(base_url=os.getenv("STORY_BASE_URL", "http://127.0.0.1:4312"), timeout=30) as client:
        await smoke(client)


if __name__ == "__main__":
    asyncio.run(main())
