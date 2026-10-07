# Excel 与 CSV 解析（Python）

把课程销售明细读成明确类型的数据，生成概览与问题清单，保存到本地 DuckDB。全程离线，不需要模型、API Key、环境文件或 Docker。

## 运行

使用 Python 3.11 或更新版本，在本目录执行：

```bash
uv sync --locked
uv run python import_data.py inspect samples/sales-clean.xlsx
uv run python import_data.py import samples/sales-clean.xlsx --sheet 销售明细 --header-row 3
uv run python import_data.py import samples/sales-clean.csv
uv run python import_data.py import samples/sales-issues.xlsx --sheet 销售明细 --header-row 3
uv run python -m unittest -v
```

`inspect` 预览工作表与前四行，不执行保存。正常 Excel 和 CSV 均有 6 条明细、5 个不同订单，状态为 `ready`；问题 Excel 保留 10 条明细，报告 5 条问题、5 行通过校验，状态为 `needs_review`。

输入文件需要符合本节固定销售表头。CSV 默认逗号分隔；分号用 `--delimiter ';'`，制表符用 `--delimiter tab`。CSV 的 `inspect` 仅按默认逗号预览。可用 `--dataset-id sales-october` 指定数据集，默认 `sales-demo`。

## 文件职责

- `import_data.py`：命令入口、事务写入、版本发布与复用、结果打印。
- `table_parser.py`：文件读取、工作表选择、字段转换、质量检查与概览；保留中文教学注释。
- `samples/`：两份 Excel 和一份 CSV 的独立字节副本，均为人工构造的课程数据；不复制办公软件临时锁文件。
- `test_table_import.py`：离线解析、数据库保存、错误边界与失败清理测试。
- `pyproject.toml`、`uv.lock`：锁定 `openpyxl 3.1.5`、`duckdb 1.5.6`；CSV、Hash 和基础校验使用标准库。[openpyxl 读取说明](https://openpyxl.readthedocs.io/en/stable/tutorial.html#loading-from-a-file)、[DuckDB Python 接口](https://duckdb.org/docs/current/clients/python/dbapi)

## 数据与产物

产物位于本小节的 `outputs/<datasetId>/<完整版本Hash>/`，包含原文件副本 `source.xlsx` 或 `source.csv`、`data.duckdb`、`profile.json` 和 `issues.json`。同一文件与导入规则生成同一版本，重复运行会复用；修改内容或导入配置会生成独立版本。

数据库的 `sales_raw` 保留原始单元格，`sales` 保留所有整理结果与 `is_valid`，`import_issues` 保存原行、字段与问题原因。金额单位为人民币元，实付尚未扣退款；金额按十进制文本绑定到 `DECIMAL(18,2)`，正常样本实付合计为 `6396.50`、退款合计为 `299.00`。

编号保持文本与前导零；日期校验真实日历及 Excel 1900/1904 系统。原始日期序列值、格式、公式和缓存值留作追溯，公式及数组公式均不能参与业务计算。问题行与重复行不删除；转换失败字段为 `null`，原值仍在 `sales_raw`；完全空白行会跳过并计数。CSV 使用记录序号定位，不把单元格内换行误计为另一条记录。

仅支持可信、小型 `.xlsx` 与 UTF-8 CSV：文件非空且不超过 5 MiB、数据最多 10000 条、Excel 最多 50 列。单行表头必须明确，表头和数据区不能有合并单元格。预览覆盖课程样本的文本、日期和金额显示格式，不复现 Excel 的全部自定义格式。

`ready` 仅表示通过本例规则，不能证明业务数据真实完整；`needs_review` 必须先核对，不能直接过滤问题行后声称得到了完整统计。本节没有查询服务，也没有上传安全隔离机制。
