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
  speak: (text: string, signal: AbortSignal) => synthesize(text, {
    fetchImpl: (url: any, options: any) => fetch(url, { ...options, signal: AbortSignal.any([signal, options.signal]) })
  })
}

/** 复用真实查询，再把解释文字和逐句合成结果持续发送给浏览器。 */
@Injectable()
export class VoiceService {
  async answer(turn: Turn, question: string, mode: Mode, deps = dependencies) {
    const signal = turn.signal
    const model = deps.model()
    turn.send('status', { text: '正在准备查询' })
    const dataset = await deps.load()
    signal.throwIfAborted()
    const decision = await model.decide(question, dataset.context, signal)
    signal.throwIfAborted()
    if (decision.action === 'clarify') {
      turn.send('answer.delta', { text: decision.question })
      turn.send('done')
      return
    }
    turn.send('status', { text: '正在执行受限查询' })
    // 既有容器执行器没有接入 AbortSignal；查询结束后必须再次检查本轮是否还有效。
    const result = await deps.execute(dataset.databasePath, decision.sql)
    signal.throwIfAborted()
    turn.send('query.result', { sql: decision.sql, rows: result.rows, metric: decision.metric, scope: decision.scope })
    if (!result.rows.length) {
      turn.send('answer.delta', { text: '没有符合条件的记录，空结果不代表销售额为零。' })
      turn.send('done')
      return
    }
    turn.send('status', { text: '正在生成回答与语音' })
    const sentences = new SentenceBuffer()
    let answer = ''
    let sequence = 0
    let synthesis = Promise.resolve()
    // 单并发合成，后一句等待前一句完成；文字流仍可继续接收。
    const enqueue = (text: string) => {
      const seq = sequence++
      if (seq >= 24) throw new Error('回答分段过多，已停止本轮')
      synthesis = synthesis.then(async () => {
        signal.throwIfAborted()
        const audioUrl = await deps.speak(text, signal)
        signal.throwIfAborted()
        turn.send('audio.segment', { seq, text, audioUrl })
      }).catch(error => {
        if (!signal.aborted) turn.send('audio.warning', { text: `第 ${seq + 1} 段合成失败：${error.message}` })
      })
    }
    try {
      for await (const delta of model.explain(question, dataset.context, decision, result, signal)) {
        signal.throwIfAborted()
        answer += delta
        if (answer.length > 600) throw new Error('回答超过本例长度上限')
        if (mode === 'stream') {
          turn.send('answer.delta', { text: delta })
          for (const sentence of sentences.push(delta)) enqueue(sentence)
        }
      }
      signal.throwIfAborted()
      if (!answer.trim()) throw new Error('模型返回了空回答')
      if (mode === 'buffered') {
        turn.send('answer.delta', { text: answer })
        enqueue(answer)
      } else {
        for (const sentence of sentences.flush()) enqueue(sentence)
      }
      turn.send('text.done')
      await synthesis
      signal.throwIfAborted()
      turn.send('done')
    } catch (error) {
      // 已经发送的文字保留为部分结果；取消尚未完成的语音工作。
      turn.send('error', { text: (error as Error).message })
      turn.cancel()
      await synthesis
      throw error
    }
  }
}
