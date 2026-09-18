# 05 - 部分成功、局部重做与版本校验（Python）

本节用 LangGraph 和 PostgreSQL Checkpoint 模拟演示文稿页面制作：首次生成故意让第三页失败，随后只补做未完成页面；也可以只重做某一页，或发布新版大纲后重新生成全部失效页面。

## 文件职责

- `workflow.py`：页面任务、产物、失败续做、局部重做和导出版本校验的工作流。
- `partial_generation.py`：连接 PostgreSQL 后，提供各个演示操作的命令行入口。
- `tests/test_partial_generation.py`：使用内存 Checkpoint 验证四种关键状态变化，无需数据库。
- `docker-compose.yml`：课程案例所需的 PostgreSQL 服务，端口为 `5435`。

## 离线验证

```bash
uv run --isolated python -m unittest discover -s tests
```

预期结果：4 个测试通过；其中首次运行保留 3 个成功产物，`page-3` 为 `failed`。

## 使用 PostgreSQL 连续演示

先启动 PostgreSQL：

```bash
docker compose up -d --wait
```

然后按顺序执行：

```bash
uv run python partial_generation.py reset
uv run python partial_generation.py start
uv run python partial_generation.py continue
uv run python partial_generation.py revise-page
uv run python partial_generation.py outline-v2
uv run python partial_generation.py export
uv run python partial_generation.py continue
uv run python partial_generation.py export
```

第一次 `export` 会因新版大纲下没有页面产物而被阻止；补做后再次 `export`，结果为 `exported`。默认连接本地 `5435` 端口，也可以通过 `POSTGRES_URI` 指定其他 PostgreSQL 地址。

## 依赖

项目使用 `langgraph`、`langgraph-checkpoint-postgres` 和 `psycopg`。建议使用 [uv](https://docs.astral.sh/uv/) 安装并运行。
