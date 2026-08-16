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
  /**
   * Transient-failure retries — 429 and 5xx only, honouring `Retry-After`.
   * Off by default and deliberately so: the scan pipeline runs on a shared
   * wall-clock budget where a retry is spent out of some other game's wait
   * (see `ApiKeys.thorough`). Turn it on for work a USER is sitting and
   * waiting for, where one more second beats an empty screen.
   */
  retries?: number
}

/** The HTTP status a `fetchJson` rejection carried, when it had one. */
export function httpStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

/** 429 and 5xx are "ask again"; 4xx means the answer really is no. */
function retriable(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * `Retry-After` is seconds or an HTTP date. Clamped: a server asking for two
 * minutes is telling us to give up on this attempt, not to hang the UI.
 */
function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get('Retry-After')
  const seconds = header ? Number(header) : NaN
  const asDate = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : NaN
  const asked = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(asDate) ? asDate : NaN
  const backoff = 400 * 2 ** attempt
  return Math.min(5_000, Math.max(backoff, Number.isFinite(asked) ? asked : 0))
}

export async function fetchJson<T = any>(url: string, options?: FetchJsonOptions): Promise<T> {
  const { timeoutMs = 12_000, retries = 0, signal, ...init } = options ?? {}
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError')),
      timeoutMs,
    )
    const unlink = linkAbort(signal ?? undefined, controller)
    let wait: number | null = null
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      if (!res.ok) {
        if (attempt < retries && retriable(res.status)) {
          wait = retryAfterMs(res, attempt)
        } else {
          const body = await res.text().catch(() => '')
          // The status rides on the error so callers can tell "no such card"
          // (404) from "we are being throttled" (429) without regex over a
          // message — matching on the text is how a 429 came to be reported
          // to users as an empty result set.
          throw Object.assign(new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`), {
            status: res.status,
          })
        }
      } else {
        return (await res.json()) as T
      }
    } finally {
      clearTimeout(timer)
      unlink()
    }
    if (wait != null) await sleep(wait, signal ?? undefined)
  }
}

/** Abortable sleep — a queued retry must not outlive the request that wanted it. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function isAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}
