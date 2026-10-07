# Text-to-SQL 课程案例

把销售问题转换为 DuckDB SQL，打印口径、SQL、真实结果和回答。只使用本地课程样本，不连接生产数据库。

## 运行

使用 Node.js 22 或以上版本，在本目录执行：

```bash
npm ci
npm run prepare-data
npm run demo -- regions
```

`prepare-data` 会导入相邻 `03-table-import/samples/sales-clean.xlsx`，复用 03 的解析与保存方法。请保留两个目录的相对位置；03 尚未安装依赖时，先运行 `npm --prefix ../03-table-import ci`。本节文件保存到自己的 `data/`，不改写 03 的代码和输出。

## 两种模式

- `demo`：Replay 使用预设问题与 SQL，真正执行 DuckDB；不调用模型，不需要密钥，不能用来衡量模型生成 SQL 的能力。
- `ask`：DeepSeek 根据问题与真实 Schema 生成 SQL，查询成功后根据结果回答。需要自行在本目录配置 `.env`：

```dotenv
DEEPSEEK_API_KEY=你的_API_Key
DEEPSEEK_MODEL=deepseek-flash
```

```bash
npm run ask -- "仅按已导入数据，2026 年 9 月哪个区域的未扣退款销售额最高？列出各区域金额。"
```

这会向 DeepSeek 发送问题、Schema、指标规则和必要的查询结果并产生费用。不会在默认提示中上传整个 Excel。查询若选择了明细字段，对应返回值也可能进入模型请求；敏感业务数据必须另行控制授权和脱敏。

## 离线验证

```bash
npm run demo -- compare
npm run demo -- products
npm run demo -- clarify
npm run demo -- coverage
npm run demo -- repair
npm run demo -- empty
npm test
```

| 场景 | 观察点 |
| --- | --- |
| regions | 9 月华东 1599.00 元、华南 798.00 元 |
| compare | 华东差额 -1200.50 元、环比 -42.88%；华南 -402.00 元、-33.5% |
| products | 咖啡机差额 -2400.50 元；保温杯 +798.00 元 |
| clarify | 必要条件不全时追问，不执行 SQL |
| coverage | 两个月数据不能证明连续两次月度下降 |
| repair | 第一次预设错误字段，真实数据库报错后第二次修正 |
| empty | 西北无记录，不能断言销售为零 |

所有金额只代表已导入样本，月份完整性未经核验。查询流程返回后，`outputs/` 保存 JSON 报告，包括数据版本、尝试过的 SQL、结果与解释；密钥缺失或模型决策请求失败等前置错误在终端提示。金额和大整数以字符串输出，保留精度。

## 文件

- `text-to-sql.js`：`main()` 与一次问答的主流程。
- `dataset.js`：复用导入，读取真实表结构，补充业务口径。
- `model.js`：DeepSeek 决策、JSON 校验、结果解释。
- `replay.js`：固定问题和 SQL，供离线教学对照。
- `query-runner.js`、`query-worker.js`：受限查询执行，下一节集中讲执行环境。
- `text-to-sql.test.js`：离线集成测试，不使用 API Key。

## 执行边界

执行器用 DuckDB 解析器检查单条简单 SELECT，只允许 `sales`、`products` 和明确的函数集合；数据库只读，禁止外部访问与扩展自动加载。子进程查询默认 5 秒，最多返回 100 行和 64 KiB；超过行数不再交给模型总结。CTE、子查询、窗口函数和 UNION 本节未开放。

查询语法或字段错误最多修正一次；权限拒绝、资源限制和超时直接停止。JSON 模式只能约束输出格式，SQL 成功也不能保证业务口径正确，需要对照问题、SQL 和结果。月度缺失保留 NULL，环比分母为零时不生成百分比。

独立进程和这些 DuckDB 设置不等于完整沙箱。此案例没有生产级操作系统隔离、租户权限系统或敏感列权限，不应直接开放给公网执行任意 SQL。部署这些限制是后续执行环境章节的主题。

## 常见问题

- 找不到 `current.json`：先运行 `npm run prepare-data`。
- 找不到 03 的依赖：确认两个项目相邻，并在 03 安装依赖。
- `.env` 不存在：`demo` 不需要它；`ask` 需要本节目录的 `.env`。
- `POLICY:`：查询超过当前课例支持范围，先简化为分组、筛选或两表 JOIN。
- 401 / 429 / 网络错误：检查 DeepSeek 账户、配额和连通性，不要无限重试。
- AI 输出与 Replay 不同：检查 SQL 和口径是否等价；Replay 只保证演示路径固定。

官方资料（核验于 2026-10-07）：[LangChain SQL Agent](https://docs.langchain.com/oss/javascript/langchain/sql-agent)、[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[DuckDB SQL AST](https://duckdb.org/docs/current/data/json/sql_to_and_from_json)、[DuckDB 安全边界](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview)。
