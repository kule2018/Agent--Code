import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import * as XLSX from 'xlsx'
import { readSource, readTable, normalizeRows, buildProfile } from '../03-table-import/table-parser.js'
import { saveDataset } from '../03-table-import/import-data.js'

export const projectDir = dirname(fileURLToPath(import.meta.url))
export const dataRoot = join(projectDir, 'data')

/** 复用 03 的导入流程，在本节目录保存销售明细，并补充同一工作簿中的商品表。 */
export async function prepareDataset(root = dataRoot) {
  const source = await readSource(join(projectDir, '../03-table-import/samples/sales-clean.xlsx'))
  const table = readTable(source, { sheet: '销售明细', headerRow: 3, delimiter: ',' })
  const normalized = normalizeRows(table)
  const profile = buildProfile(table, normalized)
  if (profile.status !== 'ready') throw new Error('销售数据需要核对，暂不开放查询。')
  const saved = await saveDataset(source, table, normalized, profile, { outputRoot: root })

  const products = XLSX.utils.sheet_to_json(source.workbook.Sheets['商品信息'])
  const ids = products.map((row) => row['商品编号'])
  if (!products.length || new Set(ids).size !== ids.length || products.some((row) =>
    ['商品编号', '商品名称', '品类'].some((key) => typeof row[key] !== 'string' || !row[key].trim())
  )) throw new Error('商品表必须包含唯一商品编号、商品名称和品类。')

  const instance = await DuckDBInstance.create(join(saved.directory, 'data.duckdb'))
  let connection
  try {
    connection = await instance.connect()
    await connection.run('BEGIN TRANSACTION')
    await connection.run('CREATE TABLE IF NOT EXISTS products (product_id VARCHAR PRIMARY KEY, product_name VARCHAR, category VARCHAR)')
    await connection.run('DELETE FROM products')
    for (const row of products) {
      await connection.run('INSERT INTO products VALUES ($1, $2, $3)', [row['商品编号'], row['商品名称'], row['品类']])
    }
    const unmatched = await connection.runAndReadAll('SELECT COUNT(*) AS n FROM sales s LEFT JOIN products p ON s.product_id = p.product_id WHERE p.product_id IS NULL')
    if (unmatched.getRowObjects()[0].n !== 0n) throw new Error('存在没有对应商品的销售明细。')
    await connection.run('COMMIT')
  } finally {
    connection?.closeSync()
    instance.closeSync()
  }
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'current.json'), JSON.stringify({ datasetId: saved.datasetId, version: saved.version }, null, 2) + '\n')
  return loadDataset(root)
}

/** 从当前数据版本加载真实 Schema；只把字段与口径传给模型，不发送整张明细表。 */
export async function loadDataset(root = dataRoot) {
  let current
  try {
    current = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('请先执行 npm run prepare-data。')
    throw error
  }
  if (current.datasetId !== 'sales-demo' || !/^[a-f0-9]{64}$/.test(current.version)) {
    throw new Error('当前数据版本配置无效。')
  }
  const directory = join(root, current.datasetId, current.version)
  const profile = JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'))
  if (profile.status !== 'ready' || profile.version !== current.version) throw new Error('数据尚未通过检查或版本不一致。')
  const databasePath = join(directory, 'data.duckdb')
  const instance = await DuckDBInstance.create(databasePath, { access_mode: 'READ_ONLY' })
  let connection
  try {
    connection = await instance.connect()
    const invalid = await connection.runAndReadAll('SELECT COUNT(*) AS n FROM sales WHERE is_valid IS NOT TRUE')
    if (invalid.getRowObjects()[0].n !== 0n) throw new Error('数据存在待核对明细，暂不开放查询。')
    const schemas = {}
    for (const name of ['sales', 'products']) {
      const result = await connection.runAndReadAll(`PRAGMA table_info('${name}')`)
      schemas[name] = result.getRowObjects().map(({ name, type }) => ({ name, type }))
    }
    return {
      databasePath,
      context: {
        datasetId: profile.datasetId,
        version: profile.version,
        rowCount: profile.rowCount,
        dateRange: profile.dateRange,
        schemas,
        fields: profile.columns.map(({ name, description, header }) => ({ name, description, label: header })),
        grain: profile.grain,
        amountPolicy: profile.amountPolicy,
        relation: 'sales.product_id 对应 products.product_id；商品编号唯一；product_name 为名称，category 为品类。',
        rules: [
          '未扣退款销售额 = SUM(paid_amount)，扣退款净额 = SUM(paid_amount - refund_amount)，金额单位为人民币元。',
          '订单数 = COUNT(DISTINCT order_id)，明细条数 = COUNT(*)。',
          '没有退款发生日期，净额仅按销售日期归属，不可解释为当月现金流或当月发生的退款。',
          '日期最小值和最大值不能证明月份完整。本样本只支持按已导入记录比较，不外推完整月度业绩。',
          '环比 = (本期 - 上期) / 上期 * 100；上期为 0 或缺失时返回 NULL。缺失月份不自动补零。',
          '判断连续两个月下降至少需要三个连续月份，本样本只有 2026 年 8、9 月。',
          '问题没有给出必要的指标、时间或比较基准时先追问；超出数据覆盖范围时说明缺口。'
        ]
      }
    }
  } finally {
    connection?.closeSync()
    instance.closeSync()
  }
}
