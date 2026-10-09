import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { loadDataset } from '../04-text-to-sql/dataset.js'
import { runSandbox } from '../05-restricted-execution/sandbox.js'
import { createChartOption, renderReport } from './report-view.js'

const projectDir = dirname(fileURLToPath(import.meta.url))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** 汇总与明细共用筛选条件，防止图表查九月、依据却查了全部月份。 */
export function createQueries(month = '2026-09', region) {
	if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
		throw new Error('月份请使用 YYYY-MM，例如 2026-09。')
	}
	// 本课只开放固定区域选项，SQL 不直接拼接任意用户文本。
	if (region !== undefined && !['华东', '华南', '西北'].includes(region)) {
		throw new Error('区域可选：华东、华南、西北。')
	}
	const [year, number] = month.split('-').map(Number)
	const start = `${month}-01`
	const end = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10)
	const where =
		`WHERE sold_at >= DATE '${start}'\n  AND sold_at < DATE '${end}'` +
		(region === undefined ? '' : `\n  AND region = '${region}'`)
	return {
		filters: { month, start, end, region: region ?? null },
		summary: `SELECT region, SUM(paid_amount) AS sales_amount\nFROM sales\n${where}\nGROUP BY region\nORDER BY sales_amount DESC, region`,
		details: `SELECT source_row, line_id, sold_at, region, paid_amount\nFROM sales\n${where}\nORDER BY source_row`
	}
}

/** 按“分”核对金额，避免用浮点数比较财务数值。图表显示时才转换成 Number。 */
export function cents(value) {
	if (typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) {
		throw new Error('金额必须是保留两位小数的非负字符串。')
	}
	const result = BigInt(value.replace('.', ''))
	if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error('金额超出本例绘图范围。')
	}
	return result
}

/** 确认每个汇总值都能由这次保留的明细重新算出；不接收不完整的依据。 */
export function verifyEvidence(rows, details) {
	const totals = new Map()
	const ids = new Set()
	for (const row of details) {
		if (
			!Number.isInteger(row.source_row) ||
			row.source_row < 1 ||
			typeof row.line_id !== 'string' ||
			!row.line_id ||
			ids.has(row.line_id)
		) {
			throw new Error('依据缺少原始行号，或存在重复明细。')
		}
		ids.add(row.line_id)
		totals.set(
			row.region,
			(totals.get(row.region) ?? 0n) + cents(row.paid_amount)
		)
	}
	if (
		new Set(rows.map((row) => row.region)).size !== rows.length ||
		rows.length !== totals.size
	) {
		throw new Error('汇总结果和明细的区域不一致。')
	}
	for (const row of rows) {
		if (totals.get(row.region) !== cents(row.sales_amount)) {
			throw new Error(
				`${row.region} 的明细合计与图表金额不一致，停止生成报告。`
			)
		}
	}
}

/**
 * 沿一个入口完成：固定数据版本、查询、核对依据、绘图和保存报告。
 */
export async function main(options = {}) {
	// 根据用户指定的月份和区域，生成汇总查询与明细查询 SQL
	const queries = createQueries(options.month, options.region)

	// 本例直接给出配置，不调用模型。模型接入时也只能提出同样的有限配置。
	const chartSpec = { type: 'bar', x: 'region', y: options.y ?? 'sales_amount' }

	// 提前校验图表配置，确保图表类型和数据字段符合要求
	createChartOption(chartSpec, [])

	// 加载已导入的数据集，获取数据库文件及数据集版本信息
	const dataset = await loadDataset()
	const directory = dirname(dataset.databasePath)

	// 读取数据导入档案，获取原始文件、工作表和导入配置
	const profile = JSON.parse(
		await readFile(join(directory, 'profile.json'), 'utf8')
	)

	// 检查数据来源，确保使用的是本课程要求的 Excel 数据和工作表
	if (
		profile.sourceCopy !== 'source.xlsx' ||
		profile.importOptions.sheet !== '销售明细'
	) {
		throw new Error('本例需要 04 导入的 sales-clean.xlsx / 销售明细。')
	}

	// 为本次报告生成唯一 ID，并创建独立的输出目录
	const reportId = randomUUID()
	const output = join(projectDir, 'outputs', reportId)
	await mkdir(output, { recursive: true })

	try {
		// 两次查询使用同一个数据库快照；原文件也随报告保留，避免后续上传覆盖依据。
		await copyFile(dataset.databasePath, join(output, 'data.duckdb'))
		await copyFile(
			join(directory, profile.sourceCopy),
			join(output, 'source.xlsx')
		)

		// 计算原始 Excel 文件的哈希值，验证副本与导入时的文件一致
		const sourceHash = sha256(await readFile(join(output, 'source.xlsx')))
		if (sourceHash !== profile.sourceHash)
			throw new Error('原文件副本与导入版本不一致。')

		// 计算数据库快照的哈希值，用于记录本次报告对应的数据版本
		const databaseHash = sha256(await readFile(join(output, 'data.duckdb')))
		const databasePath = join(output, 'data.duckdb')

		// 在独立沙箱中执行汇总 SQL，获取各区域的销售额统计结果
		const summaryRun = await runSandbox(
			{ kind: 'sql', sql: queries.summary },
			{ databasePath }
		)

		// 汇总查询失败时立即终止，避免生成没有真实数据依据的报告
		if (summaryRun.status !== 'completed')
			throw new Error(`汇总查询失败：${summaryRun.error}`)

		// 使用同一数据库快照执行明细 SQL，获取用于核对的原始记录
		const detailRun = await runSandbox(
			{ kind: 'sql', sql: queries.details },
			{ databasePath }
		)

		// 明细查询失败时终止，防止缺少核对依据
		if (detailRun.status !== 'completed')
			throw new Error(`明细查询失败：${detailRun.error}`)

		// 分别提取汇总结果和明细记录
		const rows = summaryRun.result.rows
		const details = detailRun.result.rows

		// 使用明细数据核对汇总结果，确保统计金额与底层记录一致
		verifyEvidence(rows, details)

		// 组装完整报告，保留业务问题、数据版本、统计口径、SQL 和执行依据
		const report = {
			reportId,
			createdAt: new Date().toISOString(),

			// 记录本次报告实际回答的业务问题
			question: `仅按已导入记录，${queries.filters.month} ${options.region ?? '各区域'}的未扣退款销售额是多少？`,

			// 保存数据来源和文件哈希，方便追踪、验证及复现查询结果
			dataset: {
				datasetId: dataset.context.datasetId,
				version: dataset.context.version,
				sourceFile: profile.sourceFile,
				sheet: profile.importOptions.sheet,
				table: profile.tableName,
				sourceHash,
				databaseHash,
				importOptions: profile.importOptions
			},

			// 明确统计指标、计算公式及金额单位，避免统计口径歧义
			metric: {
				name: '未扣退款销售额',
				expression: 'SUM(paid_amount)',
				unit: '元'
			},

			// 保存筛选条件、查询 SQL、图表配置和真实查询结果
			filters: queries.filters,
			sql: queries.summary,
			detailSql: queries.details,
			chartSpec,
			rows,
			details,

			// 保留两次沙箱执行记录，便于审计和排查问题
			executions: { summary: summaryRun, details: detailRun }
		}

		// 保存完整 JSON 报告，包含数据来源、查询结果及全部核对依据
		await writeFile(
			join(output, 'report.json'),
			JSON.stringify(report, null, 2) + '\n'
		)

		// 将报告渲染为 HTML，生成可直接打开的可视化报告
		await writeFile(join(output, 'report.html'), renderReport(report))

		// 在控制台展示汇总结果、明细核对状态和报告保存位置
		console.table(rows)
		console.log(`明细核对：通过，共 ${details.length} 条。`)
		console.log(`打开报告：${join(output, 'report.html')}`)
		console.log(`完整依据：${join(output, 'report.json')}`)

		// 返回报告内容和输出目录，供后续流程使用
		return { report, output }
	} catch (error) {
		// 失败不留下看似可用的半份报告，也不覆盖以前成功的报告。
		await rm(output, { recursive: true, force: true })

		// 将原始异常继续抛出，由上层统一处理
		throw error
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const { values } = parseArgs({
			options: {
				month: { type: 'string' },
				region: { type: 'string' },
				y: { type: 'string' }
			}
		})
		await main(values)
	} catch (error) {
		console.error(`生成失败：${error.message}`)
		process.exitCode = 1
	}
}
