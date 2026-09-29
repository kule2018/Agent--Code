import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CharactersSchema, OutlineSchema, ReviewSchema, SceneSchema, WorldSchema, type Brief } from './contracts.js'

const appRoot = resolve(process.cwd())
const root = join(appRoot, 'workspaces')
const skillSource = join(appRoot, 'server', 'skills')

/** 为每个项目提供真实文件目录，所有对外路径必须留在当前项目内。 */
@Injectable()
export class WorkspaceService {
  projectRoot(projectId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new BadRequestException('项目 ID 不合法。')
    return join(root, projectId)
  }

  path(projectId: string, virtualPath: string): string {
    if (!virtualPath.startsWith('/') || virtualPath.includes('\\') || virtualPath.includes('\0')) {
      throw new BadRequestException('文件路径不合法。')
    }
    const base = this.projectRoot(projectId)
    const filePath = resolve(base, '.' + virtualPath)
    if (!filePath.startsWith(base + sep)) throw new BadRequestException('不能访问项目外的文件。')
    return filePath
  }

  async prepare(projectId: string, revision: number, brief: Brief): Promise<void> {
    const base = this.projectRoot(projectId)
    await mkdir(this.path(projectId, `/revisions/${revision}/scenes`), { recursive: true })
    await mkdir(this.path(projectId, `/revisions/${revision}/reviews`), { recursive: true })
    await mkdir(this.path(projectId, '/staging'), { recursive: true })
    await mkdir(this.path(projectId, '/releases'), { recursive: true })
    await cp(skillSource, join(base, 'skills'), { recursive: true })
    await mkdir(join(base, 'contracts'), { recursive: true })
    for (const [name, schema] of [
      ['world', WorldSchema], ['characters', CharactersSchema], ['outline', OutlineSchema],
      ['scene', SceneSchema], ['review', ReviewSchema]
    ] as const) {
      await writeFile(join(base, 'contracts', `${name}.schema.json`), JSON.stringify(z.toJSONSchema(schema), null, 2))
    }
    await this.writeJson(projectId, `/revisions/${revision}/brief.json`, brief)
    await this.writeText(projectId, `/revisions/${revision}/brief.md`,
      `# ${brief.title}\n\n题材：${brief.genre}\n目标玩家：${brief.audience}\n\n${brief.premise}\n\n硬性规则：${brief.worldRules}\n\n角色 ${brief.characterCount} 名，场景 ${brief.sceneCount} 个，其中结局 ${brief.endingCount} 个。\n`)
  }

  async stage(projectId: string, taskId: string, names: string[]): Promise<string[]> {
    const paths = names.map((name) => `/staging/${taskId}/${name}`)
    await mkdir(this.path(projectId, `/staging/${taskId}`), { recursive: true })
    return paths
  }

  async readText(projectId: string, virtualPath: string): Promise<string> {
    const diskPath = this.path(projectId, virtualPath)
    try {
      const info = await lstat(diskPath)
      if (!info.isFile() || info.isSymbolicLink()) throw new BadRequestException('只允许读取普通文件。')
      return await readFile(diskPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException(`没有找到文件：${virtualPath}`)
      throw error
    }
  }

  async readJson(projectId: string, virtualPath: string): Promise<unknown> {
    try {
      return JSON.parse(await this.readText(projectId, virtualPath))
    } catch (error) {
      if (error instanceof SyntaxError) throw new BadRequestException(`文件不是合法 JSON：${virtualPath}`)
      throw error
    }
  }

  async writeText(projectId: string, virtualPath: string, content: string): Promise<void> {
    const diskPath = this.path(projectId, virtualPath)
    await mkdir(dirname(diskPath), { recursive: true })
    const temp = `${diskPath}.${randomUUID()}.tmp`
    await writeFile(temp, content, { flag: 'wx' })
    await rename(temp, diskPath)
  }

  async writeJson(projectId: string, virtualPath: string, value: unknown): Promise<void> {
    await this.writeText(projectId, virtualPath, JSON.stringify(value, null, 2))
  }

  async promote(projectId: string, staged: string, destination: string): Promise<void> {
    const data = await this.readText(projectId, staged)
    await this.writeText(projectId, destination, data)
  }

  async copyRevision(projectId: string, from: number, to: number): Promise<void> {
    await cp(this.path(projectId, `/revisions/${from}`), this.path(projectId, `/revisions/${to}`), { recursive: true, force: true })
  }

  async listFiles(projectId: string, revision: number): Promise<string[]> {
    const results: string[] = []
    const walk = async (path: string) => {
      for (const entry of await readdir(this.path(projectId, path), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const child = `${path}/${entry.name}`
        if (entry.isDirectory()) await walk(child)
        else if (entry.isFile() && /\.(md|json)$/.test(entry.name)) results.push(child)
      }
    }
    await walk(`/revisions/${revision}`)
    return results.sort()
  }

  async discardStage(projectId: string, taskId: string): Promise<void> {
    await rm(this.path(projectId, `/staging/${taskId}`), { recursive: true, force: true })
  }
}
