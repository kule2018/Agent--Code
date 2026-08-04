import { Injectable } from '@nestjs/common'
import type { AgentRun } from './agent.types'
import { getScenario } from './scenarios'

const TOOL_GUIDE = [
	{ name: 'list_files', arguments: {}, purpose: '列出隔离工作区文件' },
	{ name: 'search_code', arguments: { query: '搜索词' }, purpose: '搜索代码引用' },
	{ name: 'read_file', arguments: { path: '相对路径' }, purpose: '读取一个文本文件' },
	{
		name: 'apply_patch',
		arguments: {
			path: '相对路径',
			replacements: [{ search: '文件中唯一存在的原文', replacement: '替换后的完整内容' }]
		},
		purpose: '使用唯一字符串匹配修改文件；必须先 read_file'
	},
	{ name: 'delete_file', arguments: { path: '相对路径' }, purpose: '删除文件，会触发人工审批' },
	{ name: 'run_tests', arguments: {}, purpose: '运行测试，失败结果也是有效 Observation' },
	{ name: 'run_typecheck', arguments: {}, purpose: '运行 TypeScript 类型检查' },
	{ name: 'run_lint', arguments: {}, purpose: '运行代码风格检查' },
	{ name: 'run_build', arguments: {}, purpose: '构建项目' },
	{ name: 'get_git_diff', arguments: {}, purpose: '读取相对初始代码的 Diff 和文件变化' }
]

/** 将 Runtime 状态整理成模型每一轮都能读懂的受控上下文。 */
@Injectable()
export class AgentContextService {
	build(run: AgentRun): string {
		const scenario = getScenario(run.scenarioId)

		return JSON.stringify(
			{
				task: {
					title: run.title,
					requirement: run.requirement,
					completionCriteria: run.completionCriteria,
					category: scenario.category
				},
				workspacePolicy: scenario.workspacePolicy,
				plan: run.plan,
				budget: { limits: run.limits, usage: run.usage },
				verification: run.verification,
				tools: TOOL_GUIDE,
				observations: run.observations.slice(-14).map((item) => ({
					id: item.id,
					toolName: item.toolName,
					summary: item.summary,
					data: clipStrings(item.data)
				})),
				failures: run.failures.slice(-5),
				recentActions: run.trace
					.filter((item) => item.type === 'decision' || item.type === 'recovery')
					.slice(-8)
					.map((item) => ({
						type: item.type,
						summary: item.summary,
						toolName: item.toolName,
						data: clipStrings(item.data ?? {})
					}))
			},
			null,
			2
		)
	}
}

function clipStrings(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.length > 10_000
			? `${value.slice(0, 10_000)}\n...内容已截断`
			: value
	}
	if (Array.isArray(value)) return value.map(clipStrings)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, item]) => [
				key,
				clipStrings(item)
			])
		)
	}
	return value
}
