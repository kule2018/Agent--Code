import * as echarts from 'echarts'

/** 本例只开放区域销售额柱状图；不接收任意 ECharts 配置、脚本或额外数值。 */
export function createChartOption(spec, rows) {
  if (!spec || Object.keys(spec).sort().join(',') !== 'type,x,y' ||
      spec.type !== 'bar' || spec.x !== 'region' || spec.y !== 'sales_amount') {
    throw new Error('图表配置无效：仅支持 bar，x=region，y=sales_amount。')
  }
  if (!Array.isArray(rows) || rows.length > 20 || rows.some((row) =>
    typeof row.region !== 'string' || !row.region || row.region.length > 40 ||
    typeof row.sales_amount !== 'string' || !/^\d+\.\d{2}$/.test(row.sales_amount) ||
    !Number.isFinite(Number(row.sales_amount)))) {
    throw new Error('图表数据无效，或分类超过 20 个，请缩小查询范围。')
  }
  return {
    animation: false,
    textStyle: { fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif', fontSize: 15 },
    grid: { left: 74, right: 24, top: 38, bottom: 38 },
    dataset: { dimensions: ['region', 'sales_amount'], source: rows },
    xAxis: { type: 'category', axisTick: { show: false }, axisLine: { lineStyle: { color: '#d5d9df' } }, axisLabel: { color: '#353c43' } },
    yAxis: { type: 'value', name: '元', min: 0, splitLine: { lineStyle: { color: '#edf0f2' } } },
    series: [{
      type: spec.type,
      encode: { x: spec.x, y: spec.y },
      barMaxWidth: 82,
      colorBy: 'data',
      label: { show: true, position: 'top', formatter: (item) => item.data.sales_amount, color: '#252c32', fontSize: 16 }
    }],
    color: ['#078578', '#dc9741', '#5681b3']
  }
}

const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]))

/** 结论直接使用结果表里的金额；本例不让模型另写数字或推测销售原因。 */
export function conclusion(rows) {
  if (!rows.length) return '当前筛选条件下没有记录，无法据此判断销售额为 0。'
  const highest = rows.reduce((max, row) => Number(row.sales_amount) > Number(max.sales_amount) ? row : max)
  const regions = rows.filter((row) => row.sales_amount === highest.sales_amount).map((row) => row.region).join('、')
  return rows.length === 1
    ? `本次已导入记录中，${highest.region}未扣退款销售额为 ${highest.sales_amount} 元。`
    : `本次已导入记录中，${regions}未扣退款销售额最高，为 ${highest.sales_amount} 元。`
}

/** 在 Node 中生成 SVG 和完整 HTML；双击报告即可查看，无需联网或启动 Web 服务。 */
export function renderReport(report) {
  let svg = ''
  if (report.rows.length) {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 300 })
    try {
      chart.setOption(createChartOption(report.chartSpec, report.rows))
      svg = chart.renderToSVGString()
    } finally {
      chart.dispose()
    }
  }
  const resultRows = report.rows.map((row, index) => `<tr><td>${escape(row.region)}</td><td class="number">${escape(row.sales_amount)}</td><td><a href="#evidence-${index}">查看明细</a></td></tr>`).join('')
  const evidence = report.rows.map((row, index) => {
    const details = report.details.filter((detail) => detail.region === row.region)
    const tableRows = details.map((detail) => `<tr><td>${detail.source_row}</td><td>${escape(detail.line_id)}</td><td>${escape(detail.sold_at)}</td><td class="number">${escape(detail.paid_amount)}</td></tr>`).join('')
    return `<details class="evidence" id="evidence-${index}" open>
      <summary>${escape(row.region)} <span>${escape(row.sales_amount)} 元 · ${details.length} 条明细</span></summary>
      <p class="muted">${escape(report.dataset.sourceFile)} / ${escape(report.dataset.sheet)}</p>
      <div class="table-scroll"><table><thead><tr><th>Excel 行号</th><th>明细编号</th><th>销售日期</th><th class="number">实付金额（元）</th></tr></thead><tbody>${tableRows}</tbody></table></div>
      <p class="equation">${details.map((detail) => escape(detail.paid_amount)).join(' + ')} = ${escape(row.sales_amount)} 元</p>
    </details>`
  }).join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(report.filters.month)} 区域销售分析</title>
<style>
:root{color-scheme:light;font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#252c32;background:#fff;font-size:15px;letter-spacing:0}
*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:36px 40px 60px}header{border-bottom:2px solid #252c32;padding-bottom:22px}.eyebrow{font-size:13px;color:#078578;margin:0 0 12px}h1{font-size:28px;line-height:1.4;margin:0 0 12px}h2{font-size:19px;margin:0 0 20px}p{line-height:1.8;margin:12px 0}.muted{color:#657078;font-size:13px}.scope{display:flex;flex-wrap:wrap;gap:8px 24px;color:#59636a;font-size:14px}.overview{display:grid;grid-template-columns:minmax(0,2fr) minmax(230px,1fr);gap:32px;padding-top:24px}section{padding:26px 0;border-bottom:1px solid #dfe4e7;min-width:0}.chart{aspect-ratio:8/3}.chart svg{display:block;width:100%;height:100%}.insight{border-left:3px solid #078578;padding-left:14px;margin-top:18px}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;background:#f5f7f8;color:#616a72;font-size:12px;font-weight:500}td,th{padding:13px 12px;border-bottom:1px solid #e7eaed;white-space:nowrap}.number{text-align:right;font-variant-numeric:tabular-nums}a{color:#007669;text-underline-offset:3px}summary{cursor:pointer;font-weight:600;padding:14px 0;line-height:1.6}summary span{font-weight:400;color:#657078;margin-left:12px}.evidence{padding:4px 0 16px;scroll-margin-top:16px}.evidence:target{outline:2px solid #078578;outline-offset:6px}.equation{font-variant-numeric:tabular-nums;color:#067365}.metadata{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px 20px;margin:16px 0;font-size:14px}.metadata dt{color:#657078}.metadata dd{margin:0;overflow-wrap:anywhere}pre{background:#f5f7f8;padding:18px;font-size:13px;line-height:1.7;overflow:auto}code{font-family:ui-monospace,monospace}.downloads{display:flex;gap:22px;flex-wrap:wrap;margin-top:22px}footer{margin-top:22px;font-size:12px;color:#77818a;overflow-wrap:anywhere}.empty{padding:50px 0;color:#657078}
@media(max-width:700px){main{padding:24px 18px 40px}h1{font-size:23px}.overview{grid-template-columns:1fr;gap:18px}.chart{min-height:200px;aspect-ratio:auto}.chart svg{height:auto;min-height:200px}summary span{display:block;margin-left:18px}.metadata{grid-template-columns:82px minmax(0,1fr);gap:10px}.scope{gap:8px 16px}}
@media print{main{padding:0}.downloads{display:none}details{break-inside:avoid}}
</style></head><body><main>
<header><p class="eyebrow">销售分析 / 查询结果与依据</p><h1>${escape(report.filters.month)} 区域销售分析</h1><div class="scope"><span>指标：未扣退款销售额</span><span>单位：人民币元</span><span>范围：${escape(report.filters.region ?? '全部区域')} · 已导入记录</span></div></header>
<section><h2>查询结果</h2><div class="overview"><div class="chart">${svg || '<p class="empty">当前筛选条件下没有记录。</p>'}</div><div class="table-scroll"><table><thead><tr><th>区域</th><th class="number">金额（元）</th><th>依据</th></tr></thead><tbody>${resultRows || '<tr><td colspan="3">无数据</td></tr>'}</tbody></table></div></div><p class="insight">${escape(conclusion(report.rows))}</p><p class="muted">统计销售日期在 ${escape(report.filters.start)}（含）至 ${escape(report.filters.end)}（不含）的已导入记录；实付金额直接求和，未扣退款，不代表完整月度业绩。</p></section>
<section><h2>金额依据</h2>${evidence || '<p class="muted">没有符合条件的明细，本报告不绘制零值柱状图。</p>'}</section>
<section><h2>查询与原始文件</h2><p>${escape(report.question)}</p><dl class="metadata"><dt>原始文件</dt><dd>${escape(report.dataset.sourceFile)}</dd><dt>工作表 / 表</dt><dd>${escape(report.dataset.sheet)} / ${escape(report.dataset.table)}</dd><dt>数据版本</dt><dd><code>${escape(report.dataset.version)}</code></dd><dt>指标计算</dt><dd><code>${escape(report.metric.expression)}</code>，${escape(report.metric.unit)}，未扣退款</dd></dl><details><summary>汇总 SQL</summary><pre><code>${escape(report.sql)}</code></pre></details><details><summary>明细 SQL</summary><pre><code>${escape(report.detailSql)}</code></pre></details><div class="downloads"><a href="source.xlsx" download>下载本次原文件</a><a href="report.json" download>下载完整依据 JSON</a></div></section>
<footer>报告编号 ${escape(report.reportId)} · ${escape(report.createdAt)}</footer>
</main></body></html>`
}
