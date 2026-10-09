import assert from 'node:assert/strict'
import { VoiceService, dependencies } from '../server/voice.service.js'
import { Turn } from '../server/turn.js'
import { scenarios } from '../../04-text-to-sql/replay.js'
import type { Packet } from '../shared/protocol.js'

// 只替换云端供应商；真实加载课程数据库、执行 Docker 查询，不产生 API 费用。
const packets: Packet[] = []
const deps = {
  ...dependencies,
  model: () => ({
    decide: async () => scenarios.regions.decisions[0],
    async *explain() { yield '本测试只检查数据库返回的金额。' }
  }),
  speak: async () => 'https://example.test/test-only-audio.wav'
}
await new VoiceService().answer(new Turn('integration', p => packets.push(p)),
  scenarios.regions.question, 'stream', deps as any)
assert.deepEqual(packets.find(p => p.event === 'query.result')?.data.rows, [
  { region: '华东', sales_amount: '1599.00' },
  { region: '华南', sales_amount: '798.00' }
])
assert.equal(packets.at(-1)?.event, 'done')
console.log('真实 Docker 查询通过：华东 1599.00，华南 798.00；模型和音频为测试替身。')
