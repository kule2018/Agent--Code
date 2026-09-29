# 06 - 多 Agent 审核与局部返工（Python）

本节承接总导演的 `task` 委派：程序先检查三个场景的结构，再让审核者给出带原文引用的问题报告；若有明确冲突，只授权编写者修改问题文件，随后重新验收。最多返工两次，仍不通过则标记 `needs_human_review`。

`review_workflow.py` 是入口和独立工作区准备；`contracts.py` 定义场景与报告格式；`workflow.py` 控制审核—返工循环；`agents.py` 配置两种角色、文件权限和一次委派边界。`fixtures/` 是固定缺陷样本，每次运行都会复制到新的 `workspaces/run-*`，不会修改样本或旧结果。

无需 API 的结构检查和测试：

```bash
uv run python review_workflow.py validate
uv run python -m unittest discover -s tests
```

`validate` 只检查 JSON 与分支结构；样本中故意写入的“外部救援”属于语义冲突，因此结构检查仍应通过。真实演示前，让当前进程取得 `DEEPSEEK_API_KEY`，可选设置 `DEEPSEEK_MODEL`（默认 `deepseek-v4-flash`）：

```bash
uv run python review_workflow.py demo
```

`demo` 会调用真实模型并产生费用。最终查看终端显示的工作区路径，以及其中的 `reviews/` 和 `result.json`。依赖由 `pyproject.toml`、`uv.lock` 锁定，需要 Python 3.11 或更新版本。
