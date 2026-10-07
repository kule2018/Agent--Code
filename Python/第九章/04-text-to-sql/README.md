# Text-to-SQL（Python 版）

把销售问题转换为 DuckDB SQL，展示统计口径、SQL、真实结果和回答。只使用本地课程样本，不连接生产数据库。

## 运行

Python 3.11 或以上版本，在本目录执行：

```bash
uv sync --locked
uv run python text_to_sql.py prepare
uv run python text_to_sql.py demo regions
```

`prepare` 复用相邻 **Python** `03-table-import` 的解析与保存方法，导入其 `samples/sales-clean.xlsx`，并补充同一工作簿的商品信息。请保留两个目录的相对位置；依赖由本节安装，不需要再安装 03 的依赖。本节数据保存在自己的 `data/`，不改写 03 的源码和输出，也不依赖 Node 目录。

## 离线演示

```bash
uv run python text_to_sql.py demo compare
uv run python text_to_sql.py demo products
uv run python text_to_sql.py demo clarify
uv run python text_to_sql.py demo coverage
uv run python text_to_sql.py demo repair
uv run python text_to_sql.py demo empty
uv run python -m unittest -v
```

| 场景 | 观察点 |
| --- | --- |
| regions | 9 月华东 1599.00 元、华南 798.00 元 |
| compare | 华东差额 -1200.50 元、环比 -42.88%；华南 -402.00 元、-33.5% |
| products | 咖啡机差额 -2400.50 元；保温杯 +798.00 元，按变化绝对值排序 |
| clarify | 必要条件不全时追问，不执行 SQL |
| coverage | 两个月数据不足以判断连续两次月度下降 |
| repair | 第一次使用错误字段，真实数据库报错后第二次修正 |
| empty | 西北没有匹配记录，不据此断言销售为零 |

`demo` 是 Replay：问题与 SQL 预设，**数据库真实执行**，不调用模型、不需要密钥，不能用来衡量模型生成 SQL 的能力。所有金额仅代表已导入记录，日期覆盖范围不能证明月份完整。

## 真实 DeepSeek 调用

`ask` 使用标准库 HTTP 请求调用 DeepSeek，默认模型为 `deepseek-flash`；可通过进程环境变量 `DEEPSEEK_MODEL` 覆盖。必须先将 `DEEPSEEK_API_KEY` 加载到进程环境中。Python 不会自动读取环境文件。

如果你已经有合法的、本节使用的 `.env`，可在本目录手动加载后运行：

```bash
set -a
source .env
set +a
uv run python text_to_sql.py ask "仅按已导入数据，2026 年 9 月哪个区域的未扣退款销售额最高？列出各区域金额。"
```

以上加载方式要求文件符合 shell 赋值语法。也可以通过终端或开发环境直接注入变量。本项目不创建、复制或检查任何环境文件。

真实模式会发送问题、Schema、业务规则和必要查询结果，产生 API 费用。不会在默认提示中上传整个 Excel；如果查询选择了明细字段，对应返回值也可能发送给模型，敏感业务数据需要另行控制授权和脱敏。

## 文件职责

- `text_to_sql.py`：命令入口、一次问答流程和查询报告。
- `dataset.py`：复用导入、补充商品表、读取真实 Schema 与统计口径。
- `model.py`：DeepSeek 决策、JSON 字段校验、结果解释。
- `replay.py`：固定问题与 SQL，提供离线教学对照。
- `query_runner.py`：启动独立查询进程，控制超时、返回量和错误反馈。
- `query_worker.py`：检查 SQL AST，使用受限只读 DuckDB 连接执行查询。
- `test_text_to_sql.py`：本地数据库集成测试和模型请求 Mock，不使用真实密钥。

查询流程返回后，`outputs/` 保存 JSON 报告，包含数据版本、每次尝试的 SQL、真实结果和解释。金额与大整数以字符串输出，保留精度。密钥缺失、模型决策请求失败等前置错误直接在终端提示；模型解读失败则保留已成功查询的结果。

## 执行边界与常见问题

执行器使用 DuckDB 自己的解析器检查一条简单 SELECT，只允许 `sales`、`products` 和明确的函数集合；CTE、子查询、窗口函数、UNION 本节未开放。数据库只读，关闭外部访问和扩展自动加载。查询子进程不继承模型密钥，默认限制 5 秒、100 行、64 KiB；截断结果不会交给模型概括全部数据。

语法或字段错误最多修正一次；权限拒绝、资源限制和超时直接停止。缺失月份保留 NULL，环比分母为零时不生成百分比；SQL 能执行也不代表统计口径正确，要对照问题、SQL 和结果核对。

这些措施**不是完整操作系统沙箱**，没有生产级租户权限或敏感列权限，不能直接开放给公网执行任意 SQL。

- 找不到当前数据版本：先执行 `uv run python text_to_sql.py prepare`。
- 找不到导入模块或样本：确认同一 Python 章节下保留了 `03-table-import`。
- 提示缺少密钥：确认变量已加载到当前进程；离线 `demo` 不需要密钥。
- `POLICY:`：查询超过本节支持范围，简化为筛选、分组或两表 JOIN。
- 401 / 429 / 网络错误：检查账户、配额及连通性，不要无限重试。

依赖锁定为 DuckDB 1.5.6、openpyxl 3.1.5，其余使用 Python 标准库，不引入 Web 框架。参考：[DuckDB Python API](https://duckdb.org/docs/current/clients/python/overview)、[SQL AST](https://duckdb.org/docs/current/data/json/sql_to_and_from_json)、[执行安全边界](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview)、[DeepSeek 思考模式参数](https://api-docs.deepseek.com/guides/thinking_mode/)。
