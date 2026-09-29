# 05 - 多 Agent 协作（Python）

总导演通过 `task` 委派独立的剧情设计师：主 Agent 只协调和汇报，子 Agent 读取世界观与 Skill、生成并复核剧情大纲。双方共用本小节自己的 Workspace，但消息历史相互隔离。

`story_team.py` 是运行入口，负责配置两名 Agent、权限和交付检查；`agent_trace.py` 只记录实际模型输入与工具调用。`workspace/` 中的世界观、Skill 和模板与 Node 版内容一致，运行时不依赖 Node 目录。

离线验证（不调用模型）：

```bash
uv run python -m unittest discover -s tests
```

真实演示前，让当前进程取得 `DEEPSEEK_API_KEY`，可选设置 `DEEPSEEK_MODEL`（默认 `deepseek-v4-flash`），然后在本小节目录运行：

```bash
uv run python story_team.py
```

预期会看到总导演的 `task` 委派、子 Agent 的文件调用、主 Agent 的消息列表，以及 `workspace/game/branch-outline.md` 的最终内容。真实调用会产生费用；离线测试不会。依赖由 `pyproject.toml` 和 `uv.lock` 锁定，需要 Python 3.11 或更新版本。
