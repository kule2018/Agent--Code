import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { Pool } from 'pg'
import type { Presentation } from './presentation.types.js'
import { restorePresentationTheme } from './presentation-theme.js'

export const DEFAULT_POSTGRES_URI =
	'postgresql://presentation_course:presentation_course@localhost:5436/presentation_agent'

/** 使用 JSONB 持久化完整领域对象，方便课程聚焦工作流与业务规则。 */
@Injectable()
export class PresentationRepository implements OnModuleDestroy {
	private readonly pool = new Pool({
		connectionString: process.env.POSTGRES_URI ?? DEFAULT_POSTGRES_URI
	})

	async setup(): Promise<void> {
		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS presentations (
				id TEXT PRIMARY KEY,
				thread_id TEXT UNIQUE NOT NULL,
				data JSONB NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`)
	}

	// 保存演示文稿聚合状态到数据库
	async save(presentation: Presentation): Promise<void> {
		// 执行数据库写入操作，将领域对象转换为可持久化的数据结构
		await this.pool.query(
			// 使用 PostgreSQL 的 UPSERT 语法：
			// 如果 id 不存在则执行 INSERT，
			// 如果 id 已存在则执行 UPDATE，保证同一个任务只维护最新状态。
			`INSERT INTO presentations (id, thread_id, data, created_at, updated_at)
		 VALUES ($1, $2, $3::jsonb, $4, $5)
		 ON CONFLICT (id) DO UPDATE
		 SET thread_id = EXCLUDED.thread_id,
		     data = EXCLUDED.data,
		     updated_at = EXCLUDED.updated_at`,

			[
				// 演示文稿唯一 ID，用于定位具体制作任务
				presentation.id,

				// LangGraph 工作流对应的 thread_id，
				// 用于后续恢复 Agent 执行状态
				presentation.threadId,

				// 将完整领域对象序列化为 JSON，
				// 保存演示文稿需求、大纲、状态等业务数据
				JSON.stringify(presentation),

				// 创建时间
				presentation.createdAt,

				// 最近更新时间
				presentation.updatedAt
			]
		)
	}

	async findById(id: string): Promise<Presentation | null> {
		const result = await this.pool.query<{ data: Presentation }>(
			'SELECT data FROM presentations WHERE id = $1',
			[id]
		)
		const data = result.rows[0]?.data
		return data
			? {
					...data,
					modelMode: data.modelMode ?? 'replay',
					theme: restorePresentationTheme(data.theme),
					pages: data.pages.map((page) => ({
						...page,
						styleOverride: page.styleOverride ?? null
					}))
				}
			: null
	}

	async list(): Promise<Presentation[]> {
		const result = await this.pool.query<{ data: Presentation }>(
			'SELECT data FROM presentations ORDER BY updated_at DESC'
		)
		return result.rows.map((row) => ({
			...row.data,
			modelMode: row.data.modelMode ?? 'replay',
			theme: restorePresentationTheme(row.data.theme),
			pages: row.data.pages.map((page) => ({
				...page,
				styleOverride: page.styleOverride ?? null
			}))
		}))
	}

	async ping(): Promise<void> {
		await this.pool.query('SELECT 1')
	}

	async onModuleDestroy(): Promise<void> {
		await this.pool.end()
	}
}
