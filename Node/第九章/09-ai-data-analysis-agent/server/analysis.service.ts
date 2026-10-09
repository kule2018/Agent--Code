import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Storage } from './storage.js'
import { createAnalysisGraph } from './workflow.js'
import { reportHtml } from './report.js'
import type { Mode, Progress, Report, Session } from '../shared/types.js'

/** 固定会话的数据版本，保存追问条件与已完成报告；同一会话串行执行。 */
@Injectable()
export class AnalysisService {
  private busy = new Map<string, AbortSignal>()
  constructor(@Inject(Storage) readonly storage: Storage) {}
  async listSessions() {
    const names = await readdir(join(this.storage.directory, 'sessions')).catch(() => [] as string[])
    const sessions = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => this.storage.session(name.slice(0, -5))))
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async createSession(datasetId: string) {
    const dataset = await this.storage.dataset(datasetId)
    if (dataset.status !== 'ready') throw new Error('数据存在质量问题，请修改原表后重新上传')
    const session: Session = { id: randomUUID(), datasetId, title: dataset.name, createdAt: new Date().toISOString(), reports: [], lastSpec: null }
    await this.storage.saveSession(session)
    return session
  }
  async analyze(sessionId: string, question: string, mode: Mode, signal: AbortSignal, emit: (progress: Progress) => void) {
    if (this.busy.has(sessionId) && !this.busy.get(sessionId)!.aborted) throw new Error('本会话还有任务在运行，请等停止完成后再提问')
    this.busy.set(sessionId, signal)
    try {
      const session = await this.storage.session(sessionId)
      const dataset = await this.storage.dataset(session.datasetId)
      if (dataset.status !== 'ready') throw new Error('当前数据不允许查询')
      const graph = createAnalysisGraph({ question, dataset, session, mode, signal, emit, directory: this.storage.datasetDir(dataset.id) })
      const state = await graph.invoke({ decision: null, evidence: null, error: '', attempts: 0, report: null }, { signal, recursionLimit: 12 })
      signal.throwIfAborted()
      const report = state.report!
      session.reports.push(report)
      if (report.evidence) session.lastSpec = report.evidence.spec
      session.title = session.reports[0].question.slice(0, 32)
      await this.storage.saveSession(session)
      return report
    } finally { if (this.busy.get(sessionId) === signal) this.busy.delete(sessionId) }
  }
  async findReport(sessionId: string, reportId: string): Promise<Report> {
    const session = await this.storage.session(sessionId)
    const report = session.reports.find(r => r.id === reportId)
    if (!report) throw new Error('报告不存在')
    return report
  }
  async export(sessionId: string, reportId: string) {
    const report = await this.findReport(sessionId, reportId)
    const html = reportHtml(report)
    await this.storage.save(join(this.storage.directory, 'reports', `${report.id}.json`), report)
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(this.storage.directory, 'reports'), { recursive: true })
    await writeFile(join(this.storage.directory, 'reports', `${report.id}.html`), html)
    return html
  }
}
