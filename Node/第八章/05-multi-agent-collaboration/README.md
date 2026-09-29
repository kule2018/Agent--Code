# 总导演委派剧情设计师

本例对应第八章 05。复用上一节的世界观和剧情 Skill，由总导演通过 Deep Agents 的 `task` 工具委派独立的剧情设计师。两个角色共用 Workspace，分别维护 messages。

## 运行

需要 Node.js 22 或更高版本。在本目录安装依赖：

```bash
npm install
```

沿用前面课程的 `.env` 配置方式，在本目录的 `.env` 中配置：

```dotenv
DEEPSEEK_API_KEY=你的 API Key
DEEPSEEK_MODEL=deepseek-v4-flash
```

```bash
npm run demo
```

真实调用模型，会产生费用；本例没有 Replay。重复运行会读取已有的大纲，模型可能复用或修改它。

## 观察什么

- `[story-director]` 调用 `task`，参数中指定 `plot-designer` 与完整任务。
- `[plot-designer]` 读取 Skill、世界观和模板，写入或复核大纲。
- `task` 返回剧情设计师的交付报告，总导演继续回答。
- 总导演的 messages 包含 task 的结果，子 Agent 内部读取文件的 ToolMessage 不会逐条并入其中。
- 最终文件实际保存在 `workspace/game/branch-outline.md`。

`story-team.js` 是执行入口；`trace.js` 只记录真实的模型输入和工具调用，不负责调度。

## 验证

```bash
npm run check
npm test
```

上述检查不调用模型。`npm run demo` 则实际验证委派、文件读取、交付文件及消息隔离。它不证明剧情完全正确，也没有实现下一节的 Reviewer 返工流程。

日志会展示任务和工具参数。不要把密钥或敏感业务资料放进这个教学 Workspace。
