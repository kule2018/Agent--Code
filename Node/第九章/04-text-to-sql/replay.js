export const regionSql = `SELECT region, SUM(paid_amount) AS sales_amount
FROM sales
WHERE sold_at >= DATE '2026-09-01'
  AND sold_at < DATE '2026-10-01'
GROUP BY region
ORDER BY sales_amount DESC`

export const comparisonSql = `SELECT region,
  SUM(CASE WHEN sold_at < DATE '2026-09-01' THEN paid_amount END) AS august_amount,
  SUM(CASE WHEN sold_at >= DATE '2026-09-01' THEN paid_amount END) AS september_amount,
  september_amount - august_amount AS change_amount,
  ROUND((september_amount - august_amount) / NULLIF(august_amount, 0) * 100, 2) AS change_percent
FROM sales
WHERE sold_at >= DATE '2026-08-01' AND sold_at < DATE '2026-10-01'
GROUP BY region
ORDER BY change_amount ASC`

export const productSql = `SELECT p.product_name,
  SUM(CASE WHEN s.sold_at < DATE '2026-09-01' THEN s.paid_amount END) AS august_amount,
  SUM(CASE WHEN s.sold_at >= DATE '2026-09-01' THEN s.paid_amount END) AS september_amount,
  september_amount - august_amount AS change_amount,
  ABS(september_amount - august_amount) AS absolute_change
FROM sales AS s
JOIN products AS p ON s.product_id = p.product_id
WHERE s.sold_at >= DATE '2026-08-01' AND s.sold_at < DATE '2026-10-01'
GROUP BY p.product_id, p.product_name
ORDER BY absolute_change DESC`

const plan = (sql, metric, scope) => ({ action: 'query', sql, metric, scope })
const regions = plan(regionSql, '未扣退款销售额，SUM(paid_amount)，人民币元', '已导入数据中的 2026 年 9 月')
export const scenarios = {
  regions: { question: '仅按已导入数据，2026 年 9 月哪个区域的未扣退款销售额最高？列出各区域金额。', decisions: [regions] },
  compare: { question: '仅按已导入数据，比较 2026 年 9 月与 8 月各区域未扣退款销售额，列出差额和环比。', decisions: [plan(comparisonSql, '未扣退款销售额；差额 = 9 月 - 8 月；环比单位 %', '已导入数据中的 2026 年 8、9 月')] },
  products: { question: '仅按已导入数据，2026 年 9 月和 8 月相比，哪个商品未扣退款销售额变化最大？按差额绝对值排序，展示商品名称。', decisions: [plan(productSql, '按未扣退款销售额的差额绝对值排序，人民币元', '已导入数据中的 2026 年 8、9 月')] },
  clarify: { question: '最近销售表现怎么样？', decisions: [{ action: 'clarify', question: '你要比较哪个时间范围？销售额按未扣退款金额还是扣退款净额统计？是否需要和上一期比较？' }] },
  coverage: { question: '哪些区域连续两个月销售额下降？', decisions: [{ action: 'clarify', question: '样本只有 2026 年 8、9 月。判断连续两次月度下降至少需要三个连续月份，请补充 7 月数据并确认退款口径；也可以先比较现有两个月。' }] },
  repair: { question: '仅按已导入数据，列出 2026 年 9 月各区域未扣退款销售额。', decisions: [{ ...regions, sql: regionSql.replace('SUM(paid_amount)', 'SUM(sales_amount)') }, regions] },
  empty: { question: '仅按已导入数据，2026 年 9 月西北区域未扣退款销售额是多少？', decisions: [plan(regionSql.replace('GROUP BY region', "AND region = '西北'\nGROUP BY region"), regions.metric, regions.scope)] }
}

/** SQL 决策预设，数据库真实执行；用于无 API Key 演示，不能当作模型能力测试。 */
export function createReplayProvider(name) {
  const scenario = scenarios[name]
  if (!scenario) throw new Error(`未知演示名，可选：${Object.keys(scenarios).join('、')}`)
  let index = 0
  return {
    mode: 'Replay / 预设 SQL，未调用模型',
    async decide() {
      const decision = scenario.decisions[index++]
      if (!decision) throw new Error('演示决策已用完。')
      return decision
    },
    async explain(_question, _context, _decision, result) {
      return `Replay 不生成模型解读。上表为 DuckDB 实际返回的 ${result.rows.length} 条结果，请按列名核对。`
    }
  }
}
