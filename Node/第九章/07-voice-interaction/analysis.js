import { loadDataset } from '../04-text-to-sql/dataset.js'
import { createAIProvider } from '../04-text-to-sql/model.js'
import { answerQuestion } from '../04-text-to-sql/text-to-sql.js'
import { runSandbox } from '../05-restricted-execution/sandbox.js'

/** 复用 05 的受限容器执行 SQL；权限或超时错误不触发反复尝试。 */
export async function executeInSandbox(databasePath, sql) {
	const execution = await runSandbox({ kind: 'sql', sql }, { databasePath })
	if (execution.status !== 'completed' || !execution.cleanedUp) {
		throw new Error(execution.error || '查询未完成，或容器清理未完成。')
	}
	return { rows: execution.result.rows, truncated: false }
}

/** ASR 和键盘输入共用文字分析入口，模型继续根据真实 SQL 结果回答。 */
export async function analyze(question, options = {}) {
	// 加载当前数据集，优先使用外部传入的数据集
	const dataset = options.dataset || (await loadDataset())

	// 创建 AI 模型调用对象，支持外部传入自定义 Provider
	const provider = options.provider || createAIProvider()

	// 执行完整分析流程：生成 SQL、在受限环境中查询数据、根据真实结果生成回答
	const report = await answerQuestion(
		question,
		dataset,
		provider,
		options.execute || executeInSandbox
	)

	// 获取最后一次查询尝试，用于提取 SQL 和统计口径等信息
	const last = report.attempts.at(-1)

	// 整理分析结果，统一返回给前端展示及后续 TTS 语音合成
	return {
		// 本次分析状态及模型生成的最终回答
		status: report.status,
		answer: report.answer,

		// 选择适合语音朗读的文本，可能与页面展示的完整回答不同
		speechText: selectSpeechText(report),

		// 返回实际生成的 SQL 和数据库查询结果
		sql: last?.decision.sql || '',
		rows: report.result?.rows || [],

		// 返回分析过程中的警告信息
		warning: report.warning || '',

		// 返回数据集标识和版本，便于追溯回答的数据来源
		datasetId: report.datasetId,
		version: report.version,

		// 返回本次查询的统计指标和统计范围
		metric: last?.decision.metric || '',
		scope: last?.decision.scope || ''
	}
}

/** 短回答直接朗读；长回答保留全文，使用明确的查看提示，避免截断数字或限制条件。 */
export function selectSpeechText(report) {
	if (['failed', 'explanation_failed'].includes(report.status)) {
		return '本次分析没有完整完成，请查看页面上的错误信息和已有查询结果。'
	}
	if ([...report.answer].length <= 500) return report.answer
	return '本次回答较长，完整结论和查询结果已经展示在页面上，请查看文字内容。'
}
