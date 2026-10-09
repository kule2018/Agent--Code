import ExcelJS from 'exceljs'
import { parse } from 'csv-parse/sync'
import { extname } from 'node:path'
import type { ColumnMap, Issue, SheetPreview } from '../shared/types.js'

const aliases: Record<keyof ColumnMap, string[]> = {
  date: ['销售日期', '日期', 'sold_at', 'date'], region: ['区域', '地区', 'region'],
  product: ['商品名称', '商品', 'product'], paid: ['实付金额（元）', '实付金额', 'paid_amount'],
  refund: ['退款金额（元）', '退款金额', 'refund_amount']
}
export type Matrix = { name: string; cells: unknown[][] }

/** 读取单行表头的销售表；公式保留为对象，后续明确报错，不采用缓存值。 */
export async function parseFile(bytes: Buffer, filename: string): Promise<Matrix[]> {
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('文件须为非空且不超过 5 MiB')
  const extension = extname(filename).toLowerCase()
  if (extension === '.csv') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const cells = parse(text, { bom: true, skip_empty_lines: true, max_record_size: 100000 }) as unknown[][]
    checkSize(cells)
    return [{ name: 'CSV', cells }]
  }
  if (extension !== '.xlsx' || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('只支持 XLSX 与 UTF-8 CSV')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as any)
  return workbook.worksheets.map(sheet => {
    if (sheet.rowCount > 10001 || sheet.columnCount > 50) throw new Error('每张表最多 10000 行数据、50 列')
    if (Object.keys((sheet.model as any).merges ?? []).length) throw new Error('请先取消表头和数据区域的合并单元格')
    const cells: unknown[][] = []
    sheet.eachRow({ includeEmpty: true }, row => {
      cells.push(Array.from({ length: sheet.columnCount }, (_, i) => row.getCell(i + 1).value))
    })
    checkSize(cells)
    return { name: sheet.name, cells }
  })
}
function checkSize(cells: unknown[][]) {
  if (!cells.length || cells.length > 10001 || cells.some(row => row.length > 50)) throw new Error('空表或超过 10000 行 / 50 列')
}

/** 显示原表字段，并给出可由用户改选的字段映射。 */
export function previewSheet(sheet: Matrix): SheetPreview {
  const headers = sheet.cells[0].map(value => typeof value === 'string' ? value.trim() : '')
  if (headers.some(h => !h) || new Set(headers).size !== headers.length) throw new Error(`${sheet.name} 的首行须为不重复的文字表头`)
  const suggested = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.find(h => names.includes(h)) || ''])) as ColumnMap
  return { name: sheet.name, headers, rows: sheet.cells.slice(1, 5).map(row => row.map(value => value instanceof Date ? value.toISOString().slice(0, 10) : value)), suggested }
}

/** 日期、金额和重复行逐项校验；问题行保留并阻止查询。 */
export function normalize(sheet: Matrix, mapping: ColumnMap) {
  const { headers } = previewSheet(sheet)
  if (Object.values(mapping).some(h => !headers.includes(h)) || new Set(Object.values(mapping)).size !== 5) throw new Error('请选择五个不同且真实存在的字段；金额单位须为元')
  const issues: Issue[] = []
  const seen = new Map<string, number>()
  const rows = sheet.cells.slice(1).flatMap((cells, i) => {
    if (cells.every(v => v == null || v === '')) return []
    const row = i + 2
    const get = (field: keyof ColumnMap) => cells[headers.indexOf(mapping[field])]
    const result: Record<string, string | number | null> = { source_row: row }
    for (const field of Object.keys(mapping) as (keyof ColumnMap)[]) {
      const value = get(field)
      try {
        if (value == null || value === '') throw new Error('必填值为空')
        if (typeof value === 'object' && !(value instanceof Date)) throw new Error('含公式或复杂单元格，请先核实并导出数值')
        if (field === 'date') {
          const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim()
          if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) throw new Error('日期须为有效 YYYY-MM-DD')
          result.sold_at = text
        } else if (field === 'paid' || field === 'refund') {
          const text = String(value).trim().replaceAll(',', '')
          if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(text) || Number(text) > 1000000000) throw new Error('金额须为非负数，最多两位小数，单位元')
          result[field === 'paid' ? 'paid_amount' : 'refund_amount'] = Number(text).toFixed(2)
        } else result[field === 'product' ? 'product_name' : 'region'] = String(value).trim()
      } catch (error) {
        issues.push({ row, field: mapping[field], message: (error as Error).message })
      }
    }
    if (Number(result.refund_amount) > Number(result.paid_amount)) issues.push({ row, field: mapping.refund, message: '退款金额超过实付金额' })
    const key = JSON.stringify(cells)
    if (seen.has(key)) issues.push({ row, field: '整行', message: `与第 ${seen.get(key)} 行完全相同，请核对是否重复导入；未自动删除` })
    else seen.set(key, row)
    return [result]
  })
  if (!rows.length) throw new Error('所选工作表没有明细')
  return { rows, issues }
}
