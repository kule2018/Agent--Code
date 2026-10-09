import { createRequire } from 'node:module'
import type { Chart, Report, Row } from '../shared/types.js'

const echarts = createRequire(import.meta.url)('echarts')

export function chartOption(chart: Chart) {
  return { animation: false, color: ['#087f72', '#4384c5', '#b4782e'],
    grid: { left: 65, right: 24, top: 45, bottom: 48 }, tooltip: { trigger: 'axis' }, legend: { top: 0 },
    xAxis: { type: 'category', data: chart.categories, axisLine: { lineStyle: { color: '#b7c5cf' } } },
    yAxis: { type: 'value', name: chart.unit, splitLine: { lineStyle: { color: '#edf0f3' } } },
    series: chart.series.map(series => ({ name: series.name, type: chart.kind, data: series.values, connectNulls: false, smooth: false, barMaxWidth: 45, symbolSize: 7, lineStyle: { width: 3 } }))
  }
}
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
function tableHtml(rows: Row[]) {
  const keys = Object.keys(rows[0] || {})
  return `<table><thead><tr>${keys.map(k => `<th>${escapeHtml(k)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${keys.map(k => `<td>${escapeHtml(row[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
}

/** 将同一份结果、图表和 SQL 写进独立 HTML，离线打开也能核对依据。 */
export function reportHtml(report: Report) {
  let chart = ''
  if (report.chart) {
    const instance = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 900, height: 330 })
    instance.setOption(chartOption(report.chart))
    chart = instance.renderToSVGString()
    instance.dispose()
  }
  const evidence = report.evidence
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>销售分析报告</title><style>body{margin:40px auto;padding:0 24px;max-width:960px;font:15px/1.8 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#24333d}h1{font-size:26px}h2{font-size:18px;margin-top:32px}.meta{color:#6b7c88}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #dce3e8;text-align:left}pre{background:#f4f7f8;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere}svg{max-width:100%;height:auto}li{margin:5px 0}</style><h1>销售数据分析报告</h1><p class="meta">${escapeHtml(report.createdAt)} · ${report.mode === 'ai' ? 'AI 分析' : 'Replay 演示'}</p><h2>问题</h2><p>${escapeHtml(report.question)}</p><h2>计算结果</h2><p>${escapeHtml(report.answer)}</p>${chart}${tableHtml(report.table)}<h2>分析依据</h2>${evidence ? `<p>数据：${escapeHtml(evidence.dataset.name)} · ${escapeHtml(evidence.dataset.sheet)} · v${evidence.dataset.version}<br>数据集 ID：${escapeHtml(evidence.dataset.id)}<br>Checksum：${escapeHtml(evidence.dataset.checksum)}<br>时间：${evidence.spec.start} 至 ${evidence.spec.end} · 区域：${escapeHtml(evidence.spec.region || '全部')} · 指标：${escapeHtml(evidence.spec.metric)}</p><pre>${escapeHtml(evidence.sql)}</pre>${tableHtml(evidence.rows)}` : '<p>未执行有效查询。</p>'}<h2>口径与边界</h2><ul>${report.notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul></html>`
}
export function resultCsv(rows: Row[]) {
  const keys = Object.keys(rows[0] || {})
  const cell = (value: unknown) => {
    let text = String(value ?? '')
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  return '\ufeff' + [keys, ...rows.map(row => keys.map(key => row[key]))].map(row => row.map(cell).join(',')).join('\r\n')
}
