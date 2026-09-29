"""准备独立缺陷样本，运行结构检查或真实审核—返工闭环。"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from langchain_deepseek import ChatDeepSeek

from agents import delegate_task
from contracts import ReviewSchema, SceneSchema, load_scenes, validate_scenes
from workflow import run_review_loop


ROOT = Path(__file__).resolve().parent
FIXTURES_DIR = ROOT / "fixtures"
WORKSPACES_ROOT = ROOT / "workspaces"
FIXTURE_FILES = (
    "game/world.md",
    "game/scenes/scene-01.json",
    "game/scenes/ending-a.json",
    "game/scenes/ending-b.json",
    "skills/story-quality/SKILL.md",
)


def prepare_workspace() -> Path:
    """每次新建工作区，只复制已知教学资源并生成供 Agent 读取的 Schema。"""

    WORKSPACES_ROOT.mkdir(parents=True, exist_ok=True)
    workspace_dir = Path(tempfile.mkdtemp(prefix="run-", dir=WORKSPACES_ROOT))
    # 显式复制公开样本，不扫描或复制环境文件，也不覆盖旧运行结果。
    for relative in FIXTURE_FILES:
        target = workspace_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(FIXTURES_DIR / relative, target)

    (workspace_dir / "reviews").mkdir()
    (workspace_dir / "contracts").mkdir()
    for name, schema in (("scene", SceneSchema), ("review", ReviewSchema)):
        (workspace_dir / "contracts" / f"{name}.schema.json").write_text(
            json.dumps(schema.model_json_schema(by_alias=True), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    return workspace_dir


async def run(mode: str = "demo") -> int:
    """demo 使用模型做语义审核；validate 仅检查本地结构。"""

    if mode not in ("demo", "validate"):
        raise ValueError("只支持 demo 和 validate。")
    if mode == "demo" and not os.getenv("DEEPSEEK_API_KEY"):
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先配置模型 API Key。")

    workspace_dir = prepare_workspace()
    print("本次工作区：", workspace_dir)
    print("教学样本：ending-b 的正文故意写入了“外部救援”，审核和修复由真实模型执行。")

    if mode == "validate":
        errors = validate_scenes(load_scenes(workspace_dir))
        print(errors or "结构检查通过。故事是否符合世界规则，还需要语义审核。")
        return 1 if errors else 0

    model = ChatDeepSeek(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        temperature=0,
        max_retries=1,
        timeout=120,
    )

    async def delegate(assignment: dict) -> None:
        await delegate_task(model, workspace_dir, assignment)

    # 同一个 10 分钟上限覆盖全部审核、返工与重新验收阶段。
    result = await asyncio.wait_for(
        run_review_loop(workspace_dir=workspace_dir, delegate=delegate),
        timeout=600,
    )
    print("结果记录：", workspace_dir / "result.json")
    return 0 if result["status"] == "ready" else 1


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "demo"
    try:
        code = asyncio.run(run(mode))
    except Exception as error:
        print("停止交付：", error, file=sys.stderr)
        raise SystemExit(1) from error
    raise SystemExit(code)


if __name__ == "__main__":
    main()
