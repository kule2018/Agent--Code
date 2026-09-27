# 04 - Agent Skills（Python）

同一个 Deep Agent 分别运行剧情设计和普通问答，观察它是否按需读取 Skill。剧情大纲保存到本小节自己的 `workspace/game/branch-outline.md`；世界观、Skill 和模板均为独立资源。

`skill_agent.py` 负责选任务、配置模型和 Workspace、暴露 Skill、限制文件写入、打印工具轨迹并核对剧情文件。`workspace/skills/branch-story-design/SKILL.md` 是技能正文，`references/outline-template.md` 是仅在需要时读取的模板。

离线验证（不调用模型）：

```bash
uv run python -m unittest discover -s tests
```

运行真实模型前，让当前进程取得 `DEEPSEEK_API_KEY`，可选设置 `DEEPSEEK_MODEL`（默认 `deepseek-v4-flash`），然后在本小节目录运行：

```bash
uv run python skill_agent.py story
uv run python skill_agent.py chat
```

`story` 应读取剧情 Skill、世界观和模板并生成大纲；`chat` 只回答算术题。以本轮工具调用记录为准，模型每次的具体调用顺序可能不同。重复执行 `story` 可以更新已有大纲，若只读取已有文件，程序会明确提示。依赖由 `pyproject.toml` 和 `uv.lock` 锁定，需要 Python 3.11 或更新版本。
