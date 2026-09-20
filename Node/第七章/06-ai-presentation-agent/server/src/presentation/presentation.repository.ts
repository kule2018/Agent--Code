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

	async save(presentation: Presentation): Promise<void> {
		await this.pool.query(
			`INSERT INTO presentations (id, thread_id, data, created_at, updated_at)
			 VALUES ($1, $2, $3::jsonb, $4, $5)
			 ON CONFLICT (id) DO UPDATE
			 SET thread_id = EXCLUDED.thread_id,
			     data = EXCLUDED.data,
			     updated_at = EXCLUDED.updated_at`,
			[
				presentation.id,
				presentation.threadId,
				JSON.stringify(presentation),
				presentation.createdAt,
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
