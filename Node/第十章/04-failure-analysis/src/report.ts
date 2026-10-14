import type { Span } from './trace.service.js'
import type { Evaluation } from '../../03-automatic-scoring/src/evaluation.service.js'
import type { AgentResult } from '../../03-automatic-scoring/src/sample.js'

export interface Report {
  schemaVersion: 1
  traceId: string
  createdAt: string
  caseId: string
  datasetVersion: string
  fixtureId: string
  rubricVersion: string
  variant: string
  models: { agent: string; judge: string }
  reference: unknown
  run: AgentResult
  evaluation: Evaluation
  spans: Span[]
}

/** 缺失 usage 时保留未知，不把失败请求或未返回计量信息的请求按零 Token 计算。 */
export function summarize(spans: Span[], role: 'agent' | 'judge') {
  const models = spans.filter((span) => span.name === `${role}.model`)
  const usages = models.map((span) => (span.output as {
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  } | undefined)?.usage)
  const missing = usages.filter((usage) => !usage || ![
    usage.prompt_tokens, usage.completion_tokens, usage.total_tokens
  ].every((value) => typeof value === 'number')).length
  const sum = (key: 'prompt_tokens' | 'completion_tokens' | 'total_tokens') =>
    missing ? null : usages.reduce((total, usage) => total + usage![key]!, 0)
  return {
    modelCalls: models.length,
    modelMs: Math.round(models.reduce((total, span) => total + span.durationMs, 0)),
    inputTokens: sum('prompt_tokens'), outputTokens: sum('completion_tokens'),
    totalTokens: sum('total_tokens'), missingUsageCalls: missing
  }
}

/** 只列出可直接对照的事实，不自动声称已经定位所有根因。 */
export function printReport(report: Report) {
  console.log(`样本：${report.caseId}；实验：${report.variant}`)
  console.log(`Trace ID：${report.traceId}`)
  console.log(`回答：${report.run.answer || '未产生回答'}`)
  console.log(`评测结果：${report.evaluation.status}`)
  console.table(report.evaluation.rules)
  console.log('评分依据：', report.evaluation.judge.status === 'completed'
    ? report.evaluation.judge.result : report.evaluation.judge.reason)
  console.log('\n按开始时间查看执行步骤（父步骤耗时包含子步骤，不能再次相加）：')
  console.table(report.spans.map((span, index) => ({
    step: index + 1, name: span.name,
    parentStep: span.parentId ? report.spans.findIndex((parent) => parent.id === span.parentId) + 1 : '-',
    status: span.status, ms: span.durationMs
  })))
  for (const span of report.spans) {
    if (span.kind === 'tool') console.log('\n工具输入与实际返回：', JSON.stringify({ input: span.input, output: span.output }, null, 2))
    if (span.kind === 'transform') console.log('\n组装 Tool Message 前后：', JSON.stringify({ input: span.input, output: span.output }, null, 2))
    if (span.name === 'agent.model') {
      console.log('\n本次答题模型实际收到的 messages：', JSON.stringify((span.input as { messages: unknown }).messages, null, 2))
    }
    if (span.status === 'error') console.log(`异常步骤 ${span.name}：${span.error}`)
  }
  console.log('\n模型用量（null 表示未知，不是零）：')
  console.table([
    { role: 'Agent', ...summarize(report.spans, 'agent') },
    { role: 'Judge', ...summarize(report.spans, 'judge') }
  ])
}
