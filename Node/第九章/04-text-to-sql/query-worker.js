import { pathToFileURL } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'

const functions = new Set([
	'sum',
	'count',
	'count_star',
	'avg',
	'min',
	'max',
	'round',
	'abs',
	'coalesce',
	'nullif',
	'date_trunc',
	'strftime',
	'year',
	'month',
	'+',
	'-',
	'*',
	'/',
	'%'
])
const expressions = new Set([
	'COLUMN_REF',
	'CONSTANT',
	'FUNCTION',
	'COMPARISON',
	'CONJUNCTION',
	'CAST',
	'CASE',
	'OPERATOR',
	'STAR'
])

/** 使用 DuckDB 自己的解析器检查单条查询；本课只开放简单 SELECT、聚合与两表 JOIN。 */
async function checkedSql(connection, sql) {
	// 检查 SQL 是否有效，并限制最大长度为 12000 个字符
	if (typeof sql !== 'string' || !sql.trim() || sql.length > 12_000)
		throw new Error('POLICY: SQL 为空或过长。')

	// 使用 DuckDB 内置解析器将 SQL 转换为 JSON 格式的抽象语法树（AST）
	// 不直接依赖正则表达式判断 SQL 是否安全
	const parsed = await connection.runAndReadAll(
		'SELECT json_serialize_sql(CAST($1 AS VARCHAR)) AS ast',
		[sql]
	)
	const astText = parsed.getRowObjects()[0].ast
	const ast = JSON.parse(astText)

	// 检查解析错误，区分 SQL 语法错误和其他策略拒绝
	if (ast.error) {
		const prefix = ast.error_type === 'parser' ? 'SQL' : 'POLICY'
		throw new Error(`${prefix}: ${ast.error_message}`)
	}

	// 只允许执行一条 SQL，防止通过多语句执行额外操作
	if (ast.statements.length !== 1) throw new Error('POLICY: 只允许一条查询。')

	// 获取语法树根节点，只允许 SELECT 查询
	const root = ast.statements[0].node
	if (root.type !== 'SELECT_NODE') throw new Error('POLICY: 只允许 SELECT。')

	// 记录查询涉及的业务表数量
	let tableCount = 0

	// 递归遍历 AST，检查查询中使用的表达式、函数和数据表
	function visit(value) {
		if (!value || typeof value !== 'object') return

		// 数组节点需要逐个检查其中的子节点
		if (Array.isArray(value)) return value.forEach(visit)

		// 表达式必须属于预先定义的白名单
		if (value.class && !expressions.has(value.class))
			throw new Error(`POLICY: 本课未开放表达式 ${value.class}。`)

		// 禁止使用 CTE、采样和 QUALIFY 等本课未开放的查询能力
		if (value.cte_map?.map?.length || value.sample || value.qualify)
			throw new Error('POLICY: 本课未开放 CTE、采样或 QUALIFY。')

		// 函数调用必须在白名单中，同时禁止指定 Schema、Catalog 或特殊导出状态
		if (
			value.class === 'FUNCTION' &&
			(!functions.has(value.function_name) ||
				value.schema ||
				value.catalog ||
				value.export_state)
		) {
			throw new Error(`POLICY: 本课未开放函数 ${value.function_name}。`)
		}

		// 禁止使用表函数、子查询和 PIVOT，限制 SQL 的可执行范围
		if (
			value.type === 'TABLE_FUNCTION' ||
			value.type === 'SUBQUERY' ||
			value.type === 'PIVOT'
		)
			throw new Error('POLICY: 本课未开放表函数、子查询或 PIVOT。')

		if (value.type === 'BASE_TABLE') {
			// 只允许读取当前数据集中的 sales 和 products 表
			// 禁止跨 Catalog、访问其他 Schema 或使用历史版本查询
			if (
				!['sales', 'products'].includes(value.table_name) ||
				value.catalog_name ||
				!['', 'main'].includes(value.schema_name) ||
				value.at_clause
			) {
				throw new Error('POLICY: 只能读取当前数据集中的 sales、products。')
			}

			// 当前节点是合法业务表，计入访问表数量
			tableCount++
		}

		// 继续检查当前节点的所有子节点，避免遗漏嵌套结构
		Object.values(value).forEach(visit)
	}

	// 从根节点开始，对整棵 SQL 语法树执行白名单检查
	visit(root)

	// 查询必须涉及 1～2 张业务表，不允许无表查询或访问更多表
	if (tableCount < 1 || tableCount > 2)
		throw new Error('POLICY: 查询需要读取一至两张业务表。')

	// 解析后重新生成 SQL，处理末尾分号；不靠字符串替换拼接用户语句。
	const canonical = await connection.runAndReadAll(
		'SELECT json_deserialize_sql(CAST($1 AS JSON)) AS sql',
		[astText]
	)

	// 返回通过检查的标准化 SQL，交给后续只读查询流程执行
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
		const result = await connection.runAndReadAll(
			`SELECT * FROM (${canonical}) AS query_result LIMIT ${maxRows + 1}`
		)
		const all = result.getRowObjectsJson()
		return { rows: all.slice(0, maxRows), truncated: all.length > maxRows }
	} finally {
		connection?.closeSync()
		instance.closeSync()
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	let input = ''
	for await (const chunk of process.stdin) input += chunk
	try {
		const result = await runReadOnlyQuery(JSON.parse(input))
		process.stdout.write(JSON.stringify({ ok: true, ...result }))
	} catch (error) {
		const message = error.message.slice(0, 1600)
		const repairable =
			message.startsWith('SQL:') ||
			message.startsWith('Binder Error:') ||
			message.startsWith('Parser Error:')
		process.stdout.write(JSON.stringify({ ok: false, repairable, message }))
	}
}
