import { Injectable } from '@nestjs/common'
import { loadDataset } from '../../04-text-to-sql/dataset.js'
import { executeInSandbox } from '../../07-voice-interaction/analysis.js'
import { synthesize } from '../../07-voice-interaction/speech.js'
import { AnalysisModel } from './model.js'
import { SentenceBuffer } from './sentences.js'
import { Turn } from './turn.js'
import type { Mode } from '../shared/protocol.js'

export const dependencies = {
	load: loadDataset,
	model: () => new AnalysisModel(),
	execute: executeInSandbox,
	speak: (text: string, signal: AbortSignal) =>
		synthesize(text, {
			fetchImpl: (url: any, options: any) =>
				fetch(url, {
					...options,
					signal: AbortSignal.any([signal, options.signal])
				})
		})
}

/** 复用真实数据查询，根据执行结果生成回答，并将文字和语音分段发送给浏览器。 */
@Injectable()
export class VoiceService {
	async answer(turn: Turn, question: string, mode: Mode, deps = dependencies) {
		// 获取当前轮次的取消信号，并创建模型实例。
		const signal = turn.signal
		const model = deps.model()

		// 加载当前数据集，为后续 SQL 生成和执行准备数据。
		turn.send('status', { text: '正在准备查询' })
		const dataset = await deps.load()
		signal.throwIfAborted()

		// 让模型根据用户问题和数据集信息决定执行什么查询。
		const decision = await model.decide(question, dataset.context, signal)
		signal.throwIfAborted()

		// 如果问题存在歧义，直接返回澄清问题，不执行 SQL。
		if (decision.action === 'clarify') {
			turn.send('answer.delta', { text: decision.question })
			turn.send('done')
			return
		}

		// 在受限执行环境中运行模型生成的 SQL。
		turn.send('status', { text: '正在执行受限查询' })

		// 既有容器执行器没有接入 AbortSignal；查询结束后必须再次检查本轮是否还有效。
		const result = await deps.execute(dataset.databasePath, decision.sql)
		signal.throwIfAborted()

		// 将实际执行的 SQL、查询结果和统计口径发送给浏览器。
		turn.send('query.result', {
			sql: decision.sql,
			rows: result.rows,
			metric: decision.metric,
			scope: decision.scope
		})

		// 查询结果为空时直接结束，避免模型把空结果解释为销售额为零。
		if (!result.rows.length) {
			turn.send('answer.delta', {
				text: '没有符合条件的记录，空结果不代表销售额为零。'
			})
			turn.send('done')
			return
		}

		turn.send('status', { text: '正在生成回答与语音' })

		// 将模型持续返回的文字按完整句子切分，供流式语音合成使用。
		const sentences = new SentenceBuffer()

		// 保存完整回答、音频片段序号和语音合成任务队列。
		let answer = ''
		let sequence = 0
		let synthesis = Promise.resolve()

		// 将完整句子加入语音合成队列，按照顺序逐句合成。
		const enqueue = (text: string) => {
			// 每个音频片段分配唯一序号，方便浏览器按顺序播放。
			const seq = sequence++

			// 限制最多生成 24 个音频片段，避免回答被过度拆分。
			if (seq >= 24) throw new Error('回答分段过多，已停止本轮')

			// 单并发合成，后一句等待前一句完成；文字流仍可继续接收。
			synthesis = synthesis
				.then(async () => {
					// 合成前检查当前轮次是否已被取消。
					signal.throwIfAborted()

					// 将当前句子交给 TTS，获取对应的音频播放地址。
					const audioUrl = await deps.speak(text, signal)
					signal.throwIfAborted()

					// 把音频序号、对应文字和播放地址发送给浏览器。
					turn.send('audio.segment', { seq, text, audioUrl })
				})
				.catch((error) => {
					// 单段合成失败时发送警告，不中断后续句子的合成。
					if (!signal.aborted) {
						turn.send('audio.warning', {
							text: `第 ${seq + 1} 段合成失败：${error.message}`
						})
					}
				})
		}

		try {
			// 流式读取模型生成的解释文字，每次 delta 是新生成的一部分。
			for await (const delta of model.explain(
				question,
				dataset.context,
				decision,
				result,
				signal
			)) {
				signal.throwIfAborted()

				// 累计完整回答，并限制本例的最大回答长度。
				answer += delta
				if (answer.length > 600) {
					throw new Error('回答超过本例长度上限')
				}

				if (mode === 'stream') {
					// 流式模式：模型生成多少文字，浏览器就先显示多少。
					turn.send('answer.delta', { text: delta })

					// 将新文字放入句子缓冲区，完整句子立即进入 TTS 队列。
					// 不需要等待整个回答生成完毕。
					for (const sentence of sentences.push(delta)) {
						enqueue(sentence)
					}
				}
			}

			// 模型生成结束后，检查任务状态及最终回答是否有效。
			signal.throwIfAborted()
			if (!answer.trim()) throw new Error('模型返回了空回答')

			if (mode === 'buffered') {
				// 非流式模式：等待完整回答生成后，一次性发送文字。
				turn.send('answer.delta', { text: answer })

				// 将整个回答作为一个音频片段进行合成。
				enqueue(answer)
			} else {
				// 流式模式：处理句子缓冲区中尚未输出的最后一部分文字。
				for (const sentence of sentences.flush()) {
					enqueue(sentence)
				}
			}

			// 通知浏览器文字已经全部生成，但语音合成可能仍在进行。
			turn.send('text.done')

			// 等待队列中的所有语音片段完成合成。
			await synthesis
			signal.throwIfAborted()

			// 文字生成和语音合成都处理完毕，通知浏览器本轮结束。
			turn.send('done')
		} catch (error) {
			// 已经发送的文字保留为部分结果；取消尚未完成的语音工作。
			turn.send('error', { text: (error as Error).message })
			turn.cancel()

			// 等待当前语音合成队列完成清理，避免遗留异步任务。
			await synthesis

			// 将错误继续抛给上层处理。
			throw error
		}
	}
}
