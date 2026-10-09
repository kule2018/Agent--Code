import ExcelJS from 'exceljs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root } from '../server/storage.js'

/** 生成可手工核对的三个月销售数据，以及独立的质量问题样本。 */
export async function createSamples(directory = join(root, 'samples')) {
  await mkdir(directory, { recursive: true })
  const headers = ['销售日期', '区域', '商品名称', '实付金额（元）', '退款金额（元）']
  const values = [
    ['2026-07-15','华东','咖啡机',20000,2000], ['2026-07-15','华东','键盘',12000,0],
    ['2026-08-15','华东','咖啡机',16000,2000], ['2026-08-15','华东','键盘',11000,0],
    ['2026-09-15','华东','咖啡机',11000,1000], ['2026-09-15','华东','键盘',10000,0],
    ['2026-07-15','华南','咖啡机',9000,0], ['2026-07-15','华南','键盘',6000,0],
    ['2026-08-15','华南','咖啡机',11000,0], ['2026-08-15','华南','键盘',6000,0],
    ['2026-09-15','华南','咖啡机',13000,0], ['2026-09-15','华南','键盘',5000,0],
    ['2026-07-15','华北','咖啡机',10000,0], ['2026-07-15','华北','键盘',10000,0],
    ['2026-08-15','华北','咖啡机',12000,0], ['2026-08-15','华北','键盘',10000,0],
    ['2026-09-15','华北','咖啡机',9000,0], ['2026-09-15','华北','键盘',12000,0]
  ]
  const workbook = new ExcelJS.Workbook()
  const sales = workbook.addWorksheet('销售明细')
  sales.addRow(headers); sales.addRows(values)
  sales.columns.forEach(column => { column.width = 24 })
  const notes = workbook.addWorksheet('指标说明')
  notes.addRows([['指标','定义'], ['实付金额','未扣退款，人民币元'], ['净销售额','实付金额减退款金额，人民币元']])
  await workbook.xlsx.writeFile(join(directory, 'sales-demo.xlsx'))
  const csv = [headers, ...values].map(row => row.join(',')).join('\n')
  await writeFile(join(directory, 'sales-demo.csv'), '\ufeff' + csv)
  sales.addRows([values[0], ['2026-09-31','华东','咖啡机','未知',0], ['2026-09-15','华南','键盘',100,200]])
  await workbook.xlsx.writeFile(join(directory, 'sales-issues.xlsx'))
  await writeFile(join(directory, 'dashboard.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;background:#f4f7f9;font:20px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#202b34}.wrap{padding:48px}h1{font-size:30px;margin:0 0 14px}.meta{color:#657483;margin-bottom:36px}.sum{background:white;border:1px solid #dce4e9;padding:28px;border-radius:6px}strong{font-size:54px;display:block;color:#147965;margin:16px 0}table{width:100%;margin-top:24px;border-collapse:collapse}td,th{text-align:left;padding:18px;border-bottom:1px solid #e5e9ed}small{display:block;margin-top:24px;color:#657483}</style><div class="wrap"><h1>星河零售 · 月度销售看板</h1><div class="meta">2026-09-01 至 2026-09-30 · 全部区域 · 单位：元</div><div class="sum">实付金额<strong>60,000.00</strong><small>统计口径：订单实付金额，未扣除退款</small><table><tr><th>区域</th><th>实付金额（元）</th></tr><tr><td>华东</td><td>21,000.00</td></tr><tr><td>华南</td><td>18,000.00</td></tr><tr><td>华北</td><td>21,000.00</td></tr></table></div></div></html>`)
}
if (process.argv[1]?.endsWith('create-samples.ts')) {
  await createSamples()
  console.log('样例已生成：samples/sales-demo.xlsx、sales-demo.csv、sales-issues.xlsx')
}
