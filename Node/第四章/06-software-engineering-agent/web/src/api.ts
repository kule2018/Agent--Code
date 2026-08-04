import type { AgentRun, Capabilities, RunMode, Scenario } from './types'

async function request<T>(url: string, options?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...options?.headers
		}
	})

	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { message?: string } | null
		throw new Error(body?.message ?? `请求失败：${response.status}`)
	}

	return response.json() as Promise<T>
}

export const api = {
	scenarios: () => request<Scenario[]>('/api/scenarios'),
	capabilities: () => request<Capabilities>('/api/capabilities'),
	runs: () => request<AgentRun[]>('/api/runs'),
	run: (id: string) => request<AgentRun>(`/api/runs/${id}`),
	createRun: (input: { scenarioId: string; requirement: string; mode: RunMode }) =>
		request<AgentRun>('/api/runs', {
			method: 'POST',
			body: JSON.stringify(input)
		}),
	approve: (id: string, approved: boolean) =>
		request<AgentRun>(`/api/runs/${id}/approval`, {
			method: 'POST',
			body: JSON.stringify({ approved })
		}),
	cancel: (id: string) =>
		request<AgentRun>(`/api/runs/${id}/cancel`, { method: 'POST' })
}
