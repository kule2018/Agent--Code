# 04-失败分析

本节沿用 02 的订单样本与 03 的查询工具、规则检查和 LLM-as-a-Judge，新增输入快照和步骤追踪。
请保留 `02-evaluation-dataset`、`03-automatic-scoring`、`04-failure-analysis` 三个相邻目录。
首次使用时分别在 03、04 执行 `npm install`，Node.js 要求 >= 22.20。

## 运行

在本目录自行创建 `.env`，填写和 03 相同的配置值。仓库不提供或写入密钥文件：

```dotenv
DEEPSEEK_API_KEY=你的_API_Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
JUDGE_MODEL=deepseek-flash
```

```bash
npm run demo
npm run fixed
```

两个命令都会实际调用答题模型与评分模型，产生 API 费用。

- `demo`：应用故意把已经以元存储的金额除以 100。A1024 实付 3500 元，工具查询正确，但发送给答题模型的数据变成 35 元。
- `fixed`：原样传递查询结果，其他样本要求和评分标准不变。
- `repeat`：附加实验，应用故意重复执行相同查询，用来区分模型重复决策与应用重复执行。
- `inspect`：重新打印本地记录，不调用模型。默认读取 `outputs/latest.json`；指定历史文件可执行 `npm run inspect -- outputs/<文件名>.json`。

最终措辞、评分与调用次数以本次记录为准。如果模型未查询、提前拒答、再次查询或评分有分歧，照样保留实际过程，不伪造固定失败。

## 怎样阅读记录

`outputs/<实验名称>-<traceId>.json` 为本次独立文件。`latest.json` 只指向最近一次内容，不覆盖独立历史文件。

先看 `evaluation` 的具体检查项与理由，再读 `spans`：

1. `agent.model.input.messages`：请求发送前保存的模型输入；`output.message` 为模型返回的消息。
2. `get_order`：模型提出的调用 ID、参数和实际执行结果。
3. `build_tool_message`：查询结果被整理成 Tool Message 的前后数据。
4. 下一次 `agent.model`：确认整理后的数据确实进入了模型请求。
5. `evaluation.run` 与 `judge.model`：评分输入、评分响应和最后结论。

`id` 和 `parentId` 连接步骤。这是本节自定义的本地 Trace 格式，不是 LangSmith 导出格式，也未上传到 LangSmith。
`status=completed` 表示这次函数调用正常返回，是否答对由 `evaluation` 决定。上游接口异常记录在对应模型步骤；被业务捕获的异常还会体现在 `run.error` 或评分结果中。

`durationMs` 是本地测得的等待时间，模型接口返回的 `usage` 才是 Token 统计来源。父步骤包含子步骤，不能再次累加；Agent 与 Judge 分别统计。缺失 usage 时显示 `null`，不能按零费用理解。没有配置服务价格与缓存计费规则，因此不估算金额。

## 验证

```bash
npm run check
npm test
```

测试使用本地 HTTP 模型替身，不读取 `.env`，不调用真实服务，不产生模型费用。覆盖金额转换、输入快照、父子关系、异常、未知 usage、真实 SDK 请求、评分分工、修复对照与重复工具执行。

代码只记录本案例的合成业务数据和白名单请求正文，不记录认证头、客户端配置与 API Key。用于真实用户时需要额外实施脱敏、访问控制和日志保留策略。

## 参考

- [LangSmith Trace 与 Run](https://docs.langchain.com/langsmith/observability-concepts)
- [评测最终回答、执行过程和单步行为](https://docs.langchain.com/langsmith/evaluate-complex-agent)
- [NestJS 独立应用](https://docs.nestjs.com/standalone-applications)
- [DeepSeek 请求与 usage 字段](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)

本节沿用 03 已锁定的依赖版本；文档核对日期为 2026-10-13。
