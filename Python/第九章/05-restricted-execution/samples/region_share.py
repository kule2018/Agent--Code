"""对已经汇总的区域金额计算占比，金额先转为整数分。"""


def analyze(rows):
    amounts = [int(row["sales_amount"].replace(".", "", 1)) for row in rows]
    total = sum(amounts)
    result = []
    for row, amount in zip(rows, amounts):
        # 百分比保留两位小数；只处理本例的非负、两位小数金额。
        # 整数计算与原示例 BigInt 一致，避免先转 float 再四舍五入。
        scaled = None if total == 0 else (amount * 10000 + total // 2) // total
        share = None if scaled is None else f"{scaled // 100}.{scaled % 100:02d}"
        result.append({"region": row["region"], "sales_amount": row["sales_amount"], "share_percent": share})
    return {"rows": result}
