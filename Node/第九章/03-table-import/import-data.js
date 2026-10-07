import { basename, dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
	mkdir,
	mkdtemp,
	writeFile,
	readFile,
	rename,
	rm,
	access
} from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { DuckDBInstance } from '@duckdb/node-api'
import {
	readSource,
	inspectSource,
	readTable,
	normalizeRows,
	buildProfile,
	columns,
	hash,
	PARSER_VERSION
} from './table-parser.js'

const projectDir = dirname(fileURLToPath(import.meta.url))

/**
 * 将原始单元格与整理后的所有明细分表保存，不把问题行静默丢弃。
 */
export async function saveDatabase(databasePath, table, normalized) {
	// 创建或打开 DuckDB 数据库文件。
	const instance = await DuckDBInstance.create(databasePath)
	let connection

	try {
		// 建立数据库连接，并使用事务保证本次导入要么全部成功、要么全部失败。
		connection = await instance.connect()
		await connection.run('BEGIN TRANSACTION')

		// 保存最原始的单元格结构，便于后续追溯源文件内容。
		await connection.run(
			'CREATE TABLE sales_raw (source_row INTEGER, cells_json VARCHAR)'
		)

		// 保存标准化后的业务明细。
		// 表名、列名和类型只来自课程固定 Schema；单元格内容统一作为参数绑定。
		await connection.run(
			`CREATE TABLE sales (
				source_row INTEGER,
				${columns.map((column) => `${column.name} ${column.type}`).join(', ')},
				is_valid BOOLEAN
			)`
		)

		// 单独保存导入过程中发现的数据质量问题。
		await connection.run(
			'CREATE TABLE import_issues (source_row INTEGER, field VARCHAR, code VARCHAR, message VARCHAR)'
		)

		// 原始数据完整落库，不因为后续校验失败而丢失问题行。
		for (const row of table.rows) {
			await connection.run('INSERT INTO sales_raw VALUES ($1, $2)', [
				row.sourceRow,
				JSON.stringify(row.cells)
			])
		}

		// 保存标准化后的所有业务明细，并通过 is_valid 标记当前行是否通过校验。
		for (const row of normalized.rows) {
			await connection.run(
				`INSERT INTO sales VALUES (
					$1, $2, $3,
					CAST($4 AS DATE),
					$5, $6, $7,
					CAST($8 AS DECIMAL(18,2)),
					CAST($9 AS DECIMAL(18,2)),
					$10, $11
				)`,
				[
					row.sourceRow,
					...columns.map((column) => row.values[column.name]),
					row.isValid
				]
			)
		}

		// 将每个数据质量问题独立记录下来，
		// 后续可以根据 source_row 精确关联回原始记录和标准化记录。
		for (const issue of normalized.issues) {
			await connection.run(
				'INSERT INTO import_issues VALUES ($1, $2, $3, $4)',
				[issue.sourceRow, issue.field, issue.code, issue.message]
			)
		}

		// 三张表全部写入成功后再统一提交事务。
		await connection.run('COMMIT')
	} finally {
		// 无论成功还是异常，都释放数据库连接和实例资源。
		connection?.closeSync()
		instance.closeSync()
	}
}

/** 用文件内容和导入规则标识版本；相同版本复用，失败时不发布半成品目录。 */
export async function saveDataset(
	source,
	table,
	normalized,
	profile,
	options = {}
) {
	const datasetId = options.datasetId ?? 'sales-demo'
	if (!/^[a-z][a-z0-9-]{0,39}$/.test(datasetId))
		throw new Error(
			'datasetId 只允许小写英文开头，包含小写英文、数字和短横线，最长 40 字符。'
		)
	const importOptions = {
		sheet: table.sheet,
		headerRow: table.headerRow,
		delimiter: table.delimiter,
		parserVersion: PARSER_VERSION
	}
	const version = hash(
		JSON.stringify({ sourceHash: source.sha256, ...importOptions })
	)
	const root = resolve(
		options.outputRoot ?? join(projectDir, 'outputs'),
		datasetId
	)
	const directory = join(root, version)
	try {
		const existing = JSON.parse(
			await readFile(join(directory, 'profile.json'), 'utf8')
		)
		if (existing.version !== version) throw new Error('已有版本元数据不一致。')
		await access(join(directory, 'data.duckdb'))
		await access(join(directory, `source${source.extension}`))
		return { ...existing, directory, reused: true }
	} catch (error) {
		if (error.code !== 'ENOENT') throw error
	}
	await mkdir(root, { recursive: true })
	const temporary = await mkdtemp(join(root, '.import-'))
	const saved = {
		datasetId,
		version,
		sourceHash: source.sha256,
		sourceFile: basename(source.filePath),
		sourceCopy: `source${source.extension}`,
		importOptions,
		positionKind: table.positionKind,
		tableName: 'sales',
		...profile
	}
	try {
		await writeFile(join(temporary, saved.sourceCopy), source.bytes)
		await saveDatabase(join(temporary, 'data.duckdb'), table, normalized)
		await writeFile(
			join(temporary, 'profile.json'),
			JSON.stringify(saved, null, 2) + '\n'
		)
		await writeFile(
			join(temporary, 'issues.json'),
			JSON.stringify(normalized.issues, null, 2) + '\n'
		)
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
	console.log(
		`版本：${result.version.slice(0, 12)}（完整版本见目录）${result.reused ? '，复用已有版本' : ''}`
	)
	console.log(`状态：${result.status}`)
	console.log(
		`明细行数：${result.rowCount}；通过本例规则：${result.validRowCount}；问题条数：${result.issueCount}`
	)
	console.log(
		`合法日期范围：${result.dateRange?.start ?? '无'} 至 ${result.dateRange?.end ?? '无'}`
	)
	console.table(
		result.columns.map(({ name, header, type, nullCount }) => ({
			字段: name,
			原表头: header,
			类型: type,
			空值: nullCount
		}))
	)
	console.log('前三条整理结果：')
	console.table(
		result.samples.map((row) => ({
			原始位置: row.sourceRow,
			...row.values,
			通过校验: row.isValid
		}))
	)
	if (issues.length) {
		console.log(`问题位置使用：${result.positionKind}`)
		console.table(
			issues.map((issue) => ({
				位置: issue.sourceRow,
				字段: issue.field,
				问题: issue.message
			}))
		)
		console.log(
			'完整数据已保存为待核对版本。请先处理问题，不要直接过滤问题行后汇总销售额。'
		)
	}
	console.log('输出目录：', result.directory)
}

/**
 * 从命令入口依次完成读取、字段整理、数据概览和持久化
 */
async function main() {
	// 解析命令行参数：
	// positionals 保存命令和文件路径，values 保存工作表、表头行、分隔符等可选配置。
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			sheet: { type: 'string' },
			'header-row': { type: 'string', default: '1' },
			delimiter: { type: 'string', default: ',' },
			'dataset-id': { type: 'string', default: 'sales-demo' }
		}
	})

	// 第一个位置参数是执行命令，第二个位置参数是待处理的数据文件。
	const [command, file] = positionals

	// 仅支持 inspect 和 import 两种命令，并且必须指定数据文件。
	if (!['inspect', 'import'].includes(command) || !file) {
		throw new Error(
			'用法：node import-data.js inspect|import 文件路径 [--sheet 销售明细 --header-row 3]'
		)
	}

	// 根据文件路径读取数据源，统一处理 CSV、Excel 等不同格式。
	const source = await readSource(resolve(file))

	// inspect 模式只用于预览原始数据，不执行正式导入。
	if (command === 'inspect') {
		// 一个 Excel 文件可能包含多个工作表，因此逐个输出其基本信息和预览数据。
		for (const item of inspectSource(source)) {
			console.log(
				`\n工作表/文件：${item.sheet}，范围：${item.range ?? '按 CSV 记录读取'}`
			)
			console.table(item.preview)
		}
		return
	}

	// 正式导入时，根据命令行配置读取指定工作表和表头，
	// CSV 还可以通过 delimiter 指定字段分隔符。
	const table = readTable(source, {
		sheet: values.sheet,
		headerRow: Number(values['header-row']),
		delimiter: values.delimiter === 'tab' ? '\t' : values.delimiter
	})

	// 将原始表格字段和值转换为系统内部统一的数据结构，
	// 同时收集缺失值、非法字段等数据质量问题。
	const normalized = normalizeRows(table)

	// 根据原始表格和标准化后的数据生成数据概览，
	// 例如字段信息、记录数量、数据类型及质量统计。
	const profile = buildProfile(table, normalized)

	// 将原始信息、标准化数据和数据概览持久化为一个数据集。
	const result = await saveDataset(source, table, normalized, profile, {
		datasetId: values['dataset-id']
	})

	// 输出最终导入结果，并同时展示标准化阶段发现的数据问题。
	printResult(result, normalized.issues)
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main().catch((error) => {
		console.error(`\n导入失败：${error.message}`)
		process.exitCode = 1
	})
}
