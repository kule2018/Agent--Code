import test from 'node:test'
import assert from 'node:assert/strict'
import { createQueries, cents, verifyEvidence } from './chart-report.js'
import { createChartOption, conclusion, renderReport } from './report-view.js'

const spec = { type: 'bar', x: 'region', y: 'sales_amount' }
const rows = [{ region: '华东', sales_amount: '1599.00' }]
const details = [
  { source_row: 7, line_id: '0004', sold_at: '2026-09-05', region: '华东', paid_amount: '1200.00' },
  { source_row: 9, line_id: '0006', sold_at: '2026-09-18', region: '华东', paid_amount: '399.00' }
]

test('汇总和明细使用同一时间与区域条件', () => {
  const query = createQueries('2026-12', '华东')
  assert.equal(query.filters.end, '2027-01-01')
  for (const sql of [query.summary, query.details]) {
    assert.match(sql, /sold_at >= DATE '2026-12-01'/)
    assert.match(sql, /sold_at < DATE '2027-01-01'/)
    assert.match(sql, /region = '华东'/)
  }
})

test('拒绝无效时间和自由 SQL 文本', () => {
  assert.throws(() => createQueries('2026-13'), /月份/)
  assert.throws(() => createQueries("2026-09'; DELETE FROM sales"), /月份/)
  assert.throws(() => createQueries('2026-09', "华东' OR true"), /区域/)
})

test('金额按分核对，浮点误差不影响 0.10 + 0.20', () => {
  assert.equal(cents('0.10') + cents('0.20'), cents('0.30'))
  assert.throws(() => cents('1.001'), /两位小数/)
  assert.throws(() => cents('9999999999999999.99'), /绘图范围/)
})

test('1599 元能由两条明细核对，空结果也可确认', () => {
  assert.doesNotThrow(() => verifyEvidence(rows, details))
  assert.doesNotThrow(() => verifyEvidence([], []))
})

test('不允许错误金额、缺失明细或重复记录成为依据', () => {
  assert.throws(() => verifyEvidence([{ region: '华东', sales_amount: '1600.00' }], details), /不一致/)
  assert.throws(() => verifyEvidence(rows, details.slice(0, 1)), /不一致/)
  assert.throws(() => verifyEvidence(rows, [...details, details[0]]), /重复明细/)
  assert.throws(() => verifyEvidence(rows, []), /区域不一致/)
})

test('图表使用同一个 rows，不接受配置附带的数值或错误字段', () => {
  const option = createChartOption(spec, rows)
  assert.equal(option.dataset.source, rows)
  assert.deepEqual(option.series[0].encode, { x: 'region', y: 'sales_amount' })
  assert.throws(() => createChartOption({ ...spec, y: 'profit' }, rows), /图表配置无效/)
  assert.throws(() => createChartOption({ ...spec, data: [9000] }, rows), /图表配置无效/)
  assert.throws(() => createChartOption(spec, [{ region: '华东', sales_amount: 'NaN' }]), /图表数据无效/)
})

test('空数据不被表述成零；并列第一同时列出', () => {
  assert.match(conclusion([]), /无法据此判断销售额为 0/)
  assert.match(conclusion([...rows, { region: '华南', sales_amount: '1599.00' }]), /华东、华南/)
})

const report = {
  reportId: 'test-report', createdAt: '2026-10-08T00:00:00Z', question: '核对销售额',
  filters: createQueries().filters,
  dataset: { sourceFile: 'sales-clean.xlsx', sheet: '销售明细', table: 'sales', version: 'a'.repeat(64) },
  metric: { expression: 'SUM(paid_amount)', unit: '元' },
  sql: createQueries().summary, detailSql: createQueries().details,
  chartSpec: spec, rows, details
}

test('导出包含实际图表、可查明细、SQL、版本与原文件入口', () => {
  const html = renderReport(report)
  assert.match(html, /<svg/)
  assert.match(html, /1200.00 \+ 399.00 = 1599.00/)
  assert.match(html, /href="#evidence-0"/)
  assert.match(html, /href="source.xlsx"/)
  assert.match(html, /SUM\(paid_amount\)/)
  assert.match(html, /a{64}/)
})

test('空报告不复用旧图，数据文本不能注入 HTML', () => {
  const empty = renderReport({ ...report, rows: [], details: [] })
  assert.doesNotMatch(empty, /<svg/)
  assert.match(empty, /没有记录/)
  const html = renderReport({ ...report, question: '<script>alert(1)</script>' })
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})
