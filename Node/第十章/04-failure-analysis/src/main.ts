import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
	EvaluationService,
	RUBRIC_VERSION
} from '../../03-automatic-scoring/src/evaluation.service.js'
import { ModelService } from '../../03-automatic-scoring/src/model.service.js'
import { loadCase } from '../../03-automatic-scoring/src/sample.js'
import { TracedAgentService, type Variant } from './agent.service.js'
import { TracedModelService } from './model.service.js'
import { printReport, type Report } from './report.js'
import { TraceService } from './trace.service.js'

@Module({
	providers: [
		TraceService,
		TracedModelService,
		TracedAgentService,
		EvaluationService,
		{ provide: ModelService, useExisting: TracedModelService }
	]
})
export class AppModule {}

async function main() {
	// 从命令行读取实验类型：
	// wrong-unit：模拟应用中间处理数据错误的情况。
	// fixed：修复错误后的正常流程。
	// repeat：重复运行实验，用于验证 Trace 是否能区分不同执行记录。
	const variant = process.argv[2] ?? 'wrong-unit'

	// 限制只能运行预设实验，避免传入未知模式导致结果不可比较。
	if (!['wrong-unit', 'fixed', 'repeat'].includes(variant))
		throw new Error('实验名称应为 wrong-unit、fixed 或 repeat。')

	// 创建 Nest 应用上下文。
	// 这里不启动 HTTP 服务，只加载依赖注入容器，方便直接调用 Service。
	const app = await NestFactory.createApplicationContext(AppModule, {
		logger: false
	})

	try {
		// 获取模型服务，并检查模型配置是否完整。
		// 后续 Agent 调用和评测都会真实请求模型，因此提前校验配置。
		const model = app.get(TracedModelService)
		model.assertConfigured()

		// 加载本次实验使用的数据集、测试样本和模拟业务数据。
		// datasetVersion 用于记录当前测试数据版本，保证结果可追溯。
		const { datasetVersion, sample, fixture } = loadCase()

		// 获取 Trace 服务，用于记录整个实验过程中的调用链。
		const trace = app.get(TraceService)

		// 获取带追踪能力的 Agent 服务。
		// Agent 执行过程中产生的模型调用、工具调用等都会被记录。
		const agent = app.get(TracedAgentService)

		// 获取评测服务，用于判断 Agent 输出是否符合预期。
		const evaluator = app.get(EvaluationService)

		console.log(
			'本次真实调用答题模型和评分模型，会产生 API 费用；故障由本例应用代码主动设置。'
		)

		// 记录一次 Agent 执行过程。
		// capture 会创建一个 Trace Span：
		// agent.run
		//   └── Agent 内部模型调用、工具调用等详细步骤
		//
		// 使用 structuredClone 复制输入数据，避免实验代码修改原始测试数据，
		// 保证每次运行都基于相同的初始状态。
		const run = await trace.capture(
			'agent.run',
			'agent',
			{
				inputs: sample.inputs,
				variant
			},
			() =>
				agent.run(
					structuredClone(sample.inputs),
					structuredClone(fixture.orders),
					variant as Variant
				)
		)

		// 记录评测过程。
		// 评测也属于一次独立执行，因此单独创建 Trace：
		// evaluation.run
		//
		// 输入包含：
		// - sample：测试要求和参考答案
		// - run：Agent 实际执行结果
		//
		// 评测服务会根据规则检查和模型判断，生成最终评分。
		const evaluation = await trace.capture(
			'evaluation.run',
			'evaluation',
			{
				sample,
				run
			},
			() => evaluator.evaluate(sample, run)
		)

		// 汇总本次实验完整报告。
		// 除了 Agent 结果和评测结果，还保存：
		// - 数据集版本
		// - 模型配置
		// - 参考答案
		// - Trace 执行链
		//
		// 这些信息可以帮助后续还原一次完整执行过程。
		const report: Report = {
			schemaVersion: 1,
			createdAt: new Date().toISOString(),
			caseId: sample.id,
			datasetVersion,
			fixtureId: fixture.id,
			rubricVersion: RUBRIC_VERSION,
			variant,
			models: model.settings(),
			reference: sample.referenceOutputs,
			run,
			evaluation,
			...trace.snapshot()
		}

		// 创建输出目录，用于保存实验结果。
		const directory = new URL('../outputs/', import.meta.url)
		await mkdir(directory, { recursive: true })

		// 格式化报告内容，方便人工查看和调试。
		const contents = JSON.stringify(report, null, 2)

		// 每次实验生成独立文件，保留完整历史。
		// latest.json 只保存最近一次结果，方便快速查看。
		await writeFile(
			new URL(`${variant}-${trace.traceId}.json`, directory),
			contents
		)

		await writeFile(new URL('latest.json', directory), contents)

		// 在控制台输出简要实验结果。
		printReport(report)

		// 输出完整 Trace 文件位置。
		console.log(`\n完整记录：outputs/${variant}-${trace.traceId}.json`)

		// 如果 Agent 执行失败或者评测过程失败，
		// 设置进程退出码，让 CI 或自动化脚本能够识别失败。
		if (['agent_error', 'evaluation_error'].includes(evaluation.status))
			process.exitCode = 1
	} finally {
		// 无论实验成功还是失败，都关闭 Nest 应用上下文，
		// 释放数据库连接、资源和后台任务。
		await app.close()
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
