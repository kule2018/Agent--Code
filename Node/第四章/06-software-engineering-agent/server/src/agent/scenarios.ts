import type { ScenarioDefinition } from './agent.types'

const priorityFilter: ScenarioDefinition = {
	id: 'priority-filter',
	title: '实现任务优先级筛选',
	shortDescription: '分析现有 NestJS 任务模块，补齐 priority 查询参数并通过测试。',
	requirement:
		'为 GET /tasks 增加 priority 筛选能力，支持 low、medium、high，并保持已有 status 筛选兼容。',
	category: 'feature',
	overlay: 'priority-filter',
	completionCriteria: [
		'TaskFilters 支持 priority 字段',
		'TaskService 可以同时按 status 和 priority 筛选',
		'TaskController 接收 priority 查询参数',
		'全部测试和类型检查通过'
	],
	initialSteps: [
		{
			id: 'reproduce-and-inspect',
			title: '复现失败并分析任务模块',
			description: '运行测试，读取 Service、Controller 和类型定义。',
			dependsOn: []
		},
		{
			id: 'implement-filter',
			title: '实现 priority 筛选',
			description: '修改类型、业务逻辑和接口参数。',
			dependsOn: ['reproduce-and-inspect']
		},
		{
			id: 'verify-change',
			title: '验证代码改动',
			description: '运行测试、类型检查并检查最终 Diff。',
			dependsOn: ['implement-filter']
		}
	],
	workspacePolicy: {
		writablePaths: [
			'src/tasks/task.types.ts',
			'src/tasks/task.service.ts',
			'src/tasks/task.controller.ts'
		],
		deletablePaths: [],
		instructions: [
			'只实现 priority 查询筛选，不增加依赖或修改测试文件。',
			'保留已有 status 筛选行为，并允许两个筛选条件同时生效。',
			'修改前必须读取相关类型、Service 与 Controller。'
		]
	},
	playbook: [
		{
			type: 'action',
			toolName: 'run_tests',
			arguments: {},
			stepId: 'reproduce-and-inspect',
			reasoning: '先运行现有测试，确认新需求当前确实没有实现。'
		},
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'src/tasks/task.types.ts' },
			stepId: 'reproduce-and-inspect',
			reasoning: '先确认筛选参数和优先级类型的现有定义。'
		},
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'src/tasks/task.service.ts' },
			stepId: 'reproduce-and-inspect',
			reasoning: '检查任务列表当前如何应用 status 条件。'
		},
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'src/tasks/task.controller.ts' },
			stepId: 'reproduce-and-inspect',
			reasoning: '确认 Controller 当前接收哪些查询参数。',
			completesStepIds: ['reproduce-and-inspect']
		},
		{
			type: 'action',
			toolName: 'apply_patch',
			arguments: {
				path: 'src/tasks/task.types.ts',
				replacements: [
					{
						search: "export interface TaskFilters {\n\tstatus?: TaskStatus\n}",
						replacement:
							"export interface TaskFilters {\n\tstatus?: TaskStatus\n\tpriority?: TaskPriority\n}"
					}
				]
			},
			stepId: 'implement-filter',
			reasoning: '先让筛选参数类型支持 priority。'
		},
		{
			type: 'action',
			toolName: 'apply_patch',
			arguments: {
				path: 'src/tasks/task.service.ts',
				replacements: [
					{
						search:
							"\t\treturn this.tasks.filter((task) => {\n\t\t\treturn !filters.status || task.status === filters.status\n\t\t})",
						replacement:
							"\t\treturn this.tasks.filter((task) => {\n\t\t\tconst matchesStatus =\n\t\t\t\t!filters.status || task.status === filters.status\n\t\t\tconst matchesPriority =\n\t\t\t\t!filters.priority || task.priority === filters.priority\n\n\t\t\treturn matchesStatus && matchesPriority\n\t\t})"
					}
				]
			},
			stepId: 'implement-filter',
			reasoning: '把 status 和 priority 两个条件组合进列表过滤逻辑。'
		},
		{
			type: 'action',
			toolName: 'apply_patch',
			arguments: {
				path: 'src/tasks/task.controller.ts',
				replacements: [
					{
						search: "import type { TaskStatus } from './task.types'",
						replacement:
							"import type { TaskPriority, TaskStatus } from './task.types'"
					},
					{
						search:
							"\tlist(@Query('status') status?: TaskStatus) {\n\t\treturn this.taskService.list({ status })\n\t}",
						replacement:
							"\tlist(\n\t\t@Query('status') status?: TaskStatus,\n\t\t@Query('priority') priority?: TaskPriority\n\t) {\n\t\treturn this.taskService.list({ status, priority })\n\t}"
					}
				]
			},
			stepId: 'implement-filter',
			reasoning: '让 HTTP 接口把 priority 传给 TaskService。',
			completesStepIds: ['implement-filter']
		},
		{
			type: 'action',
			toolName: 'run_tests',
			arguments: {},
			stepId: 'verify-change',
			reasoning: '运行完整测试，确认筛选功能和已有行为都正确。'
		},
		{
			type: 'action',
			toolName: 'run_typecheck',
			arguments: {},
			stepId: 'verify-change',
			reasoning: '继续检查 Controller、Service 与类型定义是否一致。'
		},
		{
			type: 'action',
			toolName: 'get_git_diff',
			arguments: {},
			stepId: 'verify-change',
			reasoning: '检查最终修改范围是否只覆盖当前需求。',
			completesStepIds: ['verify-change']
		},
		{
			type: 'final',
			summary: 'priority 筛选已完成，原有 status 筛选保持兼容。'
		}
	],
	expected: {
		changedPaths: [
			'src/tasks/task.types.ts',
			'src/tasks/task.service.ts',
			'src/tasks/task.controller.ts'
		],
		requireTests: true,
		requireTypecheck: true
	}
}

const overdueBoundary: ScenarioDefinition = {
	id: 'overdue-boundary',
	title: '修复逾期时间边界错误',
	shortDescription: '根据失败测试定位 <= 边界错误，更新计划后完成修复。',
	requirement:
		'修复任务在截止时间刚好相等时被错误标记为逾期的问题，并保证完成任务永远不算逾期。',
	category: 'bugfix',
	overlay: 'overdue-boundary',
	completionCriteria: [
		'截止时间与当前时间相等时不算逾期',
		'超过截止时间后返回逾期',
		'完成状态的任务永远不算逾期',
		'测试和类型检查全部通过'
	],
	initialSteps: [
		{
			id: 'reproduce-failure',
			title: '复现边界测试失败',
			description: '运行测试获得具体失败信息。',
			dependsOn: []
		},
		{
			id: 'inspect-overdue',
			title: '检查逾期判断实现',
			description: '对照测试阅读日期比较逻辑。',
			dependsOn: ['reproduce-failure']
		},
		{
			id: 'verify-overdue',
			title: '验证修复结果',
			description: '运行测试、类型检查并检查 Diff。',
			dependsOn: ['inspect-overdue']
		}
	],
	workspacePolicy: {
		writablePaths: ['src/tasks/overdue.ts'],
		deletablePaths: [],
		instructions: [
			'先运行测试，用失败输出确认边界问题，再决定如何修改。',
			'失败测试必须触发一次带 Observation 证据的 Replan。',
			'只修改逾期判断实现，不修改测试文件。'
		]
	},
	playbook: [
		{
			type: 'action',
			toolName: 'run_tests',
			arguments: {},
			stepId: 'reproduce-failure',
			reasoning: '先运行测试确认错误发生在截止时间相等的边界。',
			completesStepIds: ['reproduce-failure']
		},
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'src/tasks/overdue.ts' },
			stepId: 'inspect-overdue',
			reasoning: '读取逾期判断实现，检查比较符是否符合需求。'
		},
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'tests/overdue.test.ts' },
			stepId: 'inspect-overdue',
			reasoning: '读取失败用例，确认边界条件的准确预期。',
			completesStepIds: ['inspect-overdue']
		},
		{
			type: 'replan',
			reason: '失败测试已经证明问题来自 <= 比较符，需要增加明确的修复步骤。',
			newSteps: [
				{
					id: 'fix-boundary',
					title: '修正截止时间比较符',
					description: '把相等时间从逾期条件中排除。',
					dependsOn: ['inspect-overdue']
				}
			]
		},
		{
			type: 'action',
			toolName: 'apply_patch',
			arguments: {
				path: 'src/tasks/overdue.ts',
				replacements: [
					{
						search:
							"task.status !== 'done' && new Date(task.dueAt).getTime() <= now.getTime()",
						replacement:
							"task.status !== 'done' && new Date(task.dueAt).getTime() < now.getTime()"
					}
				]
			},
			stepId: 'fix-boundary',
			reasoning: '使用严格小于号，只把已经超过截止时间的任务标记为逾期。',
			completesStepIds: ['fix-boundary']
		},
		{
			type: 'action',
			toolName: 'run_tests',
			arguments: {},
			stepId: 'verify-overdue',
			reasoning: '重新运行测试确认边界和完成状态都正确。'
		},
		{
			type: 'action',
			toolName: 'run_typecheck',
			arguments: {},
			stepId: 'verify-overdue',
			reasoning: '确认修复没有引入类型错误。'
		},
		{
			type: 'action',
			toolName: 'get_git_diff',
			arguments: {},
			stepId: 'verify-overdue',
			reasoning: '检查修改是否只影响逾期判断。',
			completesStepIds: ['verify-overdue']
		},
		{
			type: 'final',
			summary: '逾期时间边界已经修复，并通过测试验证。'
		}
	],
	expected: {
		changedPaths: ['src/tasks/overdue.ts'],
		requireTests: true,
		requireTypecheck: true,
		requirePlanVersion: 2
	}
}

const legacyCleanup: ScenarioDefinition = {
	id: 'legacy-cleanup',
	title: '审批后删除废弃代码',
	shortDescription: '确认文件没有引用后，请求人工批准删除并完成回归验证。',
	requirement:
		'删除已经被 TaskService 替代的 legacy-task.mapper.ts，删除前必须确认没有引用并获得人工批准。',
	category: 'refactor',
	overlay: 'legacy-cleanup',
	completionCriteria: [
		'确认废弃文件没有任何代码引用',
		'删除操作经过人工批准',
		'目标文件已经从工作区删除',
		'测试和类型检查保持通过'
	],
	initialSteps: [
		{
			id: 'inspect-legacy',
			title: '确认废弃文件及引用关系',
			description: '搜索文件名称和导出函数的引用。',
			dependsOn: []
		},
		{
			id: 'remove-legacy',
			title: '删除废弃文件',
			description: '获得人工批准后执行删除。',
			dependsOn: ['inspect-legacy']
		},
		{
			id: 'verify-cleanup',
			title: '验证清理结果',
			description: '运行测试、类型检查并检查 Diff。',
			dependsOn: ['remove-legacy']
		}
	],
	workspacePolicy: {
		writablePaths: [],
		deletablePaths: ['src/legacy/legacy-task.mapper.ts'],
		instructions: [
			'删除前必须搜索 mapLegacyTask 的引用并读取目标文件。',
			'本场景只允许删除指定的 legacy 文件，不修改其他代码。',
			'delete_file 属于高风险工具，Runtime 会暂停并等待用户确认。'
		]
	},
	playbook: [
		{
			type: 'action',
			toolName: 'search_code',
			arguments: { query: 'mapLegacyTask' },
			stepId: 'inspect-legacy',
			reasoning: '先确认旧函数是否仍然被其他文件引用。'
		},
		{
			type: 'action',
			toolName: 'read_file',
			arguments: { path: 'src/legacy/legacy-task.mapper.ts' },
			stepId: 'inspect-legacy',
			reasoning: '读取文件确认它确实只包含废弃映射逻辑。',
			completesStepIds: ['inspect-legacy']
		},
		{
			type: 'action',
			toolName: 'delete_file',
			arguments: { path: 'src/legacy/legacy-task.mapper.ts' },
			stepId: 'remove-legacy',
			reasoning: '删除已确认无引用的废弃代码文件。',
			completesStepIds: ['remove-legacy']
		},
		{
			type: 'action',
			toolName: 'run_tests',
			arguments: {},
			stepId: 'verify-cleanup',
			reasoning: '删除后运行测试，确认行为没有退化。'
		},
		{
			type: 'action',
			toolName: 'run_typecheck',
			arguments: {},
			stepId: 'verify-cleanup',
			reasoning: '检查是否还存在指向已删除文件的类型引用。'
		},
		{
			type: 'action',
			toolName: 'get_git_diff',
			arguments: {},
			stepId: 'verify-cleanup',
			reasoning: '确认最终 Diff 只删除了目标文件。',
			completesStepIds: ['verify-cleanup']
		},
		{
			type: 'final',
			summary: '废弃映射器已在人工批准后删除，回归验证通过。'
		}
	],
	expected: {
		deletedPaths: ['src/legacy/legacy-task.mapper.ts'],
		requireTests: true,
		requireTypecheck: true
	}
}

export const SCENARIOS: ScenarioDefinition[] = [
	priorityFilter,
	overdueBoundary,
	legacyCleanup
]

export function getScenario(id: string): ScenarioDefinition {
	const scenario = SCENARIOS.find((item) => item.id === id)

	if (!scenario) {
		throw new Error(`未知场景：${id}`)
	}

	return scenario
}
