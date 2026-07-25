/**
 * MCP App 页面脚本。
 *
 * 浏览器必须运行 JavaScript，因此 Python 版本仍然需要少量前端代码。
 * 这里直接实现 MCP Apps 的 ui/initialize 与 Tool Result 消息，
 * 不依赖 npm、Vite 或 Node.js 构建过程。
 */
const statusElement = document.querySelector('#status')
const summaryElement = document.querySelector('#summary')
const rowsElement = document.querySelector('#rows')
const jobIdElement = document.querySelector('#job-id')

let initializeRequestId = 1

function resultLabel(item) {
	if (!item.eligible) return ['拒绝', 'danger']
	if (item.manualReview) return ['待人工审核', 'warning']
	return ['自动通过', 'success']
}

function escapeHtml(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;')
}

/** 根据 Tool Result 渲染批量退款审核报告。 */
function render(data) {
	const job = data?.job
	const result = job?.result
	if (!result) return

	statusElement.textContent = '审核完成'
	statusElement.className = 'status completed'
	jobIdElement.textContent = job.jobId

	const values = [
		result.total,
		result.autoApproved,
		result.manualReview,
		result.rejected
	]
	summaryElement.querySelectorAll('strong').forEach((element, index) => {
		element.textContent = values[index]
	})

	rowsElement.innerHTML = result.details
		.map((item) => {
			const [label, tone] = resultLabel(item)
			const action = item.manualReview
				? '转人工'
				: item.eligible
					? '系统处理'
					: '终止退款'

			return `
				<tr>
					<td><strong>${escapeHtml(item.orderId)}</strong></td>
					<td><span class="result ${tone}">${label}</span></td>
					<td>${action}</td>
					<td>${escapeHtml(item.conclusion)}</td>
				</tr>`
		})
		.join('')

	window.parent.postMessage(
		{
			jsonrpc: '2.0',
			method: 'ui/notifications/size-changed',
			params: { height: document.documentElement.scrollHeight }
		},
		'*'
	)
}

window.addEventListener('message', (event) => {
	if (event.source !== window.parent) return
	const message = event.data

	// Host 完成 ui/initialize 握手后，通知页面已经可以接收 Tool Result。
	if (message?.jsonrpc === '2.0' && message.id === initializeRequestId) {
		window.parent.postMessage(
			{
				jsonrpc: '2.0',
				method: 'ui/notifications/initialized',
				params: {}
			},
			'*'
		)
		return
	}

	if (message?.method === 'ui/notifications/tool-result') {
		render(message.params?.structuredContent)
	}
})

// 按 MCP Apps 规范，由 App 主动向 Host 发起初始化请求。
window.parent.postMessage(
	{
		jsonrpc: '2.0',
		id: initializeRequestId,
		method: 'ui/initialize',
		params: {
			appInfo: {
				name: 'after-sales-review-report',
				version: '1.0.0'
			},
			appCapabilities: {},
			protocolVersion: '2026-01-26'
		}
	},
	'*'
)
