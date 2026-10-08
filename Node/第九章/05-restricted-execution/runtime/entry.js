import { readFile } from 'node:fs/promises'
import { runReadOnlyQuery } from './query-worker.js'

/**
 * 容器入口：在容器内执行 SQL 或分析模块，标准输出只返回一份 JSON。
 */
async function main() {
	// 读取宿主程序准备的任务描述，确定本次执行的任务类型
	const request = JSON.parse(await readFile('/input/request.json', 'utf8'))
	let result

	if (request.kind === 'sql') {
		// SQL 任务：使用只读查询方法访问容器内的数据库副本
		result = await runReadOnlyQuery({
			databasePath: '/input/data.duckdb',
			sql: request.sql
		})
	} else if (request.kind === 'code') {
		// 代码任务：读取宿主程序提前准备好的有限数据
		const rows = JSON.parse(await readFile('/input/rows.json', 'utf8'))

		// 动态加载待执行的分析模块，获取默认导出的分析函数
		// 待执行代码只在受限容器内加载，宿主进程不 import、eval 或执行这份源码。
		const { default: analyze } = await import('/input/analysis.mjs')

		// 将输入数据交给分析函数，获取计算结果
		result = await analyze(rows)
	} else {
		// 拒绝执行未定义的任务类型
		throw new Error('不支持的任务类型。')
	}

	// 将执行结果封装为约定的 JSON 格式，通过标准输出返回宿主程序
	process.stdout.write(JSON.stringify({ ok: true, result }))
}

// 启动容器内的主任务，并统一捕获执行过程中未处理的异常
main().catch((error) => {
	// 优先提取底层错误码，其次使用错误对象的错误码或错误信息
	const detail = error.cause?.code || error.code || error.message

	// 将错误封装为约定的 JSON 格式，并限制错误信息长度
	// 保证宿主程序能够通过标准输出解析失败原因
	process.stdout.write(
		JSON.stringify({ ok: false, error: String(detail).slice(0, 1600) })
	)

	// 将进程退出码设置为 1，标记本次任务执行失败
	process.exitCode = 1
})
