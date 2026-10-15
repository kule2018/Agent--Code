import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AgentService, type TurnRun } from './agent.service.js'
import { EvaluationService } from './evaluation.service.js'
import { ModelService } from './model.service.js'
import { prepare, ToolsService } from './tools.service.js'
import { DATASET_VERSION, selectCases } from './cases.js'

@Module({
	providers: [AgentService, EvaluationService, ModelService, ToolsService]
})
class AppModule {}

/** 运行选定的测试样本，记录 Agent 行为，完成评测并保存报告。 */
async function main() {
	// 从命令行读取要运行的测试类型；未传入时，默认选择 injection。
	const samples = selectCases(process.argv[2] || 'injection')

	// 创建 Nest 应用上下文，使用依赖注入获取服务；不启动 HTTP 服务，关闭框架日志。
	const app = await NestFactory.createApplicationContext(AppModule, {
		logger: false
	})

	try {
		// 获取模型服务并检查配置，避免进入测试流程后才发现配置缺失。
		const model = app.get(ModelService)
		model.assertConfigured()

		const agent = app.get(AgentService)
		const evaluator = app.get(EvaluationService)

		console.log(
			'将调用真实答题模型与评分模型，会产生 API 费用。订单、记忆和退款全部为测试数据。'
		)

		// 为整批测试生成唯一标识，同时用于会话 ID 和报告文件名。
		const reportId = randomUUID()
		const reports = []

		for (const sample of samples) {
			console.log(`\n${sample.name}（${sample.id}）`)

			// 准备当前样本的测试环境，保存执行前的深拷贝快照。
			// 后续 world 发生变化时，不会影响 before 中保留的初始状态。
			const world = prepare(sample)
			const before = structuredClone(world)

			// 收集当前样本各次会话的运行记录，供评测与报告使用。
			const turns: TurnRun[] = []

			for (const [index, question] of sample.turns.entries()) {
				// 每次提问使用独立的会话 ID，但同一样本始终传入同一个 world。
				// 因此，新会话不等于重置测试环境，记忆、退款记录等状态可以继续保留。
				const threadId = `${reportId}:${sample.id}:thread-${index + 1}`
				console.log(`\n新会话 ${index + 1}：${question}`)
				// 每次调用 runTurn 都会创建新的消息数组，跨会话的记忆召回由 world 提供，而不是沿用上一次的消息历史。
				const turn = await agent.runTurn(world, question, threadId)
				turns.push(turn)

				// 展示本次召回的记忆，以及每次工具调用的名称、参数和结果代码。
				console.log('本次召回：', turn.recalledMemories)
				for (const call of turn.toolCalls) {
					console.log(
						`${call.name}(${JSON.stringify(call.arguments)}) → ${call.result.code}`
					)
				}

				// 同时观察回答与测试环境的实际状态，不能只凭回答判断是否发生了退款。
				console.log('回答：', turn.answer || turn.error)
				console.log('当前记忆：', world.memories)
				console.log('实际退款记录数：', world.refunds.length)

				// 出错时停止当前样本的后续会话，但仍保留已有记录，继续进行下面的评测。
				if (turn.status === 'error') break
			}

			// 将样本要求、执行前快照和运行记录交给评测服务。
			const evaluation = await evaluator.evaluate(sample, before, turns)

			// 用表格展示各项检查，区分安全检查和任务检查。
			console.table(
				evaluation.checks.map((check) => ({
					检查: check.name,
					类别: check.kind === 'safety' ? '安全' : '任务',
					结果: check.passed ? '通过' : '未通过'
				}))
			)

			// 只有评审完成后才读取评分结果；否则输出未完成评审的原因。
			if (evaluation.judge.status === 'completed') {
				console.log(
					'回答评审：',
					evaluation.judge.result.passed ? '通过' : '未通过',
					evaluation.judge.result.reason
				)
			} else console.log('回答评审：', evaluation.judge.reason)

			console.log('本条样本最终结果：', evaluation.status)

			// 保存当前样本的输入、初始状态、运行过程与评测结果。
			reports.push({ sample, before, turns, evaluation })
		}

		// 按当前模块的位置定位 ../outputs/，而不是按命令行的工作目录定位。
		// recursive: true 允许创建多级目录，目录已存在时也不会因此报错。
		const directory = new URL('../outputs/', import.meta.url)
		await mkdir(directory, { recursive: true })
		const output = new URL(`${reportId}.json`, directory)

		// 记录数据集版本、模型设置与各样本结果，便于复查本次测试。
		const report = {
			reportId,
			createdAt: new Date().toISOString(),
			datasetVersion: DATASET_VERSION,
			models: model.settings(),
			reports
		}

		// 使用两空格缩进写入 JSON，方便直接打开阅读。
		await writeFile(output, JSON.stringify(report, null, 2))
		console.log(
			`\n完整输入、工具结果、会话快照与评分已保存：${fileURLToPath(output)}`
		)

		// 仅统计本次实际运行的样本，不将结果扩大为对全部场景的保证。
		console.log(
			`样本通过：${reports.filter((item) => item.evaluation.status === 'passed').length}/${reports.length}。仅代表本次所运行样本。`
		)

		// 任一样本未通过，就将进程退出码设为 1，方便脚本或 CI 判断测试失败。
		// 设置 exitCode 不会立即终止进程，后面的清理逻辑仍会执行。
		if (reports.some((item) => item.evaluation.status !== 'passed'))
			process.exitCode = 1
	} finally {
		// 无论测试成功还是中途抛出异常，都关闭 Nest 应用上下文。
		await app.close()
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
