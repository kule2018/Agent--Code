# 多 Agent 审核与局部返工

第八章 06 的独立教学案例。承接上一节的 `task` 委派，增加场景格式、规则检查、Reviewer 报告和局部返工。

## 运行

需要 Node.js 22+。在本目录执行 `npm install`，沿用前面小节的 `.env` 配置方式：

```dotenv
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
```

```bash
npm run demo
```

每次创建新的 `workspaces/run-随机字符/`，不会覆盖前面的运行。终端会输出真实路径。

- `game/scenes/`：实际接受检查和修改的三个场景文件。
- `contracts/`：由 Zod 定义生成的 JSON Schema，供 Agent 读取交付格式。
- `reviews/review-1.json`：第一次审核报告；返工后产生新的报告。
- `result.json`：最终状态、返工次数和实际修改文件。

初始场景是固定的缺陷样本，`ending-b.json` 故意违反“无外部救援”规则。Reviewer 的判断和场景修复真实调用 DeepSeek，没有 Replay。

## 观察顺序

结构检查通过 → 总导演委派审核者 → 读取问题报告 → 只授权问题文件 → 总导演委派编写者 → 核对变化范围 → 再检查、再审核。

全部检查通过才是 `ready`；最多返工两次，之后仍有问题则为 `needs_human_review`。该状态只是等待人工检查的标记，本例没有实现审批页面。

主流程在 `review-workflow.js` 的 `main()`，循环在 `workflow.js` 的 `runReviewLoop()`。`agents.js` 配置角色并通过总导演的 `task` 执行委派；`contracts.js` 保存数据格式和确定性检查。

## 无 API 的检查

```bash
npm run validate
npm run check
npm test
```

`validate` 只做结构检查，所以带有剧情冲突的样本也会通过。自动化测试使用固定的审核报告和修改结果检查控制流程，不代表真实模型每次都会作出相同判断。

## 范围

本例只自动修复已通过结构检查的场景正文。JSON/Schema 错误、引用不实、越权修改或接口异常会停止交付，保留工作区排查。模型审核不能保证零漏检；重要作品仍需人工抽查。

当前有限分支示例禁止循环。完整游戏若允许返回旧场景，需要重新定义状态与终止规则。版本并发控制、UI 和游戏构建留到完整项目。
