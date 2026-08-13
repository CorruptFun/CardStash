import Dexie, { type Table } from 'dexie'
import { settings } from './settings'
import { uid } from './util'

/**
 * Local-first diagnostics: counts, timings and hashed errors — never card
 * names, never queries, never keys. Upload happens only when the user turns
 * on sharing AND provides an ingest token.
 */

export const EVENT_TYPES = [
  'scan_attempt',
  'card_added',
  'variant_selected',
  'import_completed',
  'search',
  'deck_created',
  'ai_builder_run',
  'price_refresh',
  'error',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export interface AnalyticsEvent {
  id?: number
  t: EventType
  at: number
  data: Record<string, string | number | boolean>
}

interface MetaRow {
  key: string
  value: unknown
}

class AnalyticsDB extends Dexie {
  events!: Table<AnalyticsEvent, number>
  meta!: Table<MetaRow, string>

  constructor() {
    super('cardstock-analytics')
    this.version(1).stores({ events: '++id, at, t', meta: 'key' })
  }
}

const adb = new AnalyticsDB()

const PRUNE_TO = 5_000
const PRUNE_AT = 5_200
const PRUNE_EVERY = 32
let sincePrune = 0

async function prune(): Promise<number> {
  const count = await adb.events.count()
  if (count <= PRUNE_AT) return 0
  const stale = await adb.events
    .orderBy('id')
    .limit(count - PRUNE_TO)
    .primaryKeys()
  await adb.events.bulkDelete(stale)
  return stale.length
}

/** Value keys that must never reach the log, even by accident. */
const FORBIDDEN_KEYS = new Set([
  'name',
  'cardname',
  'title',
  'query',
  'q',
  'search',
  'term',
  'message',
  'msg',
  'text',
  'detail',
  'note',
  'prompt',
  'key',
  'apikey',
  'token',
  'url',
  'href',
  'endpoint',
  'email',
  'user',
  'id',
])
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,32}$/
const SAFE_KEY = /^[a-z][A-Za-z0-9]{0,20}$/

function redact(data: Record<string, unknown>): Record<string, string | number | boolean> {
  const clean: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!SAFE_KEY.test(key) || FORBIDDEN_KEYS.has(key.toLowerCase())) continue
    if (typeof value === 'boolean') clean[key] = value
    else if (typeof value === 'number') {
      if (Number.isFinite(value)) clean[key] = Math.round(value * 100) / 100
    } else if (typeof value === 'string' && SAFE_STRING.test(value)) clean[key] = value
  }
  return clean
}

function safeComponent(name: string): string {
  return name.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 32) || 'unknown'
}

function fnv1a(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

let queue: Promise<void> = Promise.resolve()

function enqueue(work: () => Promise<void>): void {
  queue = queue.then(work).catch(() => {})
}

export function track(type: EventType, data: Record<string, unknown> = {}): void {
  const event: AnalyticsEvent = { t: type, at: Date.now(), data: redact(data) }
  enqueue(async () => {
    await adb.events.add(event)
    if (++sincePrune >= PRUNE_EVERY) {
      sincePrune = 0
      await prune()
    }
  })
}

export function trackError(component: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? '')
  track('error', { component: safeComponent(component), hash: fnv1a(message) })
}

let errorHooksInstalled = false

export function installErrorHooks(): void {
  if (errorHooksInstalled || typeof window === 'undefined') return
  errorHooksInstalled = true
  window.addEventListener('error', (event) => trackError('window', event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => trackError('promise', event.reason))
}

let devicePromise: Promise<string> | null = null

async function deviceId(): Promise<string> {
  if (devicePromise) return devicePromise
  const pending = (async () => {
    const row = await adb.meta.get('device')
    if (typeof row?.value === 'string' && row.value) return row.value
    const id = uid()
    await adb.meta.put({ key: 'device', value: id })
    return id
  })()
  devicePromise = pending
  pending.catch(() => {
    if (devicePromise === pending) devicePromise = null
  })
  return pending
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

export interface ScanStats {
  attempts: number
  hits: number
  successRate: number
  byEngine: Record<string, { n: number; hits: number; p50: number; p95: number }>
  missReasons: Record<string, number>
}

function scanStats(events: AnalyticsEvent[]): ScanStats {
  const byEngine = new Map<string, { n: number; hits: number; ms: number[] }>()
  const missReasons: Record<string, number> = {}
  let attempts = 0
  let hits = 0
  for (const event of events) {
    if (event.t !== 'scan_attempt') continue
    attempts++
    const engine = typeof event.data.engine === 'string' ? event.data.engine : 'unknown'
    const bucket = byEngine.get(engine) ?? { n: 0, hits: 0, ms: [] }
    bucket.n++
    if (event.data.outcome === 'hit') {
      hits++
      bucket.hits++
    } else {
      const reason = typeof event.data.reason === 'string' ? event.data.reason : 'unknown'
      missReasons[reason] = (missReasons[reason] ?? 0) + 1
    }
    if (typeof event.data.ms === 'number' && Number.isFinite(event.data.ms)) bucket.ms.push(event.data.ms)
    byEngine.set(engine, bucket)
  }
  const engines: ScanStats['byEngine'] = {}
  for (const [engine, bucket] of byEngine) {
    engines[engine] = {
      n: bucket.n,
      hits: bucket.hits,
      p50: percentile(bucket.ms, 50),
      p95: percentile(bucket.ms, 95),
    }
  }
  return { attempts, hits, successRate: attempts ? hits / attempts : 0, byEngine: engines, missReasons }
}

function countByType(events: AnalyticsEvent[]): Record<EventType, number> {
  const counts = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])) as Record<EventType, number>
  for (const event of events) if (event.t in counts) counts[event.t]++
  return counts
}

export interface Insights {
  days: number
  since: number
  scans: ScanStats
  counts: Record<EventType, number>
  total: number
  oldestAt: number | null
  lastFlushAt: number | null
  queued: number
}

function emptyInsights(days: number, since: number): Insights {
  return {
    days,
    since,
    scans: { attempts: 0, hits: 0, successRate: 0, byEngine: {}, missReasons: {} },
    counts: countByType([]),
    total: 0,
    oldestAt: null,
    lastFlushAt: null,
    queued: 0,
  }
}

async function metaNumber(key: string, fallback: number): Promise<number> {
  const row = await adb.meta.get(key)
  return typeof row?.value === 'number' ? row.value : fallback
}

export async function insights(days: number): Promise<Insights> {
  const since = Date.now() - Math.max(1, days) * 86_400_000
  try {
    const events = await adb.events.where('at').aboveOrEqual(since).toArray()
    const total = await adb.events.count()
    const oldest = await adb.events.orderBy('at').first()
    const flushedThrough = await metaNumber('flushedThrough', 0)
    const queued = await adb.events.where('id').above(flushedThrough).count()
    const lastFlushAt = await metaNumber('lastFlushAt', 0)
    return {
      days,
      since,
      scans: scanStats(events),
      counts: countByType(events),
      total,
      oldestAt: oldest?.at ?? null,
      lastFlushAt: lastFlushAt || null,
      queued,
    }
  } catch {
    return emptyInsights(days, since)
  }
}

export async function clearAnalytics(): Promise<void> {
  try {
    await adb.events.clear()
    await adb.meta.bulkDelete(['flushedThrough', 'lastFlushAt'])
    sincePrune = 0
  } catch {
    /* diagnostics only */
  }
}

/* Telemetry upload — opt-in, batched, token-gated. */

const FLUSH_BATCH = 500
const FLUSH_TIMEOUT_MS = 10_000
const KEEPALIVE_BYTES = 60_000
const FLUSH_MIN_GAP_MS = 30_000
let flushing = false

const APP_VERSION = '0.7.1'

function payload(events: AnalyticsEvent[], device: string) {
  return {
    app: 'cardstock',
    v: APP_VERSION,
    device,
    sentAt: new Date().toISOString(),
    events: events.map((event) => ({ t: event.t, at: event.at, ...event.data })),
  }
}

function byteLength(text: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length
}

export async function flushTelemetry({ force = false, keepalive = false } = {}): Promise<void> {
  if (flushing) return
  const config = settings()
  const endpoint = config.diagEndpoint.trim()
  const token = config.diagToken.trim()
  if (!config.diagShare || !endpoint || !token) return
  flushing = true
  try {
    if (!force) {
      const lastFlushAt = await metaNumber('lastFlushAt', 0)
      if (Date.now() - lastFlushAt < FLUSH_MIN_GAP_MS) return
    }
    const flushedThrough = await metaNumber('flushedThrough', 0)
    let events = await adb.events.where('id').above(flushedThrough).limit(FLUSH_BATCH).toArray()
    if (!events.length) return
    const device = await deviceId()
    let body = JSON.stringify(payload(events, device))
    while (keepalive && events.length > 1 && byteLength(body) > KEEPALIVE_BYTES) {
      events = events.slice(0, Math.floor(events.length / 2))
      body = JSON.stringify(payload(events, device))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS)
    let ok = false
    try {
      ok = (
        await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body,
          keepalive: keepalive && byteLength(body) <= KEEPALIVE_BYTES,
          credentials: 'omit',
          signal: controller.signal,
        })
      ).ok
    } catch {
      ok = false
    } finally {
      clearTimeout(timer)
    }
    if (!ok) return
    const last = events[events.length - 1].id
    if (typeof last === 'number') {
      await adb.meta.bulkPut([
        { key: 'flushedThrough', value: last },
        { key: 'lastFlushAt', value: Date.now() },
      ])
    }
  } catch {
    /* upload is best-effort */
  } finally {
    flushing = false
  }
}

let flusherInstalled = false

export function installTelemetryFlusher(): void {
  if (flusherInstalled || typeof window === 'undefined') return
  flusherInstalled = true
  const kick = () => {
    flushTelemetry()
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(kick, { timeout: 4000 })
  else setTimeout(kick, 1500)
  setInterval(() => {
    flushTelemetry()
  }, 60_000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushTelemetry({ force: true, keepalive: true })
  })
}
