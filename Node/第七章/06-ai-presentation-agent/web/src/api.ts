import type {
	ApplyChangeResult,
	CreatePresentationInput,
	Presentation
} from './types'

const API = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${API}${path}`, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			...init?.headers
		}
	})
	const payload = await response.json().catch(() => null)
	if (!response.ok) {
		const message = Array.isArray(payload?.message)
			? payload.message.join('；')
			: payload?.message ?? '请求处理失败'
		throw new Error(message)
	}
	return payload as T
}

export const api = {
	meta: () =>
		request<{
			defaultMode: 'replay' | 'ai'
			aiAvailable: boolean
			model: string
		}>('/presentations/meta'),
	list: () => request<Presentation[]>('/presentations'),
	get: (id: string) => request<Presentation>(`/presentations/${id}`),
	create: (input: CreatePresentationInput) =>
		request<Presentation>('/presentations', {
			method: 'POST',
			body: JSON.stringify(input)
		}),
	review: (
		id: string,
		input: {
			decision: 'approve' | 'revise' | 'reject'
			outlineVersion: number
			feedback: string
		}
	) =>
		request<Presentation>(`/presentations/${id}/review`, {
			method: 'POST',
			body: JSON.stringify(input)
		}),
	continuePages: (id: string) =>
		request<Presentation>(`/presentations/${id}/continue`, {
			method: 'POST'
		}),
	revisePage: (id: string, pageId: string, changeRequest: string) =>
		request<Presentation>(`/presentations/${id}/pages/${pageId}/revise`, {
			method: 'POST',
			body: JSON.stringify({ changeRequest })
		}),
	applyChange: (id: string, instruction: string) =>
		request<ApplyChangeResult>(`/presentations/${id}/changes`, {
			method: 'POST',
			body: JSON.stringify({ instruction })
		}),
	export: (id: string) =>
		request<Presentation>(`/presentations/${id}/export`, {
			method: 'POST'
		}),
	downloadUrl: (id: string) => `${API}/presentations/${id}/download`
}
