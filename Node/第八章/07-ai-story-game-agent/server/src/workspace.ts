import {
	BadRequestException,
	Injectable,
	NotFoundException
} from '@nestjs/common'
import {
	cp,
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	writeFile
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
	CharactersSchema,
	OutlineSchema,
	ReviewSchema,
	SceneSchema,
	WorldSchema,
	type Brief
} from './contracts.js'

const appRoot = resolve(process.cwd())
const root = join(appRoot, 'workspaces')
const skillSource = join(appRoot, 'server', 'skills')

/** 为每个项目提供真实文件目录，所有对外路径必须留在当前项目内。 */
@Injectable()
export class WorkspaceService {
	projectRoot(projectId: string): string {
		if (!/^[0-9a-f-]{36}$/.test(projectId))
			throw new BadRequestException('项目 ID 不合法。')
		return join(root, projectId)
	}

	path(projectId: string, virtualPath: string): string {
		if (
			!virtualPath.startsWith('/') ||
			virtualPath.includes('\\') ||
			virtualPath.includes('\0')
		) {
			throw new BadRequestException('文件路径不合法。')
		}
		const base = this.projectRoot(projectId)
		const filePath = resolve(base, '.' + virtualPath)
		if (!filePath.startsWith(base + sep))
			throw new BadRequestException('不能访问项目外的文件。')
		return filePath
	}

	/** 初始化项目工作区，准备目录、Skill、产物契约和当前修订版本的制作要求。 */
	async prepare(
		projectId: string,
		revision: number,
		brief: Brief
	): Promise<void> {
		// 获取项目根目录，存放项目级的共享资料。
		const base = this.projectRoot(projectId)

		// 按修订版本分别保存场景和审核结果，避免不同修订版本的文件混在一起。
		// recursive: true 会自动创建缺失的父目录，目录已存在时也不会报错。
		await mkdir(this.path(projectId, `/revisions/${revision}/scenes`), {
			recursive: true
		})
		await mkdir(this.path(projectId, `/revisions/${revision}/reviews`), {
			recursive: true
		})

		// 创建项目级暂存目录和发布目录。
		await mkdir(this.path(projectId, '/staging'), { recursive: true })
		await mkdir(this.path(projectId, '/releases'), { recursive: true })

		// 将预置 Skill 目录及其内容复制到项目工作区，供 Agent 读取使用。
		await cp(skillSource, join(base, 'skills'), { recursive: true })

		// 创建产物契约目录，用于保存各类交付文件的结构定义。
		await mkdir(join(base, 'contracts'), { recursive: true })

		// 将世界观、角色、大纲、场景和审核结果的 Zod Schema 转为 JSON Schema，
		// 让工作区中的契约文件明确描述各类产物应包含的字段与结构约束。
		for (const [name, schema] of [
			['world', WorldSchema],
			['characters', CharactersSchema],
			['outline', OutlineSchema],
			['scene', SceneSchema],
			['review', ReviewSchema]
		] as const) {
			await writeFile(
				join(base, 'contracts', `${name}.schema.json`),
				JSON.stringify(z.toJSONSchema(schema), null, 2)
			)
		}

		// 保存结构化制作要求，保留完整字段，便于程序后续读取。
		await this.writeJson(projectId, `/revisions/${revision}/brief.json`, brief)

		// 同时生成 Markdown 版本，将题材、目标玩家、故事前提、硬性规则
		// 和角色／场景／结局数量整理为文本，便于 Agent 阅读。
		await this.writeText(
			projectId,
			`/revisions/${revision}/brief.md`,
			`# ${brief.title}\n\n题材：${brief.genre}\n目标玩家：${brief.audience}\n\n${brief.premise}\n\n硬性规则：${brief.worldRules}\n\n角色 ${brief.characterCount} 名，场景 ${brief.sceneCount} 个，其中结局 ${brief.endingCount} 个。\n`
		)
	}

	async stage(
		projectId: string,
		taskId: string,
		names: string[]
	): Promise<string[]> {
		const paths = names.map((name) => `/staging/${taskId}/${name}`)
		await mkdir(this.path(projectId, `/staging/${taskId}`), { recursive: true })
		return paths
	}

	async readText(projectId: string, virtualPath: string): Promise<string> {
		const diskPath = this.path(projectId, virtualPath)
		try {
			const info = await lstat(diskPath)
			if (!info.isFile() || info.isSymbolicLink())
				throw new BadRequestException('只允许读取普通文件。')
			return await readFile(diskPath, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				throw new NotFoundException(`没有找到文件：${virtualPath}`)
			throw error
		}
	}

	async readJson(projectId: string, virtualPath: string): Promise<unknown> {
		try {
			return JSON.parse(await this.readText(projectId, virtualPath))
		} catch (error) {
			if (error instanceof SyntaxError)
				throw new BadRequestException(`文件不是合法 JSON：${virtualPath}`)
			throw error
		}
	}

	async writeText(
		projectId: string,
		virtualPath: string,
		content: string
	): Promise<void> {
		const diskPath = this.path(projectId, virtualPath)
		await mkdir(dirname(diskPath), { recursive: true })
		const temp = `${diskPath}.${randomUUID()}.tmp`
		await writeFile(temp, content, { flag: 'wx' })
		await rename(temp, diskPath)
	}

	async writeJson(
		projectId: string,
		virtualPath: string,
		value: unknown
	): Promise<void> {
		await this.writeText(projectId, virtualPath, JSON.stringify(value, null, 2))
	}

	async promote(
		projectId: string,
		staged: string,
		destination: string
	): Promise<void> {
		const data = await this.readText(projectId, staged)
		await this.writeText(projectId, destination, data)
	}

	async copyRevision(
		projectId: string,
		from: number,
		to: number
	): Promise<void> {
		await cp(
			this.path(projectId, `/revisions/${from}`),
			this.path(projectId, `/revisions/${to}`),
			{ recursive: true, force: true }
		)
	}

	async listFiles(projectId: string, revision: number): Promise<string[]> {
		const results: string[] = []
		const walk = async (path: string) => {
			for (const entry of await readdir(this.path(projectId, path), {
				withFileTypes: true
			})) {
				if (entry.isSymbolicLink()) continue
				const child = `${path}/${entry.name}`
				if (entry.isDirectory()) await walk(child)
				else if (entry.isFile() && /\.(md|json)$/.test(entry.name))
					results.push(child)
			}
		}
		await walk(`/revisions/${revision}`)
		return results.sort()
	}

	async discardStage(projectId: string, taskId: string): Promise<void> {
		await rm(this.path(projectId, `/staging/${taskId}`), {
			recursive: true,
			force: true
		})
	}
}
