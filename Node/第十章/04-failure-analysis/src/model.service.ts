import { Inject, Injectable } from '@nestjs/common'
import OpenAI from 'openai'
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions'
import { ModelService } from '../../03-automatic-scoring/src/model.service.js'
import { TraceService } from './trace.service.js'

type Request = Pick<ChatCompletionCreateParamsNonStreaming, 'messages' | 'tools' | 'response_format'>

/** 沿用上一节的模型配置，额外记录真正发出的输入、返回值与 usage。 */
@Injectable()
export class TracedModelService extends ModelService {
  constructor(@Inject(TraceService) private readonly trace: TraceService) { super() }

  override async complete(role: 'agent' | 'judge', request: Request) {
    this.assertConfigured()
    const client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      timeout: 45_000,
      maxRetries: 0
    })
    const params = {
      ...request, model: this.settings()[role], stream: false as const,
      max_tokens: 1600, temperature: 0, thinking: { type: 'disabled' }
    }
    // 只保存请求正文，不能把客户端对象、认证头或环境变量写进 Trace。
    const result = await this.trace.capture(`${role}.model`, 'model', params, async () => {
      const response = await client.chat.completions.create(params)
      return {
        model: response.model,
        message: response.choices[0]?.message ?? null,
        finishReason: response.choices[0]?.finish_reason ?? null,
        usage: response.usage ?? null
      }
    })
    if (!result.message || !['stop', 'tool_calls'].includes(result.finishReason ?? '')) {
      throw new Error(`模型没有完整返回：${result.finishReason ?? 'empty_choices'}`)
    }
    return result.message
  }
}
