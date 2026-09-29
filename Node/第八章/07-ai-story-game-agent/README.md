# AI 互动剧情游戏制作 Agent

第八章 07～10 共用的项目。用户给出制作要求，项目组织世界观设计、大纲设计、场景编写与剧情审核，最终交付可以离线游玩的有限分支剧情游戏。

## 环境与启动

- Node.js 22 或更新版本，Docker Desktop / Docker Engine。
- 在**本项目目录**执行命令。运行路径用于定位 `server/skills`、`web/public` 和 `workspaces`。
- 本地演示默认使用 PostgreSQL `127.0.0.1:5437`。端口如被占用，可修改 `docker-compose.yml` 并通过 `POSTGRES_URI` 指向实际端口。

```bash
npm install
docker compose up -d --wait
npm run dev
```

打开 [http://localhost:5183](http://localhost:5183)。NestJS API 使用 `127.0.0.1:4311`，Vite 已代理 `/api`。第一次启动会自动创建项目表和 LangGraph Checkpoint 表，不需要额外的 setup 命令。

Replay 演示无需模型 Key。选择“正常完成”或“故障演示：冲突与局部返工”，两者都先暂停等待人工批准大纲。

AI 模式需要在本机配置环境变量，例如在本项目自己的 `.env` 中配置：

```text
DEEPSEEK_API_KEY=你的 API Key
DEEPSEEK_MODEL=deepseek-v4-flash
POSTGRES_URI=postgresql://story_course:story_course@127.0.0.1:5437/story_agent
```

项目不会自动创建、覆盖任何 `.env` 或 `.env.example` 文件。`POSTGRES_URI` 可省略并使用上面的本地默认值。AI 模式真实调用模型并产生费用，产物会受到模型输出影响；Replay 是固定样本，不会调用模型。当前项目没有云端用户鉴权，只适合本机课程演示，不应直接暴露到公网。

## 可以怎样演示

1. 新建作品，选择 Replay 正常完成，等待 Outline v1 出现并批准大纲。
2. 观察右侧任务事件和左侧真实文件。完成后打开“剧情分支”，再点“试玩”。开场选项会改变后续可用选项。
3. 下载独立 HTML 文件。断开网络或停止服务后仍可直接打开，游戏无需 API Key。
4. 再建一份 Replay 故障演示项目。Reviewer 会指出“外部救援”与世界规则冲突，只返工 `ending-02.json` 后重新审核发布。
5. 在已发布的作品中选择场景并输入“让这里的气氛更紧张”，可生成新 Revision 和 Release；旧 Release 不被覆盖。

Replay 只接受固定“失联太空站”制作要求。需要自定义创意、角色或剧情时使用 AI 模式。Replay 中的冲突是明确标注的预设教学样本，不能据此推断真实模型一定会犯同样的错误。

## 验证

```bash
npm run check
npm test
npm run build
npm run smoke
```

`npm run smoke` 需要已经运行中的 API；它会创建正常/冲突两份 Replay 项目，自动批准大纲，检查三个结局、一次局部返工、离线 HTML 及新旧 Release。测试会在本地 PostgreSQL 和 `workspaces/` 留下演示数据。

## 主要目录

```text
server/src/story.service.ts    LangGraph 阶段、人工审核、任务委派与返工
server/src/agents.ts           AI / Replay 两种角色执行方式
server/src/contracts.ts        JSON 契约、分支可达性和报告引用校验
server/src/workspace.ts        项目隔离文件目录与候选文件提交
server/src/builder.ts          game.json、离线 HTML 和发布清单
server/skills/                各专业角色的创作方法
shared/engine.ts              Web 与离线 HTML 共用的游戏选择规则
web/src/App.vue               项目工作台、分支图与试玩页面
workspaces/{projectId}/       运行时文件，已加入 .gitignore
```

项目状态与事件保存在 PostgreSQL，LangGraph Checkpoint 保存阶段执行位置；正文文件在独立 Workspace 中。应用程序决定下一阶段、写入范围及验收结果，AI 只负责被委派的创作任务。
