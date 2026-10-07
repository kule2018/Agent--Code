# Excel 与 CSV 解析

把课程销售明细读成明确类型的数据，生成概览与问题清单，保存到本地 DuckDB。全程不调用模型，不需要 API Key、`.env` 或 Docker。

## 运行

使用 Node.js 22 或更高版本，在本目录执行：

```bash
npm ci
npm run inspect
npm run xlsx
npm run csv
npm run issues
npm test
```

- `inspect`：预览正常 Excel 的三个工作表及前四行。
- `xlsx`：指定“销售明细”、第三行表头；6 条明细全部通过本例规则。
- `csv`：导入相同明细的 CSV，字段值与 Excel 一致。
- `issues`：导入故意构造的问题表；10 条明细、5 条问题、5 行通过校验，状态为 `needs_review`。
- `test`：验证格式、类型、异常提示、数据库保存与版本复用。

如安装时出现原生依赖不匹配，请使用受 DuckDB 支持的系统与 Node.js 版本，在当前机器执行 `npm ci`，不要复制其他系统的 `node_modules`。

## 文件职责

- `import-data.js`：命令入口 `main()`、数据库写入、版本保存和结果打印。
- `table-parser.js`：文件读取、工作表选择、字段转换、问题检查与概览。
- `samples/`：两份 Excel 和一份 CSV，均为课程模拟数据，与上一节看板金额无关。
- `table-import.test.js`：离线测试，不发送模型请求。

自定义输入仍须符合本节固定的销售表头与字段规则：

```bash
node import-data.js import samples/sales-clean.xlsx --sheet 销售明细 --header-row 3
node import-data.js import samples/sales-clean.csv --dataset-id sales-october
```

CSV 默认逗号分隔；分号用 `--delimiter ';'`，制表符用 `--delimiter tab`。`inspect` 的 CSV 预览仅使用默认逗号分隔。

## 数据与产物

每行是一笔订单商品明细，`line_id` 应唯一，`order_id` 可以重复。金额单位统一为人民币元，实付金额尚未扣除单列的退款金额。编号以文本保存，日期整理为 `YYYY-MM-DD`，金额以十进制文本绑定到 `DECIMAL(18,2)`。

产物位置：`outputs/<datasetId>/<完整版本Hash>/`。

- `source.xlsx` 或 `source.csv`：原文件的字节副本。
- `data.duckdb`：本地数据库。`sales_raw` 保存原始明细单元格；`sales` 保存所有整理结果及 `is_valid`；`import_issues` 保存问题位置与原因。
- `profile.json`：来源、版本、字段规则、行数、合法日期范围及三条样例。
- `issues.json`：全部问题列表。

同一文件和导入规则生成同一版本，重复执行会复用。内容或导入配置变化后生成独立目录；这是文件版本标识，不是业务上的自动去重。解析策略改变时需要同步调整 `PARSER_VERSION`。

有问题的数据仍会保存，以便核对。无法转换的字段在 `sales` 中为 `null`，原值留在 `sales_raw`；重复明细的所有相关行均会标记，不自动删除。整行空白会跳过并统计。

`ready` 只代表通过本例约定的检查；`needs_review` 代表需要核对。后续分析入口应先检查状态，不可简单筛掉无效行后就声称得到了完整销售统计。本例没有开放查询服务。

## 支持范围

仅处理小型、可信的本地 `.xlsx` 与 UTF-8 CSV：文件不超过 5 MiB、数据最多 10000 条、Excel 最多 50 列。只支持单行表头；表头及数据区域的合并单元格会被拒绝。对编号、日期、金额、必需空值、重复明细和退款超额进行检查；不保证发现所有业务错误。

公式及数组公式单元格需要先核实、重新计算并导出纯值副本，本例不自动采用公式缓存。旧 `.xls`、多级表头、GBK CSV 和复杂报表需先转换。空备注允许保留；空金额不能当作 0。

本例使用内存解析与逐行入库，适合课堂验证。真实上传服务还需要身份权限、隔离存储、解压/内存/耗时限制和批量导入策略；文件大小检查不等于完整的恶意文件防护。

## 依赖依据

核验日期：2026-10-07。

- [SheetJS Node.js 安装](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)：锁定官方 CDN 的 `xlsx 0.20.3`，不用 npm 公共仓库里的旧版同名包。
- [SheetJS 单元格](https://docs.sheetjs.com/docs/csf/cell/)、[日期](https://docs.sheetjs.com/docs/csf/features/dates/)、[公式](https://docs.sheetjs.com/docs/csf/features/formulae/)。
- [csv-parse 参数](https://csv.js.org/parse/options/)：锁定 `7.0.3`，保留字符串并正确解析引号、逗号和换行。
- [DuckDB Node.js Neo](https://duckdb.org/docs/current/clients/node_neo/overview)：锁定 `@duckdb/node-api 1.5.6-r.1`，文件数据库与参数绑定。
