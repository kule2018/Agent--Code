# 06 图表与分析依据（Python 版）

一个命令生成可离线打开的 HTML 报告：真实查询结果 → 柱状图 → 区域明细 → 本次 Excel 副本。本例使用固定查询和固定绘图配置，不调用模型、不需要 API Key。

## 运行

前置：Python 3.11+、uv、正在运行的本机 Docker（Linux 容器）。保留 **Python** 03、04、05、06 的相邻目录关系，沿用 Python 04 的数据和 Python 05 的镜像。

已经完成前置准备时，在本节目录执行：

```bash
uv sync --locked
uv run python chart_report.py
```

首次运行，先准备数据和 Python 镜像，再回到本节：

```bash
cd ../04-text-to-sql
uv sync --locked
uv run python text_to_sql.py prepare
cd ../05-restricted-execution
uv sync --locked
uv run python build_image.py
cd ../06-chart-evidence
uv sync --locked
uv run python chart_report.py
```

默认结果为华东 **1599.00 元**、华南 **798.00 元**，共 3 条依据明细。打开终端打印的 `outputs/<报告 ID>/report.html`，点击结果表的“查看明细”，可核对华东 Excel 第 7、9 行：`1200.00 + 399.00 = 1599.00`。

## 演示与验证

```bash
uv run python chart_report.py --month 2026-08
uv run python chart_report.py --region 华东
uv run python chart_report.py --region 西北
uv run python chart_report.py --y profit
```

8 月为华东 2799.50 元、华南 1200.00 元；华东筛选保留 2 条明细。西北没有记录，不绘制零值柱状图，也不据此推断销售额为零。`profit` 不在允许字段内，查询之前就会拒绝。

无需 Docker 的离线测试：

```bash
uv run python -m unittest -v test_chart_report
```

这些测试使用临时课程数据、可信固定 SQL 和 Mock 容器协议，验证金额、Hash、四个文件产物、HTML 转义及失败清理，**不证明容器隔离已生效**。准备好 Python 05 镜像后，再验证真实容器到报告的链路：

```bash
uv run python -m unittest -v test_docker_chart_report
```

真实测试只清理本次生成的准确容器名，不操作其他服务；镜像缺失时明确失败。

## 文件与依赖

- `chart_report.py`：固定数据快照、生成汇总和明细 SQL、按整数分核对金额、保存报告。
- `report_view.py`：校验 `chartSpec` 和 `rows`，渲染静态 SVG、摘要、证据表和完整 HTML。
- `outputs/<报告 ID>/report.json`：问题、筛选条件、指标口径、SQL、结果、明细、版本、Hash 和两次容器执行记录。
- 同一目录的 `report.html`、`source.xlsx`、`data.duckdb`：可视化报告、当时的原文件和查询快照。保留整个目录，下载链接才可用。

Python 版用标准库生成内嵌 SVG，不依赖 ECharts 的 Node 运行时、浏览器脚本或外部 CDN；保持原例的 `type / x / y` 和 `dataset / encode` 映射、数据、颜色与报告布局，SVG 绘制细节不要求与 ECharts 字节一致。唯一允许的配置是 `bar`、`x=region`、`y=sales_amount`，金额只来自同一份 `rows`。DuckDB 1.5.6、openpyxl 3.1.5 已锁定，用于相邻 Python 小节的数据加载和测试，不需要 Node 依赖。

## 边界

只演示 `sales` 单表、按区域汇总实付金额。两条 SQL 共用筛选条件并使用同一个数据库快照，明细按 `source_row` 对应 Excel 行号；金额核对用整数分，最多绘制 20 个分类。超过 Python 05 的 100 行结果限制会拒绝，不静默采用前 100 行。失败删除本次半成品，不覆盖其他成功报告。

本例不实现通用 SQL 血缘，也不让模型生成任意前端代码。保留依据方便核对，不代表源数据必然正确或已实现防篡改审计；实际产品仍需鉴权、脱敏和适当的快照机制。本节不读写环境文件。Docker 或镜像不可用时不会回退到宿主执行 SQL；基础镜像下载超时需检查 Docker Hub 连通性，再重试 Python 05 的构建命令。
