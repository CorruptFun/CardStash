export function linkAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {}
  if (source.aborted) {
    target.abort(source.reason)
    return () => {}
  }
  const forward = () => target.abort(source.reason)
  source.addEventListener('abort', forward, { once: true })
  return () => source.removeEventListener('abort', forward)
}

export interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number
}

export async function fetchJson<T = any>(url: string, options?: FetchJsonOptions): Promise<T> {
  const { timeoutMs = 12_000, signal, ...init } = options ?? {}
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  )
  const unlink = linkAbort(signal ?? undefined, controller)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
    unlink()
  }
}

export function isAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}
