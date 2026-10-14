import { Injectable } from '@nestjs/common'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export interface Span {
  id: string
  parentId: string | null
  name: string
  kind: 'agent' | 'evaluation' | 'model' | 'tool' | 'transform'
  startedAt: string
  durationMs: number
  status: 'running' | 'completed' | 'error'
  input: unknown
  output?: unknown
  error?: string
}

/** 每个命令只运行一道题；同一题的 Agent 和评分过程存入同一份本地记录。 */
@Injectable()
export class TraceService {
  readonly traceId = randomUUID()
  readonly spans: Span[] = []
  private readonly parent = new AsyncLocalStorage<string>()

  async capture<T>(
    name: string,
    kind: Span['kind'],
    input: unknown,
    operation: () => T | Promise<T>
  ): Promise<T> {
    const span: Span = {
      id: randomUUID(), parentId: this.parent.getStore() ?? null,
      name, kind, startedAt: new Date().toISOString(), durationMs: 0,
      status: 'running', input: structuredClone(input)
    }
    this.spans.push(span)
    const start = performance.now()
    try {
      return await this.parent.run(span.id, async () => {
        const output = await operation()
        span.output = structuredClone(output)
        span.status = 'completed'
        return output
      })
    } catch (error) {
      span.status = 'error'
      span.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      span.durationMs = Math.round((performance.now() - start) * 100) / 100
    }
  }

  snapshot() {
    return { traceId: this.traceId, spans: structuredClone(this.spans) }
  }
}
