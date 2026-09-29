import { ConflictException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common'
import { Pool } from 'pg'
import type { Project, ProjectEvent } from './project.js'

export const DEFAULT_POSTGRES_URI = 'postgresql://story_course:story_course@127.0.0.1:5437/story_agent'

/** 只保存项目状态与事件；故事正文留在 Workspace 中。 */
@Injectable()
export class ProjectRepository implements OnModuleDestroy {
  private readonly pool = new Pool({ connectionString: process.env.POSTGRES_URI ?? DEFAULT_POSTGRES_URI })

  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS story_projects (
        id uuid PRIMARY KEY,
        version integer NOT NULL,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS story_events (
        id bigserial PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES story_projects(id) ON DELETE CASCADE,
        kind text NOT NULL,
        message text NOT NULL,
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS story_events_project_id_id ON story_events(project_id, id);
    `)
  }

  async create(project: Project): Promise<Project> {
    await this.pool.query('INSERT INTO story_projects (id, version, data) VALUES ($1, $2, $3)',
      [project.id, project.version, JSON.stringify(project)])
    return project
  }

  async get(id: string): Promise<Project> {
    const result = await this.pool.query('SELECT data FROM story_projects WHERE id = $1', [id])
    if (!result.rows.length) throw new NotFoundException('项目不存在。')
    return result.rows[0].data as Project
  }

  async list(): Promise<Project[]> {
    const result = await this.pool.query('SELECT data FROM story_projects ORDER BY updated_at DESC LIMIT 50')
    return result.rows.map((row) => row.data as Project)
  }

  /** 用版本号阻止旧请求或迟到任务覆盖当前项目。 */
  async save(project: Project): Promise<Project> {
    const next = { ...project, version: project.version + 1, updatedAt: new Date().toISOString() }
    const result = await this.pool.query(
      'UPDATE story_projects SET version = $3, data = $4, updated_at = now() WHERE id = $1 AND version = $2 RETURNING id',
      [project.id, project.version, next.version, JSON.stringify(next)]
    )
    if (!result.rowCount) throw new ConflictException('项目状态已变化，请刷新后重试。')
    return next
  }

  async event(projectId: string, kind: string, message: string, detail: Record<string, unknown> = {}): Promise<ProjectEvent> {
    const result = await this.pool.query(
      `INSERT INTO story_events (project_id, kind, message, detail)
       VALUES ($1, $2, $3, $4)
       RETURNING id, project_id AS "projectId", kind, message, detail, created_at AS "createdAt"`,
      [projectId, kind, message, JSON.stringify(detail)]
    )
    const row = result.rows[0]
    return { ...row, id: Number(row.id), createdAt: new Date(row.createdAt).toISOString() } as ProjectEvent
  }

  async events(projectId: string, afterId = 0): Promise<ProjectEvent[]> {
    const result = await this.pool.query(
      `SELECT id, project_id AS "projectId", kind, message, detail, created_at AS "createdAt"
       FROM story_events WHERE project_id = $1 AND id > $2 ORDER BY id LIMIT 300`,
      [projectId, afterId]
    )
    return result.rows.map((row) => ({
      ...row, id: Number(row.id), createdAt: new Date(row.createdAt).toISOString()
    }) as ProjectEvent)
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end()
  }
}
