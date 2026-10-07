import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import { readSource, inspectSource, readTable, normalizeCell, normalizeRows, buildProfile, columns } from './table-parser.js'
import { saveDataset } from './import-data.js'

const root = dirname(fileURLToPath(import.meta.url))
const sample = name => join(root, 'samples', name)
const xlsxOptions = { sheet: '销售明细', headerRow: 3 }
const field = name => columns.find(column => column.name === name)
const convert = (name, value, extra = {}, date1904 = false) => normalizeCell({ t: typeof value === 'number' ? 'n' : 's', v: value, ...extra }, field(name), date1904)

async function load(name) {
  const source = await readSource(sample(name))
  const table = readTable(source, source.workbook ? xlsxOptions : {})
  const normalized = normalizeRows(table)
  return { source, table, normalized, profile: buildProfile(table, normalized) }
}

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'table-import-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('Excel 与 CSV 得到相同明细，保留前导零、逗号和单元格内换行', async () => {
  const excel = await load('sales-clean.xlsx')
  const csv = await load('sales-clean.csv')
  assert.deepEqual(excel.normalized.rows.map(row => row.values), csv.normalized.rows.map(row => row.values))
  assert.equal(excel.profile.status, 'ready')
  assert.equal(excel.profile.rowCount, 6)
  assert.equal(new Set(excel.normalized.rows.map(row => row.values.order_id)).size, 5)
  assert.equal(excel.normalized.rows[0].values.line_id, '0001')
  assert.equal(excel.normalized.rows[0].values.order_id, '001001')
  assert.equal(csv.normalized.rows[0].values.note, '企业客户,首次采购')
  assert.match(csv.normalized.rows[4].values.note, /\n/)
  assert.deepEqual(excel.profile.dateRange, { start: '2026-08-03', end: '2026-09-18' })
  assert.equal(excel.normalized.rows[0].sourceRow, 4)
  assert.equal(csv.normalized.rows[0].sourceRow, 2)
})

test('先选择销售工作表与第三行表头，不能默认拿第一张表', async () => {
  const source = await readSource(sample('sales-clean.xlsx'))
  assert.deepEqual(inspectSource(source).map(item => item.sheet), ['使用说明', '销售明细', '商品信息'])
  assert.throws(() => readTable(source), /指定有效工作表/)
  assert.throws(() => readTable(source, { sheet: '商品信息' }), /表头不匹配/)
  assert.throws(() => readTable(source, { sheet: '销售明细' }), /合并单元格/)
  assert.throws(() => readTable(source, { ...xlsxOptions, headerRow: 0 }), /正整数/)
})

test('不接受缺失、重复表头及数据区域的合并单元格', async () => {
  const source = await readSource(sample('sales-clean.xlsx'))
  const sheet = source.workbook.Sheets['销售明细']
  const original = sheet.A3.v
  sheet.A3.v = '订单编号'
  assert.throws(() => readTable(source, xlsxOptions), /表头不匹配/)
  sheet.A3.v = original
  sheet['!merges'].push({ s: { r: 3, c: 0 }, e: { r: 4, c: 0 } })
  assert.throws(() => readTable(source, xlsxOptions), /合并单元格/)
})

test('问题样本全部保留，重复明细两行都提示，公式缓存不进入金额', async () => {
  const { table, normalized, profile } = await load('sales-issues.xlsx')
  assert.equal(normalized.rows.length, 10)
  assert.equal(profile.status, 'needs_review')
  assert.equal(profile.validRowCount, 5)
  assert.equal(profile.issueCount, 5)
  assert.deepEqual(normalized.issues.map(issue => issue.sourceRow).sort((a, b) => a - b), [4, 10, 11, 12, 13])
  assert.equal(table.rows.at(-1).cells.paid_amount.f, 'G4+G5')
  assert.equal(table.rows.at(-1).cells.paid_amount.v, 2799.5)
  assert.equal(normalized.rows.at(-1).values.paid_amount, null)
  assert.equal(normalized.rows.find(row => row.sourceRow === 11).values.sold_at, null)
  assert.equal(normalized.rows.find(row => row.sourceRow === 12).values.paid_amount, null)
})

test('金额按十进制文本整理，空值、错误单位与异常精度不自动修补', () => {
  assert.equal(convert('paid_amount', '2,400.50'), '2400.50')
  assert.equal(convert('refund_amount', 0), '0.00')
  assert.equal(convert('paid_amount', '0.1'), '0.10')
  assert.equal(convert('paid_amount', '9999999999999999.99'), '9999999999999999.99')
  for (const value of [null, '', '2,40', '2万元', '-1', '1.234', '10000000000000000']) {
    assert.throws(() => convert('paid_amount', value))
  }
  assert.equal(convert('note', ''), null)
  assert.throws(() => convert('paid_amount', 12, { f: 'SUM(A1:A2)' }), /公式/)
  assert.throws(() => convert('paid_amount', 12, { F: 'G4:G5' }), /公式/)
  assert.throws(() => convert('paid_amount', 7, { t: 'e' }), /错误值/)
})

test('日期检查真实日历，并兼容 Excel 1900 与 1904 日期系统', () => {
  assert.equal(convert('sold_at', '2024-02-29'), '2024-02-29')
  assert.equal(convert('sold_at', 1), '1900-01-01')
  assert.equal(convert('sold_at', 0, {}, true), '1904-01-01')
  for (const value of ['2026-09-31', '2026-02-29', '09/10/2026', 60, 1.5]) {
    assert.throws(() => convert('sold_at', value))
  }
})

test('编号不能当数字，数量必须为约定范围内的整数', () => {
  assert.equal(convert('order_id', '001001'), '001001')
  assert.throws(() => convert('order_id', 1001), /文本/)
  assert.equal(convert('quantity', '2'), 2)
  for (const value of [0, -1, 1.5, '两个', 1_000_001]) assert.throws(() => convert('quantity', value))
})

test('退款超过实付金额时保留数值并报告业务规则问题', async () => {
  const { table } = await load('sales-clean.xlsx')
  table.rows[0].cells.refund_amount.v = '2400.51'
  const result = normalizeRows(table)
  assert.equal(result.rows[0].values.refund_amount, '2400.51')
  assert.equal(result.rows[0].isValid, false)
  assert.equal(result.issues[0].code, 'REFUND_EXCEEDS_PAYMENT')
})

test('CSV 支持显式分隔符，整条空记录跳过并统计，不丢弃多余列', async () => {
  const source = await readSource(sample('sales-clean.csv'))
  const semicolonSource = { text: columns.map(column => column.header).join(';') + '\n' + ['0001', '001001', '2026-08-03', '华东', 'P01', '1', '1200', '0', '备注'].join(';') }
  assert.equal(readTable(semicolonSource, { delimiter: ';' }).rows.length, 1)
  assert.throws(() => readTable(semicolonSource), /表头不匹配/)
  assert.equal(readTable({ ...source, text: source.text + '\r\n' }).skippedBlankRows, 1)
  assert.throws(() => readTable({ ...source, text: source.text + '多余,列\r\n' }), /列数/)
  assert.throws(() => readTable(source, { sheet: '销售明细' }), /没有工作表/)
})

test('读取阶段拒绝空文件、非 UTF-8 CSV、旧格式和过大文件', async t => {
  const directory = await temporary(t)
  for (const [name, bytes, pattern] of [
    ['empty.csv', Buffer.alloc(0), /非空/],
    ['bad.csv', Buffer.from([0xff, 0xfe, 0xff]), /UTF-8/],
    ['old.xls', Buffer.from('old'), /只支持/],
    ['fake.xlsx', Buffer.from('not an xlsx'), /XLSX/],
    ['large.csv', Buffer.alloc(5 * 1024 * 1024 + 1), /5 MiB/]
  ]) {
    const path = join(directory, name)
    await writeFile(path, bytes)
    await assert.rejects(readSource(path), pattern)
  }
})

test('保存后可重新打开 DuckDB，保留原文件并精确存储金额', async t => {
  const outputRoot = await temporary(t)
  const { source, table, normalized, profile } = await load('sales-clean.xlsx')
  const saved = await saveDataset(source, table, normalized, profile, { outputRoot })
  assert.ok((await readFile(join(saved.directory, 'source.xlsx'))).equals(source.bytes))
  const instance = await DuckDBInstance.create(join(saved.directory, 'data.duckdb'), { access_mode: 'READ_ONLY' })
  const connection = await instance.connect()
  try {
    const result = await connection.runAndReadAll('SELECT count(*)::INTEGER AS rows, count(DISTINCT order_id)::INTEGER AS orders, sum(paid_amount)::VARCHAR AS paid, sum(refund_amount)::VARCHAR AS refund FROM sales')
    assert.deepEqual(result.getRowObjects(), [{ rows: 6, orders: 5, paid: '6396.50', refund: '299.00' }])
    const raw = await connection.runAndReadAll('SELECT cells_json FROM sales_raw WHERE source_row = 4')
    assert.equal(JSON.parse(raw.getRowObjects()[0].cells_json).order_id.v, '001001')
  } finally { connection.closeSync(); instance.closeSync() }
  const repeated = await saveDataset(source, table, normalized, profile, { outputRoot })
  assert.equal(repeated.reused, true)
  assert.equal(repeated.directory, saved.directory)
})

test('新文件生成独立版本，问题记录仍在数据库，不覆盖正常版本', async t => {
  const outputRoot = await temporary(t)
  const clean = await load('sales-clean.xlsx')
  const dirty = await load('sales-issues.xlsx')
  const first = await saveDataset(clean.source, clean.table, clean.normalized, clean.profile, { outputRoot })
  const second = await saveDataset(dirty.source, dirty.table, dirty.normalized, dirty.profile, { outputRoot })
  assert.notEqual(first.version, second.version)
  assert.equal(JSON.parse(await readFile(join(first.directory, 'profile.json'))).status, 'ready')
  const instance = await DuckDBInstance.create(join(second.directory, 'data.duckdb'), { access_mode: 'READ_ONLY' })
  const connection = await instance.connect()
  try {
    const result = await connection.runAndReadAll('SELECT count(*)::INTEGER AS rows, count(*) FILTER (WHERE NOT is_valid)::INTEGER AS invalid FROM sales')
    assert.deepEqual(result.getRowObjects(), [{ rows: 10, invalid: 5 }])
    const issues = await connection.runAndReadAll('SELECT count(*)::INTEGER AS count FROM import_issues')
    assert.equal(issues.getRowObjects()[0].count, 5)
  } finally { connection.closeSync(); instance.closeSync() }
  await assert.rejects(saveDataset(clean.source, clean.table, clean.normalized, clean.profile, { outputRoot, datasetId: '../escape' }), /datasetId/)
})
