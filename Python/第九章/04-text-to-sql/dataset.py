"""数据准备与加载：复用 Python 03 的导入流程，本节独立保存数据版本。"""

import json
import re
import sys
from pathlib import Path

import duckdb


PROJECT_DIR = Path(__file__).resolve().parent
DATA_ROOT = PROJECT_DIR / "data"
IMPORT_DIR = PROJECT_DIR.parent / "03-table-import"
# 小节目录不是 Python 包；按文件位置导入相邻 Python 小节，不依赖执行时的 cwd。
sys.path.insert(0, str(IMPORT_DIR))
from table_parser import build_profile, normalize_rows, read_source, read_table  # noqa: E402
from import_data import save_dataset  # noqa: E402


RULES = [
    "未扣退款销售额 = SUM(paid_amount)，扣退款净额 = SUM(paid_amount - refund_amount)，金额单位为人民币元。",
    "订单数 = COUNT(DISTINCT order_id)，明细条数 = COUNT(*)。",
    "没有退款发生日期，净额仅按销售日期归属，不可解释为当月现金流或当月发生的退款。",
    "日期最小值和最大值不能证明月份完整。本样本只支持按已导入记录比较，不外推完整月度业绩。",
    "环比 = (本期 - 上期) / 上期 * 100；上期为 0 或缺失时返回 NULL。缺失月份不自动补零。",
    "判断连续两个月下降至少需要三个连续月份，本样本只有 2026 年 8、9 月。",
    "问题没有给出必要的指标、时间或比较基准时先追问；超出数据覆盖范围时说明缺口。",
]


def _products(workbook):
    """将商品页首行作为表头，保留原始值；商品编号唯一才能避免 JOIN 重复计数。"""
    sheet = workbook["Sheets"]["商品信息"]
    cells = {}
    for address, cell in sheet.items():
        match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*)", address)
        if match and "v" in cell:
            cells.setdefault(int(match[2]), {})[match[1]] = cell["v"]
    header = cells.get(min(cells), {}) if cells else {}
    products = [
        {label: row.get(column) for column, label in header.items()}
        for number, row in sorted(cells.items())
        if number > min(cells) and any(value is not None for value in row.values())
    ]
    ids = [row.get("商品编号") for row in products]
    if (not products
            or any(not isinstance(row.get(key), str) or not row[key].strip()
                   for row in products for key in ("商品编号", "商品名称", "品类"))
            or len(set(ids)) != len(ids)):
        raise ValueError("商品表必须包含唯一商品编号、商品名称和品类。")
    return products


def prepare_dataset(root=DATA_ROOT):
    """导入销售明细，再从同一工作簿补充商品表；全部成功才发布 current.json。"""
    root = Path(root)
    source = read_source(IMPORT_DIR / "samples" / "sales-clean.xlsx")
    table = read_table(source, sheet="销售明细", header_row=3, delimiter=",")
    normalized = normalize_rows(table)
    profile = build_profile(table, normalized)
    if profile["status"] != "ready":
        raise ValueError("销售数据需要核对，暂不开放查询。")
    saved = save_dataset(source, table, normalized, profile, output_root=root)
    products = _products(source["workbook"])

    connection = duckdb.connect(str(Path(saved["directory"]) / "data.duckdb"))
    try:
        connection.execute("BEGIN TRANSACTION")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS products "
            "(product_id VARCHAR PRIMARY KEY, product_name VARCHAR, category VARCHAR)"
        )
        connection.execute("DELETE FROM products")
        for row in products:
            connection.execute("INSERT INTO products VALUES (?, ?, ?)",
                               [row["商品编号"], row["商品名称"], row["品类"]])
        unmatched = connection.execute(
            "SELECT COUNT(*) FROM sales s LEFT JOIN products p "
            "ON s.product_id = p.product_id WHERE p.product_id IS NULL"
        ).fetchone()[0]
        if unmatched != 0:
            raise ValueError("存在没有对应商品的销售明细。")
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()
    root.mkdir(parents=True, exist_ok=True)
    (root / "current.json").write_text(
        json.dumps({"datasetId": saved["datasetId"], "version": saved["version"]},
                   ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return load_dataset(root)


def load_dataset(root=DATA_ROOT):
    """读取当前版本和真实 Schema；模型上下文不包含原始明细或数据库路径。"""
    root = Path(root)
    try:
        current = json.loads((root / "current.json").read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError("请先执行 uv run python text_to_sql.py prepare。") from error
    if (not isinstance(current, dict) or current.get("datasetId") != "sales-demo"
            or not isinstance(current.get("version"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", current["version"])):
        raise ValueError("当前数据版本配置无效。")
    directory = root / current["datasetId"] / current["version"]
    profile = json.loads((directory / "profile.json").read_text(encoding="utf-8"))
    if profile.get("status") != "ready" or profile.get("version") != current["version"]:
        raise ValueError("数据尚未通过检查或版本不一致。")

    database_path = directory / "data.duckdb"
    connection = duckdb.connect(str(database_path), read_only=True)
    try:
        # 查询前再次检查问题明细；不能静默丢弃无效记录后继续分析。
        invalid = connection.execute("SELECT COUNT(*) FROM sales WHERE is_valid IS NOT TRUE").fetchone()[0]
        if invalid != 0:
            raise ValueError("数据存在待核对明细，暂不开放查询。")
        schemas = {}
        for name in ("sales", "products"):
            schemas[name] = [
                {"name": row[1], "type": row[2]}
                for row in connection.execute(f"PRAGMA table_info('{name}')").fetchall()
            ]
        return {
            "databasePath": str(database_path),
            "context": {
                "datasetId": profile["datasetId"], "version": profile["version"],
                "rowCount": profile["rowCount"], "dateRange": profile["dateRange"],
                "schemas": schemas,
                "fields": [{"name": column["name"], "description": column["description"],
                            "label": column["header"]} for column in profile["columns"]],
                "grain": profile["grain"], "amountPolicy": profile["amountPolicy"],
                "relation": "sales.product_id 对应 products.product_id；商品编号唯一；product_name 为名称，category 为品类。",
                "rules": RULES.copy(),
            },
        }
    finally:
        connection.close()
