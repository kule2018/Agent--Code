# AI 互动剧情游戏制作 Agent（Python）

本项目对应第八章 07～10：用户给出制作要求，世界观设计师、剧情策划、场景编剧和审核者分别交付文件；用户批准大纲后继续制作，通过验收才发布可离线游玩的游戏。AI 模式使用真实 Deep Agents 委派；Replay 是明确标记的固定样本，不调用模型。

后端使用 **FastAPI、LangGraph、Deep Agents 与 PostgreSQL**。浏览器工作台保留 Vue 页面和剧情分支图，前端仍需 Node.js；制作流程、API、文件验收和发布构建均由 Python 实现。所有资源、依赖和运行文件都在本项目内。

## 安装与启动

需要 Python 3.11+、uv、Node.js 22+ 和 Docker。在本项目目录执行：

```bash
uv sync --locked
npm ci
docker compose --env-file /dev/null up -d --wait
npm run dev
```

打开 [http://localhost:5184](http://localhost:5184)。Python API 使用 `127.0.0.1:4312`，独立 PostgreSQL 使用 `127.0.0.1:5438`；Docker 容器与数据卷也单独命名，方便与 Node 版同时运行。启动时自动创建项目表和 Checkpoint 表。开发脚本先等待 API 就绪，再启动前端；30 秒内未就绪时查看后端日志和 `docker compose ps`。

Replay 不需要 API Key。AI 模式要求当前进程已有 `DEEPSEEK_API_KEY`；可选设置 `DEEPSEEK_MODEL`，默认 `deepseek-v4-flash`。Python 不自动加载环境文件；如果你已有可供 shell 加载的 `.env`，可先手动执行 `set -a`、`source .env`、`set +a`，再启动。AI 调用会产生费用，结果受模型输出影响。

`POSTGRES_URI` 可覆盖 Python 的默认连接 `postgresql://story_course:story_course@127.0.0.1:5438/story_agent`；`PORT` 可覆盖 API 端口，开发脚本会同步前端代理地址。当前项目是本地课程演示，没有云端用户鉴权。

## 可以怎样演示

1. 新建作品，选择 Replay“正常完成”，查看分支后批准 Outline v1；制作完成后试玩三个结局。
2. 在开场选择“领取维修授权卡”或“陪苏雅守住休眠舱”，观察控制室中“重启空气循环”的选项是否出现。
3. 下载独立 HTML，停止服务后仍可打开游玩，无需数据库或 API Key。
4. 新建 Replay“冲突与局部返工”。审核者指出外部救援冲突，只返工 `ending-02.json`，重新审核后发布。
5. 对待审核大纲提出“让结局的代价更明确”，生成 Outline v2；旧版本审批会被拒绝。
6. 已发布后选择一个场景，输入“让这里的气氛更紧张”，生成 Revision 2 和新 Release，旧 Release 保持原样。

Replay 只支持“失联太空站”的固定要求与有限修改。自定义创意使用 AI 模式。预设缺陷不能证明真实模型一定会出现同样的错误。

## 文件职责

```text
server/src/main.py              FastAPI、数据库与 Checkpoint 初始化
server/src/story_controller.py  项目 API、SSE 事件、文件与游戏下载
server/src/story_service.py     制作阶段、人工审批、任务验收和局部返工
server/src/agents.py            AI / Replay、角色委派和文件权限
server/src/contracts.py         JSON 契约、状态可达性与原文引用校验
server/src/workspace.py         独立工作区、候选文件与 Revision
server/src/repository.py        PostgreSQL 项目状态、版本更新与事件
server/src/builder.py           game.json、离线 HTML 和发布清单
server/skills/                 四类角色的创作方法
shared/                        Python 与浏览器的游戏选择规则
web/                           工作台、分支图与试玩页面
workspaces/{projectId}/         运行时的 Revision、Staging 与 Release
```

主线是“需求 → 世界与人物 → 分支大纲 → 人工批准 → 逐场景编写 → 审核与返工 → 发布”。角色写入候选目录，程序检查 Schema、批准分支和输入 Hash 后才提交；发布前再模拟每个可达状态。最多自动返工两轮，仍未通过则等待人工处理。

Python 版还把发布后的局部改写放进同一 Graph，保存修改要求与执行位置；改写失败后可重试当前 Revision。后台启动前也会检查项目是否已经取消。

## 验证与构建

```bash
uv run python -m unittest discover -s tests -v
npm run build
```

测试使用临时 Workspace、数据库替身和假模型，实际执行 LangGraph、Deep Agents 文件工具、HTTP API 与离线 HTML 脚本，不连接真实模型或 PostgreSQL。前端 Node.js 也用于验证下载游戏中的 JavaScript。

完整服务已运行后，可自行执行：

```bash
uv run python -m server.src.smoke
```

该命令会在本地数据库和 `workspaces/` 留下正常、冲突和大纲修改三份 Replay 项目，检查三个结局、一次局部返工、离线 HTML 及新旧 Release。`STORY_BASE_URL` 可指定实际 API 地址。

生产构建后可执行 `uv run python -m server.src.main`，在 [http://127.0.0.1:4312](http://127.0.0.1:4312) 同时访问构建页面和 API。Python 与前端依赖分别由 `uv.lock`、`package-lock.json` 锁定。
