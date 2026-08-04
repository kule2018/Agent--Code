import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type {
	AgentRun,
	ToolAction,
	ToolName,
	ToolObservation
} from './agent.types'
import { CommandService } from './command.service'
import { WorkspaceService } from './workspace.service'

interface ToolDescriptor {
	name: ToolName
	description: string
	risk: 'low' | 'high'
}

const TOOLS: ToolDescriptor[] = [
	{ name: 'list_files', description: '列出工作区文件', risk: 'low' },
	{ name: 'search_code', description: '在工作区中搜索代码', risk: 'low' },
	{ name: 'read_file', description: '读取一个文本文件', risk: 'low' },
	{ name: 'apply_patch', description: '对文件执行唯一匹配替换', risk: 'low' },
	{ name: 'delete_file', description: '删除工作区文件', risk: 'high' },
	{ name: 'install_dependency', description: '安装白名单依赖', risk: 'high' },
	{ name: 'run_tests', description: '运行工作区测试', risk: 'low' },
	{ name: 'run_typecheck', description: '运行 TypeScript 类型检查', risk: 'low' },
	{ name: 'run_lint', description: '运行代码风格检查', risk: 'low' },
	{ name: 'run_build', description: '构建工作区代码', risk: 'low' },
	{ name: 'get_git_diff', description: '查看相对初始工作区的代码变化', risk: 'low' }
]

@Injectable()
export class ToolRegistryService {
	constructor(
		@Inject(WorkspaceService)
		private readonly workspaces: WorkspaceService,
		@Inject(CommandService)
		private readonly commands: CommandService
	) {}

	list(): ToolDescriptor[] {
		return TOOLS.map((item) => ({ ...item }))
	}

	requiresApproval(toolName: ToolName): boolean {
		return TOOLS.find((item) => item.name === toolName)?.risk === 'high'
	}

	async execute(run: AgentRun, action: ToolAction): Promise<ToolObservation> {
		const data = await this.executeTool(run, action)
		return {
			id: randomUUID(),
			actionId: action.id,
			toolName: action.toolName,
			ok: true,
			summary: summarize(action.toolName, data),
			data,
			evidenceKey: `${action.toolName}:${stableStringify(action.arguments)}:${run.usage.toolCalls}`,
			createdAt: new Date().toISOString()
		}
	}

	private async executeTool(
		run: AgentRun,
		action: ToolAction
	): Promise<Record<string, unknown>> {
		const args = action.arguments

		switch (action.toolName) {
			case 'list_files': {
				const files = await this.workspaces.listFiles(run.id)
				return { files, count: files.length }
			}
			case 'search_code': {
				const query = requireString(args.query, 'query')
				const matches = await this.workspaces.search(run.id, query)
				return { query, matches, count: matches.length }
			}
			case 'read_file': {
				const path = requireString(args.path, 'path')
				const content = await this.workspaces.read(run.id, path)
				run.usage.filesRead += 1
				return { path, content, lineCount: content.split('\n').length }
			}
			case 'apply_patch': {
				const path = requireString(args.path, 'path')
				const replacements = args.replacements as Array<{
					search: string
					replacement: string
				}>
				const result = await this.workspaces.applyReplacements(
					run.id,
					path,
					replacements
				)
				return { path, ...result }
			}
			case 'delete_file': {
				const path = requireString(args.path, 'path')
				await this.workspaces.delete(run.id, path)
				return { path, deleted: true }
			}
			case 'install_dependency':
				throw new Error('当前课程案例只演示依赖安装审批，不执行真实网络安装。')
			case 'run_tests':
				return { ...(await this.commands.runTests(run.id)) }
			case 'run_typecheck':
				return { ...(await this.commands.runTypecheck(run.id)) }
			case 'run_lint':
				return { ...(await this.commands.runLint(run.id)) }
			case 'run_build':
				return { ...(await this.commands.runBuild(run.id)) }
			case 'get_git_diff':
				return this.workspaces.getChanges(run.id)
			default:
				throw new Error(`不允许执行工具：${String(action.toolName)}`)
		}
	}
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${name} 必须是非空字符串。`)
	}
	return value
}

function summarize(toolName: ToolName, data: Record<string, unknown>): string {
	if (toolName === 'run_tests' || toolName === 'run_typecheck' || toolName === 'run_lint' || toolName === 'run_build') {
		return `${toolName} ${data.passed ? '通过' : '未通过'}，耗时 ${data.durationMs}ms。`
	}
	if (toolName === 'read_file') return `已读取 ${data.path}。`
	if (toolName === 'search_code') return `找到 ${data.count} 条代码匹配。`
	if (toolName === 'list_files') return `工作区包含 ${data.count} 个文件。`
	if (toolName === 'apply_patch') return `已修改 ${data.path}。`
	if (toolName === 'delete_file') return `已删除 ${data.path}。`
	if (toolName === 'get_git_diff') {
		const changed = (data.changedPaths as string[]).length
		const deleted = (data.deletedPaths as string[]).length
		return `Diff 包含 ${changed} 个修改文件和 ${deleted} 个删除文件。`
	}
	return `${toolName} 执行完成。`
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${key}:${stableStringify(item)}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}
