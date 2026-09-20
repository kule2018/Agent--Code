import 'dotenv/config'
import { Pool } from 'pg'
import { DEFAULT_POSTGRES_URI } from '../presentation/presentation.repository.js'

const major = Number(process.versions.node.split('.')[0])
if (major < 20) throw new Error('需要 Node.js 20.19 或更高版本。')

const pool = new Pool({
	connectionString: process.env.POSTGRES_URI ?? DEFAULT_POSTGRES_URI
})

try {
	await pool.query('SELECT 1')
	console.log(`Node.js：${process.version}`)
	console.log('PostgreSQL：连接成功')
	console.log(`模型模式：${process.env.MODEL_MODE === 'ai' ? 'AI' : 'Replay'}`)
	if (process.env.MODEL_MODE === 'ai' && !process.env.DEEPSEEK_API_KEY) {
		throw new Error('AI 模式缺少 DEEPSEEK_API_KEY。')
	}
} finally {
	await pool.end()
}

