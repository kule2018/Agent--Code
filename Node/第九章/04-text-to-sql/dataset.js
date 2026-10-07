import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance } from '@duckdb/node-api'
import * as XLSX from 'xlsx'
import {
	readSource,
	readTable,
	normalizeRows,
	buildProfile
} from '../03-table-import/table-parser.js'
import { saveDataset } from '../03-table-import/import-data.js'

export const projectDir = dirname(fileURLToPath(import.meta.url))
export const dataRoot = join(projectDir, 'data')

/** 复用 03 的导入流程，在本节目录保存销售明细，并补充同一工作簿中的商品表。 */
export async function prepareDataset(root = dataRoot) {
	const source = await readSource(
		join(projectDir, '../03-table-import/samples/sales-clean.xlsx')
	)
	const table = readTable(source, {
		sheet: '销售明细',
		headerRow: 3,
		delimiter: ','
	})
	const normalized = normalizeRows(table)
	const profile = buildProfile(table, normalized)
	if (profile.status !== 'ready')
		throw new Error('销售数据需要核对，暂不开放查询。')
	const saved = await saveDataset(source, table, normalized, profile, {
		outputRoot: root
	})

	const products = XLSX.utils.sheet_to_json(source.workbook.Sheets['商品信息'])
	const ids = products.map((row) => row['商品编号'])
	if (
		!products.length ||
		new Set(ids).size !== ids.length ||
		products.some((row) =>
			['商品编号', '商品名称', '品类'].some(
				(key) => typeof row[key] !== 'string' || !row[key].trim()
			)
		)
	)
		throw new Error('商品表必须包含唯一商品编号、商品名称和品类。')

	const instance = await DuckDBInstance.create(
		join(saved.directory, 'data.duckdb')
	)
	let connection
	try {
		connection = await instance.connect()
		await connection.run('BEGIN TRANSACTION')
		await connection.run(
			'CREATE TABLE IF NOT EXISTS products (product_id VARCHAR PRIMARY KEY, product_name VARCHAR, category VARCHAR)'
		)
		await connection.run('DELETE FROM products')
		for (const row of products) {
			await connection.run('INSERT INTO products VALUES ($1, $2, $3)', [
				row['商品编号'],
				row['商品名称'],
				row['品类']
			])
		}
		const unmatched = await connection.runAndReadAll(
			'SELECT COUNT(*) AS n FROM sales s LEFT JOIN products p ON s.product_id = p.product_id WHERE p.product_id IS NULL'
		)
		if (unmatched.getRowObjects()[0].n !== 0n)
			throw new Error('存在没有对应商品的销售明细。')
		await connection.run('COMMIT')
	} finally {
		connection?.closeSync()
		instance.closeSync()
	}
	await mkdir(root, { recursive: true })
	await writeFile(
		join(root, 'current.json'),
		JSON.stringify(
			{ datasetId: saved.datasetId, version: saved.version },
			null,
			2
		) + '\n'
	)
	return loadDataset(root)
}

/**
 * 从当前数据版本加载真实 Schema；只把字段与口径传给模型，不发送整张明细表。
 */
export async function loadDataset(root = dataRoot) {
	let current

	try {
		// current.json 记录当前启用的数据集及对应版本。
		current = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
	} catch (error) {
		// 数据尚未准备时给出明确提示，其他读取错误继续向上抛出。
		if (error.code === 'ENOENT') {
			throw new Error('请先执行 npm run prepare-data。')
		}
		throw error
	}

	// 只接受固定数据集，并要求版本号必须是合法的 SHA-256 哈希。
	if (
		current.datasetId !== 'sales-demo' ||
		!/^[a-f0-9]{64}$/.test(current.version)
	) {
		throw new Error('当前数据版本配置无效。')
	}

	// 每个数据版本拥有独立目录，避免查询阶段读到其他版本的数据。
	const directory = join(root, current.datasetId, current.version)

	// profile 保存预处理阶段生成的数据描述、字段定义和统计口径。
	const profile = JSON.parse(
		await readFile(join(directory, 'profile.json'), 'utf8')
	)

	// 只有已经检查完成且版本一致的数据才允许进入查询流程。
	if (profile.status !== 'ready' || profile.version !== current.version) {
		throw new Error('数据尚未通过检查或版本不一致。')
	}

	const databasePath = join(directory, 'data.duckdb')

	// 查询阶段以只读模式打开数据库，避免 Agent 查询意外修改数据。
	const instance = await DuckDBInstance.create(databasePath, {
		access_mode: 'READ_ONLY'
	})

	let connection

	try {
		connection = await instance.connect()

		// 查询前再次确认不存在待人工核对的无效明细。
		// 只要存在问题行，就禁止模型继续执行数据分析。
		const invalid = await connection.runAndReadAll(
			'SELECT COUNT(*) AS n FROM sales WHERE is_valid IS NOT TRUE'
		)

		if (invalid.getRowObjects()[0].n !== 0n) {
			throw new Error('数据存在待核对明细，暂不开放查询。')
		}

		// Schema 直接从当前 DuckDB 版本读取，
		// 避免代码里的字段定义与实际数据库结构发生漂移。
		const schemas = {}

		for (const name of ['sales', 'products']) {
			const result = await connection.runAndReadAll(
				`PRAGMA table_info('${name}')`
			)

			// 模型只需要知道字段名和数据库类型，不需要看到整张明细数据。
			schemas[name] = result
				.getRowObjects()
				.map(({ name, type }) => ({ name, type }))
		}

		return {
			databasePath,

			// context 是后续交给模型的数据理解上下文：
			// 包含 Schema、字段含义、数据粒度和统计规则，但不包含原始明细表。
			context: {
				datasetId: profile.datasetId,
				version: profile.version,
				rowCount: profile.rowCount,
				dateRange: profile.dateRange,
				schemas,

				// 将预处理阶段记录的字段元数据整理成模型更容易理解的形式。
				fields: profile.columns.map(({ name, description, header }) => ({
					name,
					description,
					label: header
				})),

				grain: profile.grain,
				amountPolicy: profile.amountPolicy,

				// 明确两张表之间的关联关系，帮助模型正确生成 JOIN。
				relation:
					'sales.product_id 对应 products.product_id；商品编号唯一；product_name 为名称，category 为品类。',

				// 将业务统计口径显式告诉模型，
				// 防止模型自行猜测销售额、订单数、退款或时间比较的定义。
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
		// 无论查询成功还是异常，都关闭连接和 DuckDB 实例，避免资源泄漏。
		connection?.closeSync()
		instance.closeSync()
	}
}
