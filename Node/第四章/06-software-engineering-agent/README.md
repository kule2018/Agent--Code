# 软件需求实现与测试修复 Agent

这是第四章的综合实战项目。Agent 会把一份小型 NestJS 代码库复制到独立工作区，然后根据自然语言需求读取代码、修改文件、运行测试、更新计划并生成最终报告。

项目提供两种执行方式：

- `AI`：通过 DeepSeek-V4-Flash 动态决定下一步 Action。模型负责需求理解和代码决策，Runtime 负责真正执行工具。
- `Replay`：使用可重复的预设轨迹，不需要 API Key，适合课程演示、测试和排错。

这不是一个可以修改任意仓库的 Cursor 克隆。它只处理三类受控任务，模型不能执行任意 Shell，也不能修改场景白名单以外的文件。

## 启动项目

需要 Node.js 20.19 或更高版本。

```bash
npm install
npm run dev
```

不配置模型密钥时，可以直接使用 Replay 模式。需要体验 AI 模式时，在项目根目录自行创建 `.env`：

```text
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
```

服务端会在启动时读取 `.env`。`DEEPSEEK_MODEL` 没有配置时，默认使用 `deepseek-v4-flash`。

启动以后访问：

```text
http://localhost:5178
```

后端 API 地址：

```text
http://localhost:4300/api
```

## 三组实验

1. **需求实现**：输入自然语言需求，为任务列表增加 `priority` 筛选。Agent 会读取代码、修改三个文件，再运行测试和类型检查。
2. **测试修复**：修复逾期时间边界。失败测试必须作为证据触发 Replan，任务计划会从 `Plan v1` 更新为 `Plan v2`。
3. **安全重构**：删除废弃文件。Agent 先检查引用，Runtime 在删除前暂停，通过 Human-in-the-Loop 获取用户确认。

## 关键目录

```text
server/src/agent/
├── agent-runtime.service.ts       # Agent 主循环、预算、终止和审批恢复
├── agent-provider.service.ts      # AI / Replay Provider 路由
├── deepseek-provider.service.ts   # DeepSeek 模型调用、有限重试与 JSON 决策解析
├── replay-provider.service.ts     # 可重复的离线决策轨迹
├── agent-context.service.ts       # 发送给模型的任务、计划和 Observation
├── decision-validator.service.ts  # 模型 Action 的工具、参数和文件边界校验
├── scenarios.ts                   # 三组任务、计划、白名单与 Replay 轨迹
├── tool-registry.service.ts       # 受限工具注册与调用
├── result-validator.service.ts    # Observation 结果校验
├── workspace.service.ts           # 隔离工作区、文件边界和 Diff
└── command.service.ts             # 测试、类型检查、Lint 和构建

fixtures/task-service/             # 每次 Agent Run 使用的初始代码库
workspaces/                         # 自动生成的独立运行工作区
web/src/                            # Agent 工作台前端
```

模型只会返回结构化决策。Agent 不能执行任意 Shell，也不能读取工作区以外的文件；测试文件不在可写白名单中；删除文件属于高风险工具，必须获得人工批准。

## 验证

```bash
npm run check
npm test
npm run build
```
