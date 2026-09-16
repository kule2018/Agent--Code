# Durable Execution（Python 版）

本节演示 LangGraph 工作流在执行失败后，如何通过 Checkpoint 恢复。

核心流程：

- 第一次运行时，流程执行到 `save_outline_draft` 节点并模拟故障。
- Checkpointer 已经保存前面完成的节点状态。
- 新进程读取同一个 `thread_id` 的 checkpoint，可以看到待恢复节点。
- 恢复执行时，只继续未完成的 `save_outline_draft`，不会从头重跑。

## 文件说明

- `workflow.py`：定义演示文稿制作工作流，是本节核心文件。
- `durable_workflow.py`：命令行演示入口，对应 `reset / start / status / resume` 四个动作。
- `docker-compose.yml`：本节独立 PostgreSQL 环境。
- `tests/test_durable_workflow.py`：使用 `MemorySaver` 做离线测试，不连接 PostgreSQL。

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

如果使用 `uv`，可以直接运行后面的 `uv run ...` 命令。

## 离线验证

```bash
python -m unittest discover -s tests -v
```

或者：

```bash
uv run python -m unittest discover -s tests -v
```

这组测试使用内存 Checkpointer，不需要 Docker，也不调用真实模型 API。

## PostgreSQL 演示

启动数据库：

```bash
docker compose up -d --wait
```

依次执行：

```bash
python durable_workflow.py reset
python durable_workflow.py start
python durable_workflow.py status
python durable_workflow.py resume
```

也可以用 `uv`：

```bash
uv run python durable_workflow.py reset
uv run python durable_workflow.py start
uv run python durable_workflow.py status
uv run python durable_workflow.py resume
```

程序会读取：

- `POSTGRES_URI`，未设置时默认使用 `postgresql://agent_course:agent_course@localhost:5433/agent_workflow`

如果你已有自己的环境变量文件，可以先手动加载：

```bash
set -a
source .env
set +a
```

关键预期结果：`status` 会显示 `next` 为 `save_outline_draft`；`resume` 后会看到 `draftSaved: true`，并且 `executionPath` 只追加 `save_outline_draft`，不会重复执行前两个节点。
