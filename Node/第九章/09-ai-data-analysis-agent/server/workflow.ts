import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AnalysisProvider, verificationSql } from './model.js'
import { executeQuery } from './sandbox.js'
import { buildReport } from './analysis.js'
import type { Dataset, Decision, Evidence, Mode, Progress, Report, Row, Session } from '../shared/types.js'

const Flow = Annotation.Root({
  decision: Annotation<Decision | null>(), evidence: Annotation<Evidence | null>(),
  error: Annotation<string>(), attempts: Annotation<number>(), report: Annotation<Report | null>()
})
export type QueryExecutor = typeof executeQuery

/** 从决策进入受限查询；错误最多反馈一次，完成后由真实结果生成报告。 */
export function createAnalysisGraph(options: {
  question: string; dataset: Dataset; session: Session; mode: Mode; directory: string;
  signal: AbortSignal; emit: (event: Progress) => void; provider?: AnalysisProvider; execute?: QueryExecutor
}) {
  const { question, dataset, session, mode, directory, signal, emit } = options
  const provider = options.provider || new AnalysisProvider()
  const execute = options.execute || executeQuery
  return new StateGraph(Flow)
    .addNode('decide', async state => {
      signal.throwIfAborted()
      emit({ stage: 'decide', message: state.error ? '根据查询错误修正计划' : '确认本轮指标、时间和区域' })
      const decision = await provider.decide(question, dataset, session, mode, signal, state.error)
      return { decision, attempts: state.attempts + 1, error: '' }
    })
    .addNode('query', async state => {
      const decision = state.decision!
      emit({ stage: 'query', message: '在只读容器中计算，并核对分析口径' })
      const started = performance.now()
      try {
        const rows = await execute(join(directory, 'data.duckdb'), decision.sql!, signal)
        if (mode === 'ai' && decision.sql!.trim() !== verificationSql(decision).trim()) {
          const verified = await execute(join(directory, 'data.duckdb'), verificationSql(decision), signal)
          if (canonical(rows) !== canonical(verified)) throw new Error(`模型 SQL 结果与已确认口径不一致。标准查询：${verificationSql(decision)}`)
        }
        const evidence: Evidence = { id: randomUUID(), sql: decision.sql!, rows, dataset, spec: decision.spec!, createdAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started) }
        return { evidence, error: '' }
      } catch (error) {
        signal.throwIfAborted()
        return { error: (error as Error).message }
      }
    })
    .addNode('prepare_report', state => {
      signal.throwIfAborted()
      emit({ stage: 'report', message: '从查询结果生成图表、说明与依据' })
      const report: Report = state.evidence ? buildReport(question, mode, state.evidence) : {
        id: randomUUID(), question, mode, status: state.decision?.route === 'clarify' ? 'clarify' : 'insufficient',
        answer: state.error ? `本轮未取得有效结果：${state.error}` : state.decision!.message,
        evidence: null, table: [], chart: null, notes: [], createdAt: new Date().toISOString()
      }
      return { report }
    })
    .addEdge(START, 'decide')
    .addConditionalEdges('decide', state => state.decision?.route === 'query' ? 'query' : 'prepare_report', ['query', 'prepare_report'])
    .addConditionalEdges('query', state => state.error && state.attempts < 2 ? 'decide' : 'prepare_report', ['decide', 'prepare_report'])
    .addEdge('prepare_report', END).compile()
}
function canonical(rows: Row[]) {
  return JSON.stringify(rows.map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, key === 'amount' ? Number(value) : value]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
}
