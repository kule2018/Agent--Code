import { Injectable } from '@nestjs/common'
import type { ToolAction, ToolObservation } from './agent.types'

export interface ValidationResult {
	valid: boolean
	code: string
	summary: string
}

/** 只有通过结构与业务语义校验的工具结果，才允许进入 Agent Run State。 */
@Injectable()
export class ResultValidatorService {
	validate(
		action: ToolAction,
		observation: ToolObservation
	): ValidationResult {
		if (!observation.ok || !observation.data) {
			return invalid('MALFORMED_RESULT', '工具没有返回完整 Observation。')
		}

		if (action.toolName === 'apply_patch' && observation.data.changed !== true) {
			return invalid('NO_FILE_CHANGE', '补丁执行后文件内容没有发生变化。')
		}

		if (action.toolName === 'delete_file' && observation.data.deleted !== true) {
			return invalid('DELETE_NOT_CONFIRMED', '工具没有确认目标文件已删除。')
		}

		if (action.toolName === 'get_git_diff') {
			if (
				!Array.isArray(observation.data.changedPaths) ||
				!Array.isArray(observation.data.deletedPaths)
			) {
				return invalid('INVALID_DIFF', 'Diff 缺少文件变化列表。')
			}
		}

		if (action.toolName.startsWith('run_')) {
			if (typeof observation.data.passed !== 'boolean') {
				return invalid('INVALID_COMMAND_RESULT', '命令结果缺少 passed 字段。')
			}

			return {
				valid: true,
				code: observation.data.passed ? 'COMMAND_PASSED' : 'COMMAND_FAILED',
				summary: observation.data.passed
					? '命令返回结构有效，并且执行通过。'
					: '命令返回结构有效；失败输出会作为后续修复证据。'
			}
		}

		return { valid: true, code: 'VALID', summary: '工具结果校验通过。' }
	}
}

function invalid(code: string, summary: string): ValidationResult {
	return { valid: false, code, summary }
}
