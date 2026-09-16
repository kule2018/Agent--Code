import {
	END,
	START,
	ReducedValue,
	StateGraph,
	StateSchema
} from '@langchain/langgraph'
import * as z from 'zod'

const RequirementsSchema = z.object({
	topic: z.string(),
	audience: z.string(),
	pageCount: z.number().int()
})

const OutlineSchema = z.object({
	title: z.string(),
	sections: z.array(z.string())
})

/** 定义演示文稿制作流程中需要持续保存的运行状态。 */
const WorkflowState = new StateSchema({
	presentationId: z.string(),
	requirements: RequirementsSchema.nullable().default(null),
	outline: OutlineSchema.nullable().default(null),
	draftSaved: z.boolean().default(false),
	executionPath: new ReducedValue(
		z.array(z.string()).default(() => []),
		{
			inputSchema: z.string(),
			reducer: (current, nodeName) => [...current, nodeName]
		}
	)
})

/** 整理用户提交的演示文稿制作要求。 */
function prepareRequirements() {
	console.log('[Node:prepare_requirements] 整理制作要求')

	return {
		requirements: {
			topic: 'Agent 大模型课程发布方案',
			audience: '企业技术负责人',
			pageCount: 3
		},
		executionPath: 'prepare_requirements'
	}
}

/** 模拟一次模型调用，根据制作要求生成大纲。 */
function generateOutline(state) {
	console.log('[Node:generate_outline] 生成演示文稿大纲')

	return {
		outline: {
			title: state.requirements.topic,
			sections: ['业务需求', '课程方案', '合作与交付']
		},
		executionPath: 'generate_outline'
	}
}

/**
 * 创建可持久化的演示文稿制作流程。
 * shouldFailSave 只用于课程实验，模拟保存草稿时外部服务异常。
 */
export function createPresentationWorkflow({ checkpointer, shouldFailSave }) {
	function saveOutlineDraft() {
		console.log('[Node:save_outline_draft] 保存大纲草稿')

		if (shouldFailSave()) {
			throw new Error('模拟故障：大纲存储服务暂时不可用。')
		}

		return {
			draftSaved: true,
			executionPath: 'save_outline_draft'
		}
	}

	return new StateGraph(WorkflowState)
		.addNode('prepare_requirements', prepareRequirements)
		.addNode('generate_outline', generateOutline)
		.addNode('save_outline_draft', saveOutlineDraft)
		.addEdge(START, 'prepare_requirements')
		.addEdge('prepare_requirements', 'generate_outline')
		.addEdge('generate_outline', 'save_outline_draft')
		.addEdge('save_outline_draft', END)
		.compile({ checkpointer })
}
