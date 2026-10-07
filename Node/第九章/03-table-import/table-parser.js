import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { createHash } from 'node:crypto'
import XLSX from 'xlsx'
import { parse } from 'csv-parse/sync'

export const MAX_ROWS = 10_000
export const PARSER_VERSION = 'sales-import-v1'
export const columns = [
  { name: 'line_id', header: '明细编号', type: 'VARCHAR', kind: 'id', description: '一行一笔订单商品明细，明细编号唯一' },
  { name: 'order_id', header: '订单编号', type: 'VARCHAR', kind: 'id', description: '同一订单可对应多条明细，保留前导零' },
  { name: 'sold_at', header: '销售日期', type: 'DATE', kind: 'date', description: '销售发生日期' },
  { name: 'region', header: '区域', type: 'VARCHAR', kind: 'text', description: '销售所属区域' },
  { name: 'product_id', header: '商品编号', type: 'VARCHAR', kind: 'id', description: '商品编号，对应原文件中的商品信息表' },
  { name: 'quantity', header: '数量', type: 'INTEGER', kind: 'integer', description: '本条明细的商品数量' },
  { name: 'paid_amount', header: '实付金额（元）', type: 'DECIMAL(18,2)', kind: 'money', description: '人民币元，本条明细实付金额，未扣退款' },
  { name: 'refund_amount', header: '退款金额（元）', type: 'DECIMAL(18,2)', kind: 'money', description: '人民币元，单列退款金额，0 表示无退款' },
  { name: 'note', header: '备注', type: 'VARCHAR', kind: 'text', optional: true, description: '原始备注，不作为程序指令执行' }
]

export const hash = value => createHash('sha256').update(value).digest('hex')
const blank = value => value == null || (typeof value === 'string' && value.trim() === '')

/** 读取受限大小的本地样本；CSV 只接收 UTF-8，避免乱码后继续导入。 */
export async function readSource(filePath) {
  const file = await stat(filePath)
  if (!file.isFile() || file.size === 0 || file.size > 5 * 1024 * 1024) {
    throw new Error('请选择非空且不超过 5 MiB 的本地文件。')
  }
  const extension = extname(filePath).toLowerCase()
  if (!['.xlsx', '.csv'].includes(extension)) throw new Error('本例只支持 .xlsx 和 UTF-8 CSV。')
  const bytes = await readFile(filePath)
  const source = { filePath, bytes, extension, sha256: hash(bytes) }
  if (extension === '.xlsx') {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('文件不是有效的 XLSX 压缩包。')
    source.workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false, cellNF: true, cellFormula: true })
  } else {
    try { source.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new Error('CSV 编码不是 UTF-8，请从 Excel/WPS 重新导出为 CSV UTF-8。') }
  }
  return source
}

/** 列出工作表或 CSV 前几条记录，帮助使用者先确定表头和目标表。 */
export function inspectSource(source) {
  if (source.workbook) return source.workbook.SheetNames.map(name => ({
    sheet: name,
    range: source.workbook.Sheets[name]['!ref'] ?? '空表',
    preview: XLSX.utils.sheet_to_json(source.workbook.Sheets[name], { header: 1, range: 0, raw: false }).slice(0, 4)
  }))
  return [{ sheet: 'CSV', preview: parse(source.text, { bom: true, to: 4, relax_column_count: true }) }]
}

/** 按明确指定的工作表、表头行读取；保留单元格类型、公式和原始位置。 */
export function readTable(source, { sheet, headerRow = 1, delimiter = ',' } = {}) {
  if (!Number.isInteger(headerRow) || headerRow < 1) throw new Error('headerRow 必须是从 1 开始的正整数。')
  let matrix, date1904 = false
  if (source.workbook) {
    const workbook = source.workbook
    if (!sheet || !workbook.Sheets[sheet]) throw new Error(`请指定有效工作表：${workbook.SheetNames.join('、')}。`)
    const worksheet = workbook.Sheets[sheet]
    if (!worksheet['!ref']) throw new Error('选中的工作表为空。')
    const range = XLSX.utils.decode_range(worksheet['!ref'])
    if (range.e.r + 1 > MAX_ROWS + headerRow || range.e.c >= 50) throw new Error('本例最多读取 10000 条数据、50 列。')
    if ((worksheet['!merges'] ?? []).some(merge => merge.e.r >= headerRow - 1)) {
      throw new Error('表头或数据区域包含合并单元格，请先整理成单行表头、每行一条明细。')
    }
    date1904 = Boolean(workbook.Workbook?.WBProps?.date1904)
    matrix = Array.from({ length: range.e.r + 1 }, (_, r) =>
      Array.from({ length: range.e.c + 1 }, (_, c) => {
        const address = XLSX.utils.encode_cell({ r, c })
        const cell = worksheet[address]
        return { address, t: cell?.t ?? 'z', v: cell?.v ?? null, w: cell?.w, z: cell?.z, f: cell?.f }
      }))
  } else {
    if (sheet) throw new Error('CSV 没有工作表，不需要 --sheet。')
    if (![',', ';', '\t'].includes(delimiter)) throw new Error('分隔符只支持逗号、分号或 tab。')
    // 允许先读入长短不一的记录，再在下面明确报错；不静默丢弃字段。
    const records = parse(source.text, { bom: true, delimiter, cast: false, relax_column_count: true, max_record_size: 100_000 })
    if (records.length > MAX_ROWS + headerRow) throw new Error('本例最多读取 10000 条 CSV 数据。')
    matrix = records.map((record, r) => record.map((v, c) => ({ address: `记录${r + 1}/列${c + 1}`, t: 's', v })))
  }
  const header = matrix[headerRow - 1] ?? []
  const names = header.map(cell => String(cell.v ?? '').trim())
  if (names.length !== columns.length || new Set(names).size !== names.length || columns.some(column => !names.includes(column.header))) {
    throw new Error(`表头不匹配。当前：${names.join('、')}。需要：${columns.map(column => column.header).join('、')}。请检查工作表、表头行或分隔符。`)
  }
  const rows = []
  let skippedBlankRows = 0
  matrix.slice(headerRow).forEach((cells, index) => {
    if (cells.every(cell => blank(cell.v) && !cell.f)) { skippedBlankRows++; return }
    if (cells.length !== names.length) throw new Error(`第 ${headerRow + index + 1} 条记录的列数与表头不同。`)
    rows.push({
      sourceRow: headerRow + index + 1,
      cells: Object.fromEntries(columns.map(column => [column.name, cells[names.indexOf(column.header)]]))
    })
  })
  if (!rows.length) throw new Error('表头后面没有数据。')
  return { sheet: sheet ?? null, headerRow, delimiter, date1904, rows, skippedBlankRows, positionKind: source.workbook ? 'Excel 行号' : 'CSV 记录序号（包含表头）' }
}

/** 把年月日校验为真实日历日期，不把 9 月 31 日自动滚到 10 月。 */
function calendarDate(year, month, day) {
  const text = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const date = new Date(`${text}T00:00:00Z`)
  if (year < 1900 || year > 9999 || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error('日期不存在或超出本例范围。')
  }
  return text
}

/** 根据已确认的销售字段规则转换类型；不会猜测金额单位或缺失值。 */
export function normalizeCell(cell, column, date1904) {
  if (cell.f) throw new Error('该单元格含公式。请核实并导出数值版本；本例不采用可能过期的公式缓存。')
  if (cell.t === 'e') throw new Error('该单元格包含 Excel 错误值。')
  if (blank(cell.v)) {
    if (column.optional) return null
    throw new Error('必需字段为空。')
  }
  const text = String(cell.v).trim()
  if (column.kind === 'id') {
    if (typeof cell.v !== 'string') throw new Error('编号必须以文本保存，避免前导零或长编号丢失。')
    return text
  }
  if (column.kind === 'text') return text
  if (column.kind === 'date') {
    if (typeof cell.v === 'number') {
      if (!Number.isInteger(cell.v)) throw new Error('销售日期只接收整日，不自动舍弃时间。')
      const parts = XLSX.SSF.parse_date_code(cell.v, { date1904 })
      if (!parts) throw new Error('Excel 日期序列值无效。')
      return calendarDate(parts.y, parts.m, parts.d)
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
    if (!match) throw new Error('日期请使用 YYYY-MM-DD，避免日/月顺序歧义。')
    return calendarDate(...match.slice(1).map(Number))
  }
  if (column.kind === 'integer') {
    if (!/^[1-9]\d*$/.test(text) || Number(text) > 1_000_000) throw new Error('数量必须是 1 到 1000000 的整数。')
    return Number(text)
  }
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('金额须为非负数、最多两位小数；支持千分位，不自动换算元和万元。')
  }
  const [integer, fraction = ''] = text.replaceAll(',', '').split('.')
  if (integer.length > 16) throw new Error('金额超出 DECIMAL(18,2) 范围。')
  return `${integer}.${fraction.padEnd(2, '0')}`
}

/** 校验所有记录并收集问题，保留原行；重复明细的每一行都会被标记。 */
export function normalizeRows(table) {
  const issues = []
  const addIssue = (row, field, code, message) => issues.push({ sourceRow: row.sourceRow, field, code, message })
  const rows = table.rows.map(row => {
    const values = {}
    for (const column of columns) {
      try { values[column.name] = normalizeCell(row.cells[column.name], column, table.date1904) }
      catch (error) {
        values[column.name] = null
        addIssue(row, column.name, row.cells[column.name].f ? 'FORMULA_REQUIRES_REVIEW' : 'INVALID_VALUE', error.message)
      }
    }
    if (values.paid_amount != null && values.refund_amount != null && BigInt(values.refund_amount.replace('.', '')) > BigInt(values.paid_amount.replace('.', ''))) {
      addIssue(row, 'refund_amount', 'REFUND_EXCEEDS_PAYMENT', '退款金额超过本条明细实付金额，请核对。')
    }
    return { sourceRow: row.sourceRow, values }
  })
  const counts = new Map()
  for (const row of rows) if (row.values.line_id) counts.set(row.values.line_id, (counts.get(row.values.line_id) ?? 0) + 1)
  for (const row of rows) if (counts.get(row.values.line_id) > 1) {
    addIssue(row, 'line_id', 'DUPLICATE_LINE_ID', `明细编号 ${row.values.line_id} 重复。请核实，程序没有删除记录。`)
  }
  const invalidRows = new Set(issues.map(issue => issue.sourceRow))
  return { rows: rows.map(row => ({ ...row, isValid: !invalidRows.has(row.sourceRow) })), issues }
}

/** 汇总字段、行数、合法日期范围和样例；完整明细仍留在本地。 */
export function buildProfile(table, normalized) {
  const dates = normalized.rows.map(row => row.values.sold_at).filter(Boolean).sort()
  return {
    status: normalized.issues.length ? 'needs_review' : 'ready',
    rowCount: normalized.rows.length,
    validRowCount: normalized.rows.filter(row => row.isValid).length,
    issueCount: normalized.issues.length,
    skippedBlankRows: table.skippedBlankRows,
    dateRange: dates.length ? { start: dates[0], end: dates.at(-1) } : null,
    grain: '一行一笔订单商品明细；line_id 应唯一，order_id 可以重复。',
    amountPolicy: '人民币元，paid_amount 未扣退款；refund_amount 单列，空值不等于 0。',
    columns: columns.map(column => ({ ...column, nullCount: normalized.rows.filter(row => row.values[column.name] == null).length })),
    samples: normalized.rows.slice(0, 3)
  }
}
