import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadDataset } from '../04-text-to-sql/dataset.js'
import { regionSql } from '../04-text-to-sql/replay.js'
import { runSandbox } from './sandbox.js'
import { projectDir } from './build-image.js'

/** 固定测试代码模拟执行器收到的内容；本节不调用模型，不验证模型生成能力。 */
export async function makeTask(name, rows) {
	switch (name) {
		case 'sql':
			return { kind: 'sql', sql: regionSql }
		case 'sql-table':
			return { kind: 'sql', sql: 'SELECT * FROM sales_raw' }
		case 'sql-file':
			return {
				kind: 'sql',
				sql: "SELECT * FROM read_csv_auto('/outside/private.csv')"
			}
		case 'sql-write':
			return { kind: 'sql', sql: 'DELETE FROM sales' }
		case 'code':
			return {
				kind: 'code',
				rows,
				code: await readFile(
					join(projectDir, 'samples/region-share.mjs'),
					'utf8'
				)
			}
		case 'read-host': {
			// 只创建课程探针，不读取真实私密文件。文件确实在宿主存在，但没有挂载进容器。
			const marker = join(projectDir, '.work', 'host-only.txt')
			await mkdir(join(projectDir, '.work'), { recursive: true })
			await writeFile(marker, 'course-host-only-marker')
			return {
				kind: 'code',
				rows,
				code: `import { readFile } from 'node:fs/promises';
export default async function () { return { rows: [{ text: await readFile(${JSON.stringify(marker)}, 'utf8') }] }; }`
			}
		}
		case 'write-input':
			return {
				kind: 'code',
				rows,
				code: "import { writeFile } from 'node:fs/promises'; export default async function () { await writeFile('/input/rows.json', '[]'); return { rows: [] }; }"
			}
		case 'network':
			return {
				kind: 'code',
				rows,
				code: "export default async function () { await fetch('http://192.0.2.1', { signal: AbortSignal.timeout(1500) }); return { rows: [] }; }"
			}
		case 'timeout':
			return {
				kind: 'code',
				rows,
				code: 'export default function () { while (true) {} }'
			}
		case 'output':
			return {
				kind: 'code',
				rows,
				code: "export default async function () { await new Promise((resolve) => process.stdout.write('x'.repeat(128 * 1024), resolve)); return { rows: [] }; }"
			}
		default:
			throw new Error(
				'可选：sql、code、sql-table、sql-file、sql-write、read-host、write-input、network、timeout、output'
			)
	}
}

/**
 * 从已授权数据集取查询结果，再把有限结果交给独立的分析任务。
 */
export async function main(name = process.argv[2] || 'code') {
	// 加载已授权的数据集，获取数据库路径和数据集信息
	const dataset = await loadDataset()
	let rows = []

	// 根据任务名称判断是否为 SQL 类型的任务
	const isSql = name.startsWith('sql')

	if (!isSql) {
		// 非 SQL 任务：先在沙箱中执行 SQL，获取后续分析需要的数据
		const query = await runSandbox(
			{ kind: 'sql', sql: regionSql },
			{ databasePath: dataset.databasePath }
		)

		// 查询失败则终止，不继续执行分析任务
		if (query.status !== 'completed')
			throw new Error(`准备查询结果失败：${query.error}`)

		// 提取查询结果，供后续分析任务使用
		rows = query.result.rows
		console.log('查询得到的原始结果：')
		console.table(rows)
	}

	// 根据任务名称和查询结果，构建本次沙箱执行任务
	const task = await makeTask(name, rows)

	// 在独立沙箱中执行任务，并限制最长执行时间
	// timeout 测试使用 2 秒，其余任务使用 5 秒
	const report = await runSandbox(task, {
		databasePath: dataset.databasePath,
		timeoutMs: name === 'timeout' ? 2000 : 5000
	})

	// 将数据集标识和版本写入执行报告，方便追踪数据来源
	report.dataset = {
		datasetId: dataset.context.datasetId,
		version: dataset.context.version
	}

	// 输出任务执行状态、计算结果和错误信息
	console.log(`\n测试：${name}\n状态：${report.status}`)
	if (report.result) console.table(report.result.rows)
	if (report.error) console.log(`原因：${report.error}`)

	// 输出沙箱资源清理状态和任务执行耗时
	console.log(
		`容器与临时输入已清理：${report.cleanedUp}\n执行时间：${report.elapsedMs}ms`
	)

	// 创建输出目录，保存完整的 JSON 执行报告
	await mkdir(join(projectDir, 'outputs'), { recursive: true })
	const file = join(projectDir, 'outputs', `${name}-${report.jobId}.json`)
	await writeFile(file, JSON.stringify(report, null, 2) + '\n')
	console.log(`执行记录：${file}`)

	// 根据测试场景确定预期状态，验证沙箱的执行限制是否生效
	const expected =
		isSql && name !== 'sql'
			? 'rejected' // 非标准 SQL 任务应被拒绝
			: ['read-host', 'write-input', 'network'].includes(name)
				? 'failed' // 访问宿主文件、修改输入或联网应执行失败
				: name === 'timeout'
					? 'timeout' // 执行超时应被终止
					: name === 'output'
						? 'output_limit' // 输出超过限制应被拦截
						: 'completed' // 正常任务应成功完成

	// 实际状态与预期不一致时抛出异常，提示检查执行记录
	if (report.status !== expected)
		throw new Error(`预期 ${expected}，实际 ${report.status}，请检查执行记录。`)

	// 返回完整执行报告
	return report
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(`执行失败：${error.message}`)
		process.exitCode = 1
	})
}
