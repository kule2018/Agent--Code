import { pathToFileURL } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'

const functions = new Set(['sum', 'count', 'count_star', 'avg', 'min', 'max', 'round', 'abs', 'coalesce', 'nullif', 'date_trunc', 'strftime', 'year', 'month', '+', '-', '*', '/', '%'])
const expressions = new Set(['COLUMN_REF', 'CONSTANT', 'FUNCTION', 'COMPARISON', 'CONJUNCTION', 'CAST', 'CASE', 'OPERATOR', 'STAR'])

/** 使用 DuckDB 自己的解析器检查单条查询；本课只开放简单 SELECT、聚合与两表 JOIN。 */
async function checkedSql(connection, sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 12_000) throw new Error('POLICY: SQL 为空或过长。')
  const parsed = await connection.runAndReadAll('SELECT json_serialize_sql(CAST($1 AS VARCHAR)) AS ast', [sql])
  const astText = parsed.getRowObjects()[0].ast
  const ast = JSON.parse(astText)
  if (ast.error) {
    const prefix = ast.error_type === 'parser' ? 'SQL' : 'POLICY'
    throw new Error(`${prefix}: ${ast.error_message}`)
  }
  if (ast.statements.length !== 1) throw new Error('POLICY: 只允许一条查询。')
  const root = ast.statements[0].node
  if (root.type !== 'SELECT_NODE') throw new Error('POLICY: 只允许 SELECT。')
  let tableCount = 0

  function visit(value) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach(visit)
    if (value.class && !expressions.has(value.class)) throw new Error(`POLICY: 本课未开放表达式 ${value.class}。`)
    if (value.cte_map?.map?.length || value.sample || value.qualify) throw new Error('POLICY: 本课未开放 CTE、采样或 QUALIFY。')
    if (value.class === 'FUNCTION' && (!functions.has(value.function_name) || value.schema || value.catalog || value.export_state)) {
      throw new Error(`POLICY: 本课未开放函数 ${value.function_name}。`)
    }
    if (value.type === 'TABLE_FUNCTION' || value.type === 'SUBQUERY' || value.type === 'PIVOT') throw new Error('POLICY: 本课未开放表函数、子查询或 PIVOT。')
    if (value.type === 'BASE_TABLE') {
      if (!['sales', 'products'].includes(value.table_name) || value.catalog_name || !['', 'main'].includes(value.schema_name) || value.at_clause) {
        throw new Error('POLICY: 只能读取当前数据集中的 sales、products。')
      }
      tableCount++
    }
    Object.values(value).forEach(visit)
  }
  visit(root)
  if (tableCount < 1 || tableCount > 2) throw new Error('POLICY: 查询需要读取一至两张业务表。')
  // 解析后重新生成 SQL，处理末尾分号；不靠字符串替换拼接用户语句。
  const canonical = await connection.runAndReadAll('SELECT json_deserialize_sql(CAST($1 AS JSON)) AS sql', [astText])
  return canonical.getRowObjects()[0].sql
}

/** 子进程仅打开受信任的数据库路径，返回受限结果；它不构成完整的操作系统沙箱。 */
export async function runReadOnlyQuery({ databasePath, sql, maxRows = 100 }) {
  const instance = await DuckDBInstance.create(databasePath, {
    access_mode: 'READ_ONLY',
    enable_external_access: 'false',
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
    allow_community_extensions: 'false',
    threads: '1',
    memory_limit: '128MB',
    max_temp_directory_size: '0B',
    lock_configuration: 'true'
  })
  let connection
  try {
    connection = await instance.connect()
    const canonical = await checkedSql(connection, sql)
    const result = await connection.runAndReadAll(`SELECT * FROM (${canonical}) AS query_result LIMIT ${maxRows + 1}`)
    const all = result.getRowObjectsJson()
    return { rows: all.slice(0, maxRows), truncated: all.length > maxRows }
  } finally {
    connection?.closeSync()
    instance.closeSync()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  try {
    const result = await runReadOnlyQuery(JSON.parse(input))
    process.stdout.write(JSON.stringify({ ok: true, ...result }))
  } catch (error) {
    const message = error.message.slice(0, 1600)
    const repairable = message.startsWith('SQL:') || message.startsWith('Binder Error:') || message.startsWith('Parser Error:')
    process.stdout.write(JSON.stringify({ ok: false, repairable, message }))
  }
}
