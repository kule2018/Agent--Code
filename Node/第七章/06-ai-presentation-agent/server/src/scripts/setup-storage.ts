import 'dotenv/config'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { Pool } from 'pg'
import { DEFAULT_POSTGRES_URI } from '../presentation/presentation.repository.js'

const connectionString = process.env.POSTGRES_URI ?? DEFAULT_POSTGRES_URI
const pool = new Pool({ connectionString })
const checkpointer = PostgresSaver.fromConnString(connectionString)

try {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS presentations (
			id TEXT PRIMARY KEY,
			thread_id TEXT UNIQUE NOT NULL,
			data JSONB NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`)
	await checkpointer.setup()
	console.log('数据库与 LangGraph Checkpoint 表初始化完成。')
} finally {
	await pool.end()
	await checkpointer.end()
}

