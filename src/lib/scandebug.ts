/**
 * Scan diagnostics: a small in-memory ring of per-attempt stage traces —
 * what each OCR pass read, which name candidates were tried, what the match
 * layer scored, what the collector-line parse saw. Strictly local: this is
 * the "what did the scanner see?" view and the regression harness's stage
 * attribution. Trace contents include card text, so they must NEVER feed
 * analytics (whose events are content-free by contract) or leave the device
 * except by the user explicitly copying them.
 */

export interface TraceEvent {
  /** ms since the attempt started */
  t: number
  stage: string
  [key: string]: unknown
}

export interface ScanTrace {
  seq: number
  startedAt: number
  mode: string
  hint?: string
  events: TraceEvent[]
  outcome?: {
    ok: boolean
    reason?: string
    name?: string
    game?: string
    setCode?: string | null
    number?: string | null
    via?: string
    confidence?: number
    message?: string
    ms: number
  }
}

const LIMIT = 24
let seq = 0
/** Reassigned (never mutated) on change, so UI snapshots compare by identity. */
let ring: readonly ScanTrace[] = []
let current: ScanTrace | null = null
const listeners = new Set<() => void>()

export function beginScanTrace(mode: string, hint?: string): void {
  current = { seq: ++seq, startedAt: Date.now(), mode, hint, events: [] }
}

export function traceEvent(stage: string, detail: Record<string, unknown> = {}): void {
  if (!current) return
  current.events.push({ t: Date.now() - current.startedAt, stage, ...detail })
}

export function endScanTrace(outcome: NonNullable<ScanTrace['outcome']>): void {
  if (!current) return
  current.outcome = outcome
  ring = [current, ...ring].slice(0, LIMIT)
  current = null
  for (const fn of listeners) fn()
}

/** Newest first. */
export function scanTraces(): readonly ScanTrace[] {
  return ring
}

export function clearScanTraces(): void {
  ring = []
  for (const fn of listeners) fn()
}

/** Subscribe to trace-ring changes (diagnostics UI). Returns unsubscribe. */
export function onScanTraces(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
