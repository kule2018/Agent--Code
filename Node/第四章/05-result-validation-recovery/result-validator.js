/**
 * 校验单次工具调用返回的 Observation 是否真正可用。
 *
 * 该校验不仅判断工具是否调用成功，还会检查：
 * - Observation 结构是否完整
 * - records 字段是否存在且类型正确
 * - records 中是否包含可作为证据的数据
 *
 * @param {object} action 当前执行的 Action
 * @param {object} observation 工具返回结果
 * @returns {object} 校验结果；校验通过时返回 { ok: true }
 */
function validateObservation(action, observation) {
	// Observation 不存在、工具执行失败或缺少 data 时，
	// 说明工具没有返回符合约定的完整结果
	if (!observation || observation.ok !== true || !observation.data) {
		return invalid(
			'invalid_result',
			'MALFORMED_RESULT',
			`工具 ${action.toolName} 没有返回完整 Observation。`
		)
	}

	// records 应当是数组；字段缺失或类型错误都属于结果结构异常
	if (!Array.isArray(observation.data.records)) {
		return invalid(
			'invalid_result',
			'MISSING_RECORDS',
			`工具 ${action.toolName} 的 records 字段缺失。`
		)
	}

	// 工具调用虽然成功，但空数组不能作为完成计划步骤的有效证据
	if (observation.data.records.length === 0) {
		return invalid(
			'no_evidence',
			'EMPTY_RESULT',
			'工具调用成功，但没有返回可用证据。'
		)
	}

	// Observation 结构完整，并且至少包含一条可用记录
	return { ok: true }
}

/**
 * 交叉校验已经通过单条校验的多份证据。
 *
 * @param {object[]} observations 当前已经收集的证据
 * @returns {object} 校验结果
 */
function validateEvidenceSet(observations) {
	const logEvidence = observations.find(
		(item) => item.source === 'primary_logs' || item.source === 'backup_logs'
	)
	const inventoryEvidence = observations.find(
		(item) => item.source === 'instance_inventory'
	)

	if (!logEvidence || !inventoryEvidence) {
		return { ok: true }
	}

	// 如果日志记录的运行版本与实例清单返回的版本不一致，则说明多份证据发生冲突
	const logVersion = logEvidence.data.runtimeVersion
	const inventoryVersion = inventoryEvidence.data.activeVersion

	if (logVersion && inventoryVersion && logVersion !== inventoryVersion) {
		return invalid(
			'evidence_conflict',
			'RUNTIME_VERSION_CONFLICT',
			`日志记录的运行版本是 ${logVersion}，实例清单返回的版本是 ${inventoryVersion}。`,
			{
				evidenceKeys: [logEvidence.evidenceKey, inventoryEvidence.evidenceKey]
			}
		)
	}

	return { ok: true }
}

function classifyToolError(error) {
	if (error?.code === 'UPSTREAM_TIMEOUT') {
		return {
			kind: 'transient_error',
			code: error.code,
			message: error.message,
			details: error.details || {}
		}
	}

	return {
		kind: 'unexpected_error',
		code: error?.code || 'UNEXPECTED_ERROR',
		message: error instanceof Error ? error.message : String(error),
		details: error?.details || {}
	}
}

function invalid(kind, code, message, details = {}) {
	return {
		ok: false,
		failure: {
			kind,
			code,
			message,
			details
		}
	}
}

module.exports = {
	validateObservation,
	validateEvidenceSet,
	classifyToolError
}
