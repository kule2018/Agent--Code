"""查询子进程：DuckDB 原生解析器检查 SQL，受限只读连接实际执行查询。"""

import json
import math
import sys
from datetime import date, datetime, time
from decimal import Decimal

import duckdb

from model import utf16_length


FUNCTIONS = {"sum", "count", "count_star", "avg", "min", "max", "round", "abs",
             "coalesce", "nullif", "date_trunc", "strftime", "year", "month", "+", "-", "*", "/", "%"}
EXPRESSIONS = {"COLUMN_REF", "CONSTANT", "FUNCTION", "COMPARISON", "CONJUNCTION", "CAST", "CASE", "OPERATOR", "STAR"}
CONFIG = {
    "enable_external_access": "false", "autoinstall_known_extensions": "false",
    "autoload_known_extensions": "false", "allow_community_extensions": "false",
    "threads": "1", "memory_limit": "128MB", "max_temp_directory_size": "0B",
    "lock_configuration": "true",
}


def checked_sql(connection, sql):
    """仅开放简单 SELECT、聚合与两表 JOIN；不能用 SELECT 前缀或分号拆分代替解析。"""
    if not isinstance(sql, str) or not sql.strip() or utf16_length(sql) > 12000:
        raise ValueError("POLICY: SQL 为空或过长。")
    ast_text = connection.execute("SELECT json_serialize_sql(CAST(? AS VARCHAR))", [sql]).fetchone()[0]
    ast = json.loads(ast_text)
    if ast.get("error"):
        prefix = "SQL" if ast.get("error_type") == "parser" else "POLICY"
        raise ValueError(f"{prefix}: {ast['error_message']}")
    if len(ast["statements"]) != 1:
        raise ValueError("POLICY: 只允许一条查询。")
    root = ast["statements"][0]["node"]
    if root["type"] != "SELECT_NODE":
        raise ValueError("POLICY: 只允许 SELECT。")
    table_count = 0

    def visit(value):
        nonlocal table_count
        if isinstance(value, list):
            for child in value:
                visit(child)
            return
        if not isinstance(value, dict):
            return
        expression = value.get("class")
        if expression and expression not in EXPRESSIONS:
            raise ValueError(f"POLICY: 本课未开放表达式 {expression}。")
        if (value.get("cte_map", {}).get("map")
                or value.get("sample") is not None or value.get("qualify") is not None):
            raise ValueError("POLICY: 本课未开放 CTE、采样或 QUALIFY。")
        if expression == "FUNCTION" and (
                value.get("function_name") not in FUNCTIONS or value.get("schema")
                or value.get("catalog") or value.get("export_state")):
            raise ValueError(f"POLICY: 本课未开放函数 {value.get('function_name')}。")
        # 常量节点的 type 也可能是描述数据类型的对象，不是字符串。
        if value.get("type") in ("TABLE_FUNCTION", "SUBQUERY", "PIVOT"):
            raise ValueError("POLICY: 本课未开放表函数、子查询或 PIVOT。")
        if value.get("type") == "BASE_TABLE":
            if (value.get("table_name") not in {"sales", "products"} or value.get("catalog_name")
                    or value.get("schema_name") not in {"", "main"} or value.get("at_clause")):
                raise ValueError("POLICY: 只能读取当前数据集中的 sales、products。")
            table_count += 1
        for child in value.values():
            visit(child)

    visit(root)
    if table_count < 1 or table_count > 2:
        raise ValueError("POLICY: 查询需要读取一至两张业务表。")
    # 从通过检查的 AST 重新生成 SQL，安全处理尾部分号，不改写用户原字符串。
    return connection.execute("SELECT json_deserialize_sql(CAST(? AS JSON))", [ast_text]).fetchone()[0]


def _json_value(value, column_type):
    """Python DuckDB 返回原生类型；对齐课程 JSON 中金额和 64/128 位整数的字符串表示。"""
    if value is None:
        return None
    if isinstance(value, Decimal) or str(column_type) in {"BIGINT", "UBIGINT", "HUGEINT", "UHUGEINT", "BIGNUM"}:
        return str(value)
    if isinstance(value, (date, datetime, time)):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
    if isinstance(value, list) and column_type.id in {"list", "array"}:
        child_type = column_type.children[0][1]
        return [_json_value(child, child_type) for child in value]
    if isinstance(value, dict) and column_type.id == "struct":
        types = dict(column_type.children)
        return {key: _json_value(child, types[key]) for key, child in value.items()}
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _native_projection(name, column_type):
    """少数原生类型先在数据库内转换，避免 Python 丢失纳秒、时区或月份信息。"""
    field = '"' + name.replace('"', '""') + '"'
    kind = str(column_type)
    if kind.startswith(("TIMESTAMP", "TIME")) or kind in {"BLOB", "BIT"}:
        # 时区时间直接由 DuckDB 格式化，不额外依赖 pytz。
        return f"CAST({field} AS VARCHAR) AS {field}"
    if kind == "INTERVAL":
        # Python timedelta 会将月份按 30 天折算，不能据此恢复原始月份。
        return (f"CASE WHEN {field} IS NULL THEN NULL ELSE {{"
                f"'months': CAST(date_part('year', {field}) * 12 + date_part('month', {field}) AS INTEGER), "
                f"'days': CAST(date_part('day', {field}) AS INTEGER), "
                f"'micros': CAST(date_part('hour', {field}) * 3600000000 "
                f"+ date_part('minute', {field}) * 60000000 + date_part('microsecond', {field}) AS VARCHAR)"
                f"}} END AS {field}")
    return field


def run_read_only_query(database_path, sql, *, max_rows=100):
    """只打开应用提供的数据库，限制资源和外部访问；不是完整操作系统沙箱。"""
    connection = duckdb.connect(str(database_path), read_only=True, config=CONFIG)
    try:
        canonical = checked_sql(connection, sql)
        source = f"({canonical}) AS query_result LIMIT {max_rows + 1}"
        cursor = connection.execute(f"SELECT * FROM {source}")
        columns = cursor.description
        projections = [_native_projection(column[0], column[1]) for column in columns]
        if any(" AS " in projection for projection in projections):
            # 普通业务结果直接读取；特殊类型使用相同的只读查询和行数上限。
            cursor = connection.execute(f"SELECT {', '.join(projections)} FROM {source}")
            columns = cursor.description
        rows = [{column[0]: _json_value(value, column[1]) for column, value in zip(columns, row)}
                for row in cursor.fetchall()]
        return {"rows": rows[:max_rows], "truncated": len(rows) > max_rows}
    finally:
        connection.close()


def main():
    try:
        data = json.load(sys.stdin)
        result = run_read_only_query(data["databasePath"], data["sql"], max_rows=data.get("maxRows", 100))
        output = {"ok": True, **result}
    except Exception as error:
        # 只有语法/字段错误允许修正，权限或资源限制不能靠模型反复试探。
        message = str(error).encode("utf-16-le", errors="surrogatepass")[:3200].decode("utf-16-le", errors="surrogatepass")
        output = {"ok": False, "repairable": message.startswith(("SQL:", "Binder Error:", "Parser Error:")),
                  "message": message}
    sys.stdout.write(json.dumps(output, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
