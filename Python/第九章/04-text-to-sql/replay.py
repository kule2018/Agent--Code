"""离线回放：问题和 SQL 预设，数据库真实执行，不模拟模型生成能力。"""

from copy import deepcopy


REGION_SQL = """SELECT region, SUM(paid_amount) AS sales_amount
FROM sales
WHERE sold_at >= DATE '2026-09-01'
  AND sold_at < DATE '2026-10-01'
GROUP BY region
ORDER BY sales_amount DESC"""
COMPARISON_SQL = """SELECT region,
  SUM(CASE WHEN sold_at < DATE '2026-09-01' THEN paid_amount END) AS august_amount,
  SUM(CASE WHEN sold_at >= DATE '2026-09-01' THEN paid_amount END) AS september_amount,
  september_amount - august_amount AS change_amount,
  ROUND((september_amount - august_amount) / NULLIF(august_amount, 0) * 100, 2) AS change_percent
FROM sales
WHERE sold_at >= DATE '2026-08-01' AND sold_at < DATE '2026-10-01'
GROUP BY region
ORDER BY change_amount ASC"""
PRODUCT_SQL = """SELECT p.product_name,
  SUM(CASE WHEN s.sold_at < DATE '2026-09-01' THEN s.paid_amount END) AS august_amount,
  SUM(CASE WHEN s.sold_at >= DATE '2026-09-01' THEN s.paid_amount END) AS september_amount,
  september_amount - august_amount AS change_amount,
  ABS(september_amount - august_amount) AS absolute_change
FROM sales AS s
JOIN products AS p ON s.product_id = p.product_id
WHERE s.sold_at >= DATE '2026-08-01' AND s.sold_at < DATE '2026-10-01'
GROUP BY p.product_id, p.product_name
ORDER BY absolute_change DESC"""


def _plan(sql, metric, scope):
    return {"action": "query", "sql": sql, "metric": metric, "scope": scope}


REGIONS = _plan(REGION_SQL, "未扣退款销售额，SUM(paid_amount)，人民币元", "已导入数据中的 2026 年 9 月")
SCENARIOS = {
    "regions": {
        "question": "仅按已导入数据，2026 年 9 月哪个区域的未扣退款销售额最高？列出各区域金额。",
        "decisions": [REGIONS],
    },
    "compare": {
        "question": "仅按已导入数据，比较 2026 年 9 月与 8 月各区域未扣退款销售额，列出差额和环比。",
        "decisions": [_plan(COMPARISON_SQL, "未扣退款销售额；差额 = 9 月 - 8 月；环比单位 %", "已导入数据中的 2026 年 8、9 月")],
    },
    "products": {
        "question": "仅按已导入数据，2026 年 9 月和 8 月相比，哪个商品未扣退款销售额变化最大？按差额绝对值排序，展示商品名称。",
        "decisions": [_plan(PRODUCT_SQL, "按未扣退款销售额的差额绝对值排序，人民币元", "已导入数据中的 2026 年 8、9 月")],
    },
    "clarify": {
        "question": "最近销售表现怎么样？",
        "decisions": [{"action": "clarify", "question": "你要比较哪个时间范围？销售额按未扣退款金额还是扣退款净额统计？是否需要和上一期比较？"}],
    },
    "coverage": {
        "question": "哪些区域连续两个月销售额下降？",
        "decisions": [{"action": "clarify", "question": "样本只有 2026 年 8、9 月。判断连续两次月度下降至少需要三个连续月份，请补充 7 月数据并确认退款口径；也可以先比较现有两个月。"}],
    },
    "repair": {
        "question": "仅按已导入数据，列出 2026 年 9 月各区域未扣退款销售额。",
        "decisions": [{**REGIONS, "sql": REGION_SQL.replace("SUM(paid_amount)", "SUM(sales_amount)")}, REGIONS],
    },
    "empty": {
        "question": "仅按已导入数据，2026 年 9 月西北区域未扣退款销售额是多少？",
        "decisions": [_plan(REGION_SQL.replace("GROUP BY region", "AND region = '西北'\nGROUP BY region"),
                            REGIONS["metric"], REGIONS["scope"])],
    },
}


class ReplayProvider:
    mode = "Replay / 预设 SQL，未调用模型"

    def __init__(self, scenario):
        self.scenario = scenario
        self.index = 0

    def decide(self, _question, _context, _previous_error=None):
        if self.index >= len(self.scenario["decisions"]):
            raise ValueError("演示决策已用完。")
        decision = self.scenario["decisions"][self.index]
        self.index += 1
        return deepcopy(decision)

    def explain(self, _question, _context, _decision, result):
        return f"Replay 不生成模型解读。上表为 DuckDB 实际返回的 {len(result['rows'])} 条结果，请按列名核对。"


def create_replay_provider(name):
    if name not in SCENARIOS:
        raise ValueError("未知演示名，可选：" + "、".join(SCENARIOS))
    return ReplayProvider(SCENARIOS[name])
