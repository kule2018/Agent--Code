import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { loadDataset, prepareDataset, projectDir } from './dataset.js'
import { createAIProvider, Decision } from './model.js'
import { executeQuery } from './query-runner.js'
import { createReplayProvider, scenarios } from './replay.js'

/**
 * 从业务问题走到真实结果；只有 SQL 语法或字段错误允许修正一次。
 */
export async function answerQuestion(
	question,
	dataset,
	provider,
	execute = executeQuery
) {
	// 限制问题长度，避免空问题或超长输入进入后续模型调用。
	if (!question.trim() || question.length > 2000)
		throw new Error('问题需要在 1 到 2000 字符之间。')

	// report 保存本次查询的完整执行轨迹，方便展示、排查和审计。
	const report = {
		question,
		mode: provider.mode,
		datasetId: dataset.context.datasetId,
		version: dataset.context.version,
		attempts: []
	}

	// 只有可修复的 SQL 错误才会进入第二轮，
	// previousError 会把上一轮 SQL 和数据库错误反馈给模型。
	let previousError

	// 最多执行两轮：首次生成 SQL，必要时允许修正一次。
	for (let attempt = 0; attempt < 2; attempt++) {
		// 模型根据用户问题、真实 Schema、统计口径以及上一轮错误，
		// 决定是继续追问用户，还是生成 SQL。
		const decision = Decision.parse(
			await provider.decide(question, dataset.context, previousError)
		)

		// 如果问题缺少必要条件，不猜测 SQL，直接要求用户补充信息。
		if (decision.action === 'clarify')
			return {
				...report,
				status: 'clarify',
				answer: decision.question
			}

		// 保存每一轮模型决策，便于后续查看 SQL 是如何生成或修正的。
		const record = { decision }
		report.attempts.push(record)

		let result

		try {
			// SQL 必须真正交给数据库执行，后续回答只能基于数据库返回结果。
			result = await execute(dataset.databasePath, decision.sql)
		} catch (error) {
			record.error = error.message

			// 只有第一轮遇到明确可修复的 SQL 错误时，
			// 才允许把错误反馈给模型重新生成一次 SQL。
			if (attempt === 0 && error.repairable) {
				previousError = {
					sql: decision.sql,
					error: error.message
				}
				continue
			}

			// 权限、限制、执行失败或第二次仍失败时，不再继续重试。
			return {
				...report,
				status: 'failed',
				answer: `查询未完成：${error.message}`
			}
		}

		// 所有统计结果都必须带上数据覆盖范围限制，
		// 防止把样本数据误解为完整月份或完整业务数据。
		const warning =
			'结果只代表已导入记录；日期覆盖范围不能证明月份完整，不外推完整月度业绩。'

		report.result = result
		report.warning = warning

		// 查询结果超过展示上限时，不允许模型根据前 100 行概括全部数据。
		if (result.truncated)
			return {
				...report,
				status: 'needs_narrowing',
				answer:
					'结果超过 100 行，仅展示前 100 行。请增加筛选或聚合后重新提问，不据此概括全部结果。'
			}

		// 空结果只说明当前条件没有匹配记录，
		// 不能自动解释成指标为 0。
		if (!result.rows.length)
			return {
				...report,
				status: 'empty',
				answer:
					'没有查到符合条件的记录。请核对筛选条件和数据范围；空结果不代表销售额为 0。'
			}

		try {
			// SQL 成功并取得真实结果后，
			// 再让模型结合问题、统计口径和查询结果生成自然语言回答。
			return {
				...report,
				status: 'answered',
				answer: await provider.explain(
					question,
					dataset.context,
					decision,
					result
				)
			}
		} catch (error) {
			// 模型解读失败不会影响已经成功执行的 SQL，
			// 因此保留真实查询结果供用户直接核对。
			return {
				...report,
				status: 'explanation_failed',
				answer: `SQL 已完成，模型解读失败：${error.message}。请先核对下方真实结果。`
			}
		}
	}
}

/** 打印口径、SQL 和真实行数据，并保存同一份报告，方便回查本次查询。 */
async function printAndSave(report) {
	console.log(`\n模式：${report.mode}\n问题：${report.question}`)
	console.log(`数据集：${report.datasetId} / ${report.version.slice(0, 12)}`)
	for (const [index, attempt] of report.attempts.entries()) {
		console.log(
			`\n第 ${index + 1} 次查询\n口径：${attempt.decision.metric}\n范围：${attempt.decision.scope}\n\n${attempt.decision.sql}`
		)
		if (attempt.error) console.log(`\n错误：${attempt.error}`)
	}
	if (report.result) {
		console.log('\n数据库返回：')
		console.table(report.result.rows)
	}
	console.log(`\n状态：${report.status}\n${report.answer}`)
	if (report.warning) console.log(`\n注意：${report.warning}`)
	const output = join(
		projectDir,
		'outputs',
		`${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`
	)
	await mkdir(join(projectDir, 'outputs'), { recursive: true })
	await writeFile(output, JSON.stringify(report, null, 2) + '\n')
	console.log(`\n本次记录：${output}`)
}

/**
 * 命令入口：准备数据，或选择 AI / Replay 发起一次自然语言查询。
 */
export async function main(args = process.argv.slice(2)) {
	// 第一个参数作为命令，其余参数作为命令对应的输入。
	const [command, ...rest] = args

	// prepare：初始化课程演示需要的数据集并输出基本信息。
	if (command === 'prepare') {
		const dataset = await prepareDataset()

		console.log(
			`数据已就绪：${dataset.databasePath}\n销售明细：${dataset.context.rowCount} 条；商品：2 个\n表：sales、products`
		)
		return
	}

	// 除数据准备外，只允许 demo（Replay）和 ask（真实 AI）两种查询模式。
	if (!['demo', 'ask'].includes(command)) {
		throw new Error(
			'用法：npm run prepare-data / npm run demo -- regions / npm run ask -- "问题"'
		)
	}

	// 查询阶段直接加载已经准备好的数据库及 Schema、统计口径等上下文。
	const dataset = await loadDataset()

	// demo 模式通过场景名选择预置案例，默认使用 regions。
	const name = rest[0] || 'regions'

	// demo 使用固定 Replay Provider 保证演示结果稳定；
	// ask 使用真实 AI Provider 调用 DeepSeek。
	const provider =
		command === 'demo' ? createReplayProvider(name) : createAIProvider()

	// Replay 模式读取预设问题；AI 模式直接使用命令行输入的自然语言问题。
	const question =
		command === 'demo' ? scenarios[name].question : rest.join(' ')

	// 真实模型调用前明确提示：会发送必要上下文，并产生 API 费用。
	if (command === 'ask') {
		console.log(
			'即将发送问题、Schema、统计口径及必要的查询结果给 DeepSeek，会产生 API 费用。'
		)
	}

	// 执行完整问答流程：生成 SQL、校验并执行，再根据真实查询结果生成答案。
	const report = await answerQuestion(question, dataset, provider)

	// 将最终报告输出到终端并保存。
	await printAndSave(report)

	// SQL 执行或最终解释失败时设置非零退出码，方便脚本或 CI 判断执行失败。
	if (['failed', 'explanation_failed'].includes(report.status)) {
		process.exitCode = 1
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(`\n执行失败：${error.message}`)
		process.exitCode = 1
	})
}
