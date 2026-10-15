import { Injectable } from '@nestjs/common'
import OpenAI from 'openai'
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions'

type Request = Pick<ChatCompletionCreateParamsNonStreaming, 'messages' | 'tools' | 'response_format'>

@Injectable()
export class ModelService {
  assertConfigured() {
    if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('请先配置本节 .env，格式见 README.md。')
  }

  settings() {
    const agent = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
    return { agent, judge: process.env.JUDGE_MODEL || agent }
  }

  async complete(role: 'agent' | 'judge', request: Request) {
    this.assertConfigured()
    const client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      maxRetries: 0, timeout: 45_000
    })
    const completion = await client.chat.completions.create({
      ...request, model: this.settings()[role], stream: false,
      temperature: 0, max_tokens: 1600,
      ...{ thinking: { type: 'disabled' } }
    })
    const choice = completion.choices[0]
    if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) {
      throw new Error(`模型没有完整返回：${choice?.finish_reason || 'empty_choices'}`)
    }
    return choice.message
  }
}
