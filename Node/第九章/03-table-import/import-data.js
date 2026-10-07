import { basename, dirname, extname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, writeFile, readFile, rename, rm, access } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { DuckDBInstance } from '@duckdb/node-api'
import { readSource, inspectSource, readTable, normalizeRows, buildProfile, columns, hash, PARSER_VERSION } from './table-parser.js'

const projectDir = dirname(fileURLToPath(import.meta.url))

/** 将原始单元格与整理后的所有明细分表保存，不把问题行静默丢弃。 */
export async function saveDatabase(databasePath, table, normalized) {
  const instance = await DuckDBInstance.create(databasePath)
  let connection
  try {
    connection = await instance.connect()
    await connection.run('BEGIN TRANSACTION')
    await connection.run('CREATE TABLE sales_raw (source_row INTEGER, cells_json VARCHAR)')
    // 表名、列名和类型只来自课程固定 Schema；单元格内容统一作为参数绑定。
    await connection.run(`CREATE TABLE sales (source_row INTEGER, ${columns.map(column => `${column.name} ${column.type}`).join(', ')}, is_valid BOOLEAN)`)
    await connection.run('CREATE TABLE import_issues (source_row INTEGER, field VARCHAR, code VARCHAR, message VARCHAR)')
    for (const row of table.rows) await connection.run('INSERT INTO sales_raw VALUES ($1, $2)', [row.sourceRow, JSON.stringify(row.cells)])
    for (const row of normalized.rows) {
      await connection.run('INSERT INTO sales VALUES ($1, $2, $3, CAST($4 AS DATE), $5, $6, $7, CAST($8 AS DECIMAL(18,2)), CAST($9 AS DECIMAL(18,2)), $10, $11)',
        [row.sourceRow, ...columns.map(column => row.values[column.name]), row.isValid])
    }
    for (const issue of normalized.issues) await connection.run('INSERT INTO import_issues VALUES ($1, $2, $3, $4)', [issue.sourceRow, issue.field, issue.code, issue.message])
    await connection.run('COMMIT')
  } finally {
    connection?.closeSync()
    instance.closeSync()
  }
}

/** 用文件内容和导入规则标识版本；相同版本复用，失败时不发布半成品目录。 */
export async function saveDataset(source, table, normalized, profile, options = {}) {
  const datasetId = options.datasetId ?? 'sales-demo'
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(datasetId)) throw new Error('datasetId 只允许小写英文开头，包含小写英文、数字和短横线，最长 40 字符。')
  const importOptions = { sheet: table.sheet, headerRow: table.headerRow, delimiter: table.delimiter, parserVersion: PARSER_VERSION }
  const version = hash(JSON.stringify({ sourceHash: source.sha256, ...importOptions }))
  const root = resolve(options.outputRoot ?? join(projectDir, 'outputs'), datasetId)
  const directory = join(root, version)
  try {
    const existing = JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'))
    if (existing.version !== version) throw new Error('已有版本元数据不一致。')
    await access(join(directory, 'data.duckdb'))
    await access(join(directory, `source${source.extension}`))
    return { ...existing, directory, reused: true }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(root, { recursive: true })
  const temporary = await mkdtemp(join(root, '.import-'))
  const saved = {
    datasetId, version, sourceHash: source.sha256,
    sourceFile: basename(source.filePath), sourceCopy: `source${source.extension}`,
    importOptions, positionKind: table.positionKind, tableName: 'sales', ...profile
  }
  try {
    await writeFile(join(temporary, saved.sourceCopy), source.bytes)
    await saveDatabase(join(temporary, 'data.duckdb'), table, normalized)
    await writeFile(join(temporary, 'profile.json'), JSON.stringify(saved, null, 2) + '\n')
    await writeFile(join(temporary, 'issues.json'), JSON.stringify(normalized.issues, null, 2) + '\n')
    await rename(temporary, directory)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
  return { ...saved, directory, reused: false }
}

/** 打印学生需要核对的数据概览、问题原行及实际落盘位置。 */
function printResult(result, issues) {
  console.log(`\n数据集：${result.datasetId}`)
  console.log(`版本：${result.version.slice(0, 12)}（完整版本见目录）${result.reused ? '，复用已有版本' : ''}`)
  console.log(`状态：${result.status}`)
  console.log(`明细行数：${result.rowCount}；通过本例规则：${result.validRowCount}；问题条数：${result.issueCount}`)
  console.log(`合法日期范围：${result.dateRange?.start ?? '无'} 至 ${result.dateRange?.end ?? '无'}`)
  console.table(result.columns.map(({ name, header, type, nullCount }) => ({ 字段: name, 原表头: header, 类型: type, 空值: nullCount })))
  console.log('前三条整理结果：')
  console.table(result.samples.map(row => ({ 原始位置: row.sourceRow, ...row.values, 通过校验: row.isValid })))
  if (issues.length) {
    console.log(`问题位置使用：${result.positionKind}`)
    console.table(issues.map(issue => ({ 位置: issue.sourceRow, 字段: issue.field, 问题: issue.message })))
    console.log('完整数据已保存为待核对版本。请先处理问题，不要直接过滤问题行后汇总销售额。')
  }
  console.log('输出目录：', result.directory)
}

/** 从命令入口依次完成读取、字段整理、数据概览和持久化。 */
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { sheet: { type: 'string' }, 'header-row': { type: 'string', default: '1' }, delimiter: { type: 'string', default: ',' }, 'dataset-id': { type: 'string', default: 'sales-demo' } }
  })
  const [command, file] = positionals
  if (!['inspect', 'import'].includes(command) || !file) throw new Error('用法：node import-data.js inspect|import 文件路径 [--sheet 销售明细 --header-row 3]')
  const source = await readSource(resolve(file))
  if (command === 'inspect') {
    for (const item of inspectSource(source)) {
      console.log(`\n工作表/文件：${item.sheet}，范围：${item.range ?? '按 CSV 记录读取'}`)
      console.table(item.preview)
    }
    return
  }
  const table = readTable(source, { sheet: values.sheet, headerRow: Number(values['header-row']), delimiter: values.delimiter === 'tab' ? '\t' : values.delimiter })
  const normalized = normalizeRows(table)
  const profile = buildProfile(table, normalized)
  const result = await saveDataset(source, table, normalized, profile, { datasetId: values['dataset-id'] })
  printResult(result, normalized.issues)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`\n导入失败：${error.message}`); process.exitCode = 1 })
}
