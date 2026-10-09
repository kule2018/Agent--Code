/** 普通请求统一提取后端错误，流式响应逐行解析，不依赖网络块边界。 */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, { ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message || '请求失败')
  return data
}
export async function stream(path: string, body: object, signal: AbortSignal, receive: (event: string, data: any) => void) {
  const response = await fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!response.ok) throw new Error((await response.json()).message || '请求失败')
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      const lines = pending.split('\n'); pending = lines.pop()!
      for (const line of lines) if (line.trim()) { const packet = JSON.parse(line); receive(packet.event, packet.data) }
      if (done) { if (pending.trim()) { const packet = JSON.parse(pending); receive(packet.event, packet.data) }; break }
    }
  } finally { reader.releaseLock() }
}
