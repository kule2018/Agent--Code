# 06 图表与分析依据

一个命令生成可离线打开的 HTML 报告：真实查询结果 → 柱状图 → 区域明细 → 本次 Excel 副本。

## 运行

使用 Node.js 22 或以上版本，保留 03、04、05、06 相邻目录。沿用 04 已准备的数据和 05 已构建的 Docker 镜像，启动 Docker Desktop。

```bash
npm ci
npm run demo
```

首次从本节开始，需要先在 03、04 安装各自依赖，在 04 执行 `npm run prepare-data`，在 05 执行 `npm run build:sandbox`。

打开终端打印的 `outputs/<报告 ID>/report.html`。报告无需 Web 服务或外部 CDN。本例使用固定查询与固定图表配置，不调用模型，不需要 `.env`。

## 验证

```bash
npm test
npm run demo -- --month 2026-08
npm run demo -- --region 华东
npm run demo -- --region 西北
npm run demo -- --y profit
```

默认数据应为华东 1599.00 元、华南 798.00 元。西北无数据；`profit` 不属于本例允许的字段，应拒绝生成报告。

## 文件

- `chart-report.js`：固定查询快照、生成汇总与明细查询、核对金额、保存依据。
- `report-view.js`：将真实结果映射到 ECharts，生成 HTML；摘要直接使用结果表中的金额。
- `outputs/<报告 ID>/report.json`：问题、统计条件、指标口径、SQL、汇总结果、明细、版本和执行记录。
- 同一报告目录的 `source.xlsx`、`data.duckdb`：原文件和查询数据库快照。保留整个目录，报告中的下载链接才可用。

## 边界

只演示 `sales` 单表、按区域汇总实付金额。汇总与明细共用筛选条件，明细通过 `source_row` 对应 Excel 行号；金额使用整数分核对。查询结果超过 05 的 100 行限制会拒绝，不静默采用前 100 行。

本例不实现通用 SQL 血缘分析，也不让模型生成任意 ECharts option 或前端代码。接入模型时，仅允许模型提出受限的绘图字段，数值和指标定义由执行结果与应用提供。报告保留证据以方便核对，不代表源数据必然正确或已经实现防篡改审计。报告包含业务明细，实际产品仍需鉴权和脱敏。
