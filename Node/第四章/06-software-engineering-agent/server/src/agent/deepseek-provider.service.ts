import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type {
	AgentDecision,
	AgentRun,
	ProviderResult,
	ToolName
} from './agent.types'
import { AgentContextService } from './agent-context.service'

const DEFAULT_API_URL = 'https://api.deepseek.com/chat/completions'
const DEFAULT_MODEL = 'deepseek-v4-flash'
const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 300
const REQUEST_TIMEOUT_MS = 60_000

const SYSTEM_PROMPT = `你是一个在受控 Runtime 中工作的软件开发 Agent。

你的职责是根据自然语言需求、当前 Plan 和工具 Observation，每轮只提出一个决策。真正的文件读写、命令执行、预算、审批和完成校验都由 Runtime 负责。

必须遵守：
1. 修改代码以前先读取相关文件，不能猜测文件内容。
2. 只能使用上下文 tools 中列出的工具，不能提出 shell 命令或任意网络请求。
3. apply_patch 的 search 必须完整复制 read_file 返回的唯一原文。
4. 不得修改测试文件，不得越过 workspacePolicy 的可写和可删除路径。
5. 测试失败是 Observation，不等于工具执行失败。根据失败信息继续分析。
6. overdue-boundary 场景第一次测试失败后，必须先返回 replan，并在 evidenceIds 中引用失败 Observation 的 id。
7. 只有计划步骤、代码修改、测试、类型检查和 Diff 都满足完成条件时，才能返回 final。
8. reasoning 只写一句可审计的决策依据，不输出内部思维过程。

只返回一个 JSON 对象，不要 Markdown。允许三种结构：

Action：
{"type":"action","toolName":"read_file","arguments":{"path":"src/example.ts"},"stepId":"步骤ID","reasoning":"为什么现在调用它","completesStepIds":[]}

Replan：
{"type":"replan","reason":"新证据为什么推翻或补充原计划","evidenceIds":["Observation ID"],"cancelStepIds":[],"newSteps":[{"id":"新步骤ID","title":"标题","description":"做什么","dependsOn":["已有步骤ID"]}]}

Final：
{"type":"final","summary":"本次修改和验证结果"}`

interface ChatCompletionResponse {
	choices?: Array<{
		message?: { content?: string | null; reasoning_content?: string | null }
	}>
	usage?: {
		prompt_tokens?: number
		completion_tokens?: number
		total_tokens?: number
	}
	error?: { message?: string }
}

@Injectable()
export class DeepSeekProviderService {
	constructor(
		@Inject(AgentContextService)
		private readonly context: AgentContextService
	) {}

	isAvailable(): boolean {
		return Boolean(process.env.DEEPSEEK_API_KEY)
	}

	model(): string {
		return process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL
	}

	async next(run: AgentRun): Promise<ProviderResult> {
		const apiKey = process.env.DEEPSEEK_API_KEY
		if (!apiKey) {
			throw new Error('AI 模式需要 DEEPSEEK_API_KEY；未配置时请使用 Replay 模式。')
		}

		const startedAt = Date.now()
		let lastError: Error | null = null

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			try {
				const body = await this.request(apiKey, run)
				const content = body.choices?.[0]?.message?.content

				// DeepSeek 官方说明 JSON Output 偶尔可能返回空 content，因此有限重试。
				if (!content?.trim()) {
					throw new ProviderRequestError('DeepSeek 模型没有返回有效决策。', true)
				}

				return {
					decision: parseDecision(content),
					source: 'ai',
					model: this.model(),
					latencyMs: Date.now() - startedAt,
					usage: {
						promptTokens: body.usage?.prompt_tokens ?? 0,
						completionTokens: body.usage?.completion_tokens ?? 0,
						totalTokens: body.usage?.total_tokens ?? 0
					}
				}
			} catch (error) {
				lastError = toError(error)
				if (!isRetryable(error) || attempt === MAX_ATTEMPTS) throw lastError
				await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
			}
		}

		throw lastError ?? new Error('DeepSeek 模型调用失败。')
	}

	private async request(
		apiKey: string,
		run: AgentRun
	): Promise<ChatCompletionResponse> {
		let response: Response

		try {
			response = await fetch(process.env.DEEPSEEK_API_URL || DEFAULT_API_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					model: this.model(),
					messages: [
						{ role: 'system', content: SYSTEM_PROMPT },
						{ role: 'user', content: this.context.build(run) }
					],
					response_format: { type: 'json_object' },
					thinking: { type: 'enabled' },
					reasoning_effort: 'high',
					max_tokens: 4096,
					stream: false
				}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			})
		} catch (error) {
			throw new ProviderRequestError(
				`DeepSeek 网络请求失败：${toError(error).message}`,
				true
			)
		}

		let body: ChatCompletionResponse
		try {
			body = (await response.json()) as ChatCompletionResponse
		} catch {
			throw new ProviderRequestError(
				`DeepSeek 返回了无法解析的响应：HTTP ${response.status}`,
				response.status === 429 || response.status >= 500
			)
		}

		if (!response.ok) {
			throw new ProviderRequestError(
				`DeepSeek 模型调用失败：${response.status} ${body.error?.message ?? JSON.stringify(body)}`,
				response.status === 408 || response.status === 429 || response.status >= 500
			)
		}

		return body
	}
}

class ProviderRequestError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean
	) {
		super(message)
		this.name = 'ProviderRequestError'
	}
}

function isRetryable(error: unknown): boolean {
	return error instanceof ProviderRequestError && error.retryable
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function parseDecision(content: string): AgentDecision {
	const normalized = content
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '')
	let value: Record<string, unknown>

	try {
		value = JSON.parse(normalized) as Record<string, unknown>
	} catch {
		throw new Error(`模型没有返回合法 JSON：${content.slice(0, 500)}`)
	}

	if (value.type === 'action') {
		return {
			type: 'action',
			action: {
				id: randomUUID(),
				toolName: value.toolName as ToolName,
				arguments: asRecord(value.arguments),
				stepId: asOptionalString(value.stepId),
				reasoning: asString(value.reasoning, 'reasoning'),
				completesStepIds: asOptionalStringArray(value.completesStepIds)
			}
		}
	}

	if (value.type === 'replan') {
		return {
			type: 'replan',
			reason: asString(value.reason, 'reason'),
			evidenceIds: asOptionalStringArray(value.evidenceIds),
			cancelStepIds: asOptionalStringArray(value.cancelStepIds),
			newSteps: Array.isArray(value.newSteps)
				? (value.newSteps as Array<{
						id: string
						title: string
						description: string
						dependsOn: string[]
					}>)
				: []
		}
	}

	if (value.type === 'final') {
		return { type: 'final', summary: asString(value.summary, 'summary') }
	}

	throw new Error(`模型返回了未知决策类型：${String(value.type)}`)
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	return value as Record<string, unknown>
}

function asString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`模型决策缺少 ${field}。`)
	}
	return value.trim()
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asOptionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	return value.filter((item): item is string => typeof item === 'string')
}
