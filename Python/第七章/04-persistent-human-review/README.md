# 04-persistent-human-review

这一节演示如何在 LangGraph 工作流中加入「人工审核」。

工作流会先生成一份演示文稿大纲，然后通过 `interrupt()` 暂停，把大纲交给用户审核。用户可以选择批准、要求修改或拒绝。因为状态会保存到 PostgreSQL，所以 `start`、`status`、`approve` 这些命令可以分多次运行。

## 文件说明

- `workflow.py`：定义大纲生成、人工审核、审核分支和版本校验逻辑。
- `review_workflow.py`：命令行入口，用 PostgreSQL 保存和恢复工作流状态。
- `tests/test_review_workflow.py`：使用内存 Checkpointer 验证批准、修改、拒绝和旧版本审核失败。
- `docker-compose.yml`：启动本节需要的 PostgreSQL。

## 离线验证

不需要启动 PostgreSQL，可以直接运行测试：

```bash
uv run python -m unittest discover -s tests
```

关键预期结果：

```text
Ran 4 tests
OK
```

## 持久化运行

先启动数据库：

```bash
docker compose up -d
```

然后按顺序执行：

```bash
uv run python review_workflow.py reset
uv run python review_workflow.py start
uv run python review_workflow.py status
uv run python review_workflow.py approve
```

如果想看修改后再次进入审核，可以把最后一步换成：

```bash
uv run python review_workflow.py revise
uv run python review_workflow.py status
```

本节默认使用：

```text
postgresql://agent_course:agent_course@localhost:5434/agent_review
```

如需连接自己的 PostgreSQL，可以在运行前设置 `POSTGRES_URI`。如果你已经有自己的环境变量文件，需要先在终端中自行加载，再执行上面的 Python 命令。
