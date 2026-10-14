# 04 失败分析 · Python 版

沿用 02 的订单样本、03 的工具与评分器，记录模型输入、工具结果、消息转换、评分响应与父子步骤。保留三个实验：故意转换错金额、原样传递修复、应用重复执行查询。

请保留相邻的 Python `02-evaluation-dataset`、`03-automatic-scoring`、`04-failure-analysis`。本节不读取另一语言目录，不启动 Web 服务，只使用 Python 标准库。

## 离线验证

Python 3.11+，在本目录执行：

```bash
uv sync --locked
PYTHONDONTWRITEBYTECODE=1 uv run --locked python -m unittest -v test_trace
```

测试使用本地 HTTP 模型替身与合成资料，无需真实 Key，不产生模型费用。测试中的答案、分数和 usage 是替身设定的数据，不能作为真实模型能力或成本结论。

## 调用真实模型

程序只读取当前进程的 `DEEPSEEK_API_KEY`，不自动打开环境文件。可选 `DEEPSEEK_BASE_URL` 默认 `https://api.deepseek.com`，`DEEPSEEK_MODEL` 默认 `deepseek-flash`，`JUDGE_MODEL` 默认沿用答题模型。

如果你已经有符合 Shell 语法的本节 `.env`，可自行加载：

```bash
set -a
source .env
set +a
```

也可以直接向当前进程注入变量；不需要创建、复制或修改任何环境模板。加载变量后执行：

```bash
uv run --locked python main.py wrong-unit
uv run --locked python main.py fixed
uv run --locked python main.py repeat
```

三个命令都会调用真实模型并产生费用；不传实验名默认运行 `wrong-unit`。每次请求超时 45 秒，不自动重试，Agent 最多 4 轮模型调用、6 次工具执行。

- `wrong-unit`：工具实际返回 **3500 元**，组装 Tool Message 时变成 **35 元**。
- `fixed`：工具返回值和交给模型的金额都保持 **3500 元**。
- `repeat`：模型只请求一次查询，应用主动执行两次；两个工具步骤保留相同 `toolCallId`。

这些是应用设置的实验条件；最终回答、评分和实际调用次数以本次记录为准，不伪造模型必定失败或通过。

## 查看保存的记录

`outputs/<实验名>-<traceId>.json` 保存独立历史，`outputs/latest.json` 保存最近一次内容。离线查看，不调用模型：

```bash
uv run --locked python inspect_trace.py
uv run --locked python inspect_trace.py outputs/某次实验记录.json
```

关键观察点：`get_order` 返回 3500；`build_tool_message` 的输入仍是 3500、输出变成 35；下一次 `agent.model.input.messages` 确实收到 35。修复实验再核对这三个位置的金额是否一致，并检查最终回答与评分。

`completed` 只表示函数正常返回，是否答对看 `evaluation`。HTTP 请求异常在模型步骤记录；被业务捕获的错误还会出现在 `run.error` 或评分结果中。父步骤耗时包含子步骤，不能再次累加。

Agent 与 Judge 的 Token 分别来自接口返回的 `usage`；缺失或不完整时总数保留 `null`，不按零费用理解。未配置模型价格与缓存计费规则，因此不估算费用。这是本地自定义 Trace，不是 LangSmith 导出格式，也不会上传。

## 文件职责

- `scoring.py`：明确引用相邻 Python 03 的模型配置、订单工具、数据读取与评分器。
- `traced_agent_service.py`：本节重点；工具执行记录、三种实验和 Tool Message 转换。
- `traced_model_service.py`：本节重点；实际请求正文、模型消息、完整性检查和 usage。
- `trace_service.py`：本节重点；快照、父子关系、异常、耗时；`ContextVar` 保留并发隔离。
- `report.py`：打印评分依据、执行步骤与用量，不自动声称已定位全部根因。
- `main.py`：组合服务、执行实验、保存独立历史及最新报告。
- `inspect_trace.py`：离线重读报告；名称避开标准库 `inspect`。
- `test_trace.py`：故障/修复对照、本地 HTTP、父子关系、异常及文件验证。

只记录本案例的合成业务数据和白名单请求正文，不保存认证头、客户端配置或 Key。真实用户场景还需脱敏、日志访问控制和保留策略；环境文件与 Git 忽略配置不属于本节复制或测试范围。

字段参考 [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)；Python 上下文隔离参考 [Context Variables](https://docs.python.org/3.11/library/contextvars.html)。
