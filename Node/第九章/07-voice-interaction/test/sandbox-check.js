import assert from 'node:assert/strict'
import { analyze } from '../analysis.js'

// 这里只替换模型输出以固定测试条件；数据读取与 Docker 查询执行都使用真实实现。
const result = await analyze('2026 年 9 月各区域未扣退款销售额', {
  provider: {
    mode: 'integration-test',
    decide: async () => ({
      action: 'query',
      sql: "SELECT region, SUM(paid_amount) AS sales_amount FROM sales WHERE sold_at >= DATE '2026-09-01' AND sold_at < DATE '2026-10-01' GROUP BY region ORDER BY sales_amount DESC",
      metric: '实付金额合计，未扣退款，人民币元',
      scope: '2026 年 9 月已导入记录'
    }),
    explain: async (_question, _context, _decision, result) => `仅按已导入的 2026 年 9 月记录，${result.rows.map((row) => `${row.region}未扣退款销售额为 ${row.sales_amount} 元`).join('，')}。`
  }
})
assert.equal(result.status, 'answered')
assert.deepEqual(result.rows, [{ region: '华东', sales_amount: '1599.00' }, { region: '华南', sales_amount: '798.00' }])
assert.equal(result.speechText, result.answer)
console.table(result.rows)
console.log('真实数据与受限执行验证通过。此测试未调用 ASR、DeepSeek 或 TTS。')
