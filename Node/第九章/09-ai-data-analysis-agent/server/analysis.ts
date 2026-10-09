import { randomUUID } from 'node:crypto'
import type { Chart, Dataset, Decision, Evidence, Metric, Report, Row, Spec } from '../shared/types.js'

export const metricName: Record<Metric, string> = { net: '净销售额', paid: '实付金额', refund: '退款金额' }
const metricSql: Record<Metric, string> = { net: 'paid_amount - refund_amount', paid: 'paid_amount', refund: 'refund_amount' }
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
export const amount = (value: unknown) => {
  const number = Number(value)
  if (value == null || !Number.isFinite(number)) throw new Error('查询金额为空或无效')
  return Math.round(number * 100) / 100
}
const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 按已确认口径生成标准查询，供演示和 AI 结果复核共用。 */
export function buildSql(spec: Spec) {
  const where = `sold_at >= DATE ${quote(spec.start)} AND sold_at <= DATE ${quote(spec.end)}${spec.region ? ` AND region = ${quote(spec.region)}` : ''}`
  const sum = `ROUND(SUM(${metricSql[spec.metric]}), 2) AS amount`
  if (spec.kind === 'summary') return `SELECT region, ${sum} FROM sales WHERE ${where} GROUP BY region ORDER BY region`
  if (spec.kind === 'contribution') return `SELECT strftime(sold_at, '%Y-%m') AS month, product_name AS product, ${sum} FROM sales WHERE ${where} GROUP BY month, product ORDER BY month, product`
  return `SELECT strftime(sold_at, '%Y-%m') AS month, region, ${sum} FROM sales WHERE ${where} GROUP BY month, region ORDER BY month, region`
}
export function monthSequence(start: string, end: string) {
  const result: string[] = []
  let year = Number(start.slice(0, 4)), month = Number(start.slice(5, 7))
  while (`${year}-${String(month).padStart(2, '0')}` <= end.slice(0, 7) && result.length < 120) {
    result.push(`${year}-${String(month).padStart(2, '0')}`)
    month++; if (month > 12) { year++; month = 1 }
  }
  if (`${year}-${String(month).padStart(2, '0')}` <= end.slice(0, 7)) throw new Error('本项目每次最多分析 120 个月，请缩小时间范围')
  return result
}

/** Replay 只识别公开演示问题，所有数字仍由数据库实际计算。 */
export function replayDecision(question: string, dataset: Dataset, previous: Spec | null): Decision {
  if (!dataset.start || !dataset.end) throw new Error('数据集缺少日期范围')
  const lastDate = new Date(`${dataset.end.slice(0, 7)}-01T00:00:00Z`)
  const spec: Spec = { kind: 'trend', metric: 'net', start: `${dataset.start.slice(0, 7)}-01`, end: new Date(Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth() + 1, 0)).toISOString().slice(0, 10), region: null, ...previous }
  if (/天气|预测|为什么.*不买|广告效果/.test(question)) return { route: 'insufficient', spec: null, sql: null, message: '当前销售表只能支持金额与商品变化的计算，无法证明购买意愿、广告效果或未来销量。请补充相应资料。' }
  if (!/区域|销售|净额|实付|退款|商品|降幅|趋势|华东|华南|华北/.test(question)) return { route: 'clarify', spec: null, sql: null, message: 'Replay 支持页面里的示例问题。自由提问请切换 AI 分析，或明确要统计的金额、时间和区域。' }
  if (/实付|不扣退款/.test(question)) spec.metric = 'paid'
  else if (/退款金额/.test(question)) spec.metric = 'refund'
  else if (/净销售|扣除退款/.test(question)) spec.metric = 'net'
  if (/全部区域|所有区域/.test(question)) spec.region = null
  else spec.region = dataset.regions.find(region => question.includes(region)) || spec.region
  const months = [...question.matchAll(/(?:(20\d{2})年)?(\d{1,2})月/g)]
  if (months.length) {
    const dates = months.map(match => [Number(match[1] || dataset.end!.slice(0, 4)), Number(match[2])])
    if (dates.some(([, month]) => month < 1 || month > 12)) throw new Error('月份无效')
    spec.start = `${dates[0][0]}-${String(dates[0][1]).padStart(2, '0')}-01`
    const last = dates.at(-1)!
    spec.end = new Date(Date.UTC(last[0], last[1], 0)).toISOString().slice(0, 10)
  }
  if (/商品|贡献/.test(question)) spec.kind = 'contribution'
  else if (/连续|下降/.test(question)) spec.kind = 'decline'
  else if (/按月|趋势/.test(question)) spec.kind = 'trend'
  else spec.kind = 'summary'
  if (spec.kind === 'contribution' && !spec.region) return { route: 'clarify', spec: null, sql: null, message: '要分解哪个区域的商品降幅？例如：只看华东，哪些商品贡献了主要降幅。' }
  return { route: 'query', spec, sql: buildSql(spec), message: '按问题确定口径后查询销售表' }
}

/** 从真实结果生成图表和可复算结论，不允许模型自行填写图表数值。 */
export function buildReport(question: string, mode: 'replay' | 'ai', evidence: Evidence): Report {
  const { spec, rows } = evidence
  const notes = ['金额单位为人民币元；净销售额 = 实付金额 - 退款金额。', '数据只能支持变化和贡献计算，不能单独证明经营原因。']
  let answer = '', table = rows, chart: Chart | null = null
  if (!rows.length) answer = '当前筛选条件没有查询到明细。请核对日期和区域；空结果不代表销售额为零。'
  else if (spec.kind === 'summary') {
    const total = rows.reduce((sum, row) => sum + amount(row.amount), 0)
    answer = `${spec.start} 至 ${spec.end}${spec.region ? `，${spec.region}` : ''}的${metricName[spec.metric]}合计 ${money(total)} 元。下表列出各区域的实际查询结果。`
    chart = { kind: 'bar', title: `区域${metricName[spec.metric]}`, categories: rows.map(r => String(r.region)), series: [{ name: metricName[spec.metric], values: rows.map(r => amount(r.amount)) }], unit: '元' }
  } else if (spec.kind === 'contribution') {
    const months = monthSequence(spec.start, spec.end)
    if (months.length < 2) answer = '商品降幅需要两个相邻月份的数据。请扩大日期范围。'
    else {
      const [before, after] = months.slice(-2)
      const products = [...new Set(rows.map(r => String(r.product)))].sort()
      const at = (product: string, month: string) => rows.find(r => r.product === product && r.month === month)
      if (products.some(product => !at(product, before) || !at(product, after))) {
        answer = `${before} 或 ${after} 缺少部分商品记录，无法把缺失值自动当成零。请核对商品明细后再计算降幅贡献。`
        notes.push('缺少记录的商品没有参与贡献计算。')
      } else {
        const differences = products.map(product => ({ 商品: product, 上月金额: amount(at(product, before)!.amount), 本月金额: amount(at(product, after)!.amount), 降幅金额: amount(at(product, before)!.amount) - amount(at(product, after)!.amount) }))
        const drop = amount(differences.reduce((n, item) => n + item.降幅金额, 0))
        table = differences.map(item => ({ ...item, 降幅金额: amount(item.降幅金额), '净降幅贡献(%)': drop > 0 ? Math.round(item.降幅金额 / drop * 10000) / 100 : null }))
        answer = drop > 0 ? `${spec.region}从 ${before} 到 ${after}的${metricName[spec.metric]}减少 ${money(drop)} 元。${table.map(r => `${r.商品}贡献 ${money(Number(r.降幅金额))} 元，占净降幅 ${r['净降幅贡献(%)']}%`).join('；')}。` : `${spec.region}从 ${before} 到 ${after}没有净下降，因此不计算降幅占比。`
        notes.push('使用最后两个相邻月份比较；增长商品可能出现负贡献，净降幅为零时不计算百分比。')
        chart = { kind: 'bar', title: `${before} → ${after} 商品降幅`, categories: products, series: [{ name: '降幅金额', values: table.map(r => Number(r.降幅金额)) }], unit: '元' }
      }
    }
  } else {
    const months = monthSequence(spec.start, spec.end)
    const regions = [...new Set(rows.map(r => String(r.region)))].sort()
    const series = regions.map(region => ({ name: region, values: months.map(month => { const row = rows.find(r => r.region === region && r.month === month); return row ? amount(row.amount) : null }) }))
    chart = { kind: 'line', title: `按月${metricName[spec.metric]}趋势`, categories: months, series, unit: '元' }
    const hasGap = series.some(s => s.values.some(v => v === null))
    if (hasGap) notes.push('有月份缺少记录，图表保留断点；缺失值未替换为零。')
    if (spec.kind === 'decline') {
      const last = months.slice(-3)
      const declining = months.length < 3 ? [] : series.filter(s => { const values = s.values.slice(-3); return values.every(v => v !== null) && values[0]! > values[1]! && values[1]! > values[2]! })
      answer = months.length < 3 ? '判断连续两个月下降至少需要三个相邻月份，请扩大时间范围。' : declining.length ? `在最后三个相邻月份 ${last.join('、')}中，${declining.map(s => `${s.name}连续两个月下降（${s.values.slice(-3).map(v => money(v!)).join(' → ')} 元）`).join('；')}。` : `在 ${last.join('、')}中，没有数据完整且连续两个月下降的区域。`
      notes.push('连续两个月下降 = 三个相邻月份的金额依次下降；不跨过缺失月份比较。')
    } else answer = `已按月统计${spec.region || '各区域'}的${metricName[spec.metric]}。图表和下方结果表来自同一次查询。`
  }
  return { id: randomUUID(), question, answer, mode, status: 'completed', evidence, table, chart, notes, createdAt: new Date().toISOString() }
}
