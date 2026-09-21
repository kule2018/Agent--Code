# 06 - AI 演示文稿制作 Agent（Python）

本节是第七章综合实战的独立 Python 版：资料与要求会先生成大纲、暂停等待人工审核，再逐页生成内容；支持失败页续做、单页 Revision、自然语言修改内容或视觉样式、版本校验与可编辑 PPTX 导出。

## 文件职责

- `app.py`：FastAPI API 与静态演示页面入口，默认地址为 `http://127.0.0.1:4310`。
- `presentation_aggregate.py`：审核、页面状态、版本、局部重做和导出条件等领域规则。
- `presentation_graph.py`：LangGraph 的暂停审核、恢复、页面队列和导出流程。
- `presentation_model.py`：Replay 规则与 DeepSeek 实际模型调用。
- `presentation_repository.py`：PostgreSQL JSONB 仓储；测试使用内存 Fake Repository。
- `presentation_exporter.py`：生成可编辑 `.pptx` 与讲者备注。
- `web/index.html`：由 FastAPI 托管的零构建静态演示页，不需要 Node/Vite。

## 离线验证

```bash
uv run --isolated python -m unittest discover -s tests
```

预期结果：Replay 模式下，第三页首次生成失败；续做后只补做这页。测试也会验证单页 Revision、主题修改、全局大纲版本更新和 PPTX 文件生成。

## 运行完整演示

先启动 PostgreSQL 并初始化业务表、LangGraph Checkpoint 表：

```bash
docker compose up -d --wait
uv run python -m scripts.setup_storage
uv run python -m scripts.doctor
uv run uvicorn app:app --reload --port 4310
```

随后访问 `http://127.0.0.1:4310`，选择 Replay 即可完成全部演示，不需要模型密钥。生成的 PPTX 默认保存到 `data/exports`。

## AI 模式

AI 模式从进程环境读取 `DEEPSEEK_API_KEY`，可选读取 `DEEPSEEK_MODEL`；PostgreSQL 地址可通过 `POSTGRES_URI` 指定。先加载你已有的环境变量后，再用 UI 选择 AI 模式。真实模型调用不会在离线测试中发生。

## 依赖

项目使用 FastAPI、LangGraph、PostgreSQL Checkpoint、psycopg 与 python-pptx；建议通过 [uv](https://docs.astral.sh/uv/) 安装和运行。
