import Dexie, { type Table } from 'dexie'
import { SUPABASE_KEY } from './cloudconfig'
import { DIAG_AVAILABLE, DIAG_ENDPOINT } from './diagconfig'
import { settings } from './settings'
import { uid } from './util'
import { APP_VERSION } from './version'

/**
 * Local-first diagnostics: counts, timings and hashed errors — never card
 * names, never queries, never keys. Upload happens only when the user turns
 * on sharing AND provides an ingest token.
 *
 * Three questions this log exists to answer, and how each is answered without
 * ever carrying content:
 *   who is using the app — a per-install id, session opens and lengths, and
 *     the device shape (`app_open`, `session_end`, `screen_view`);
 *   which cards fail to scan — `scan_failure` carries the stage the pipeline
 *     died at plus `card`, a hash of the text that was read. The hash groups
 *     repeat failures of one card across devices while the payload stays
 *     free of card names; a maintainer resolves a bucket by hashing catalog
 *     names, which needs the catalog rather than the log (see hashToken);
 *   what people do with it — the per-feature counters below.
 */

export const EVENT_TYPES = [
  'app_open',
  'session_end',
  'screen_view',
  'scan_attempt',
  'scan_failure',
  'card_added',
  'variant_selected',
  'import_completed',
  'backup_run',
  'backup_restore',
  'search',
  'deck_created',
  'ai_builder_run',
  'price_refresh',
  'friend_added',
  'social_share',
  'trade_update',
  'want_update',
  'sync_run',
  'card_patch',
  'card_source',
  'card_source_submit',
  'card_source_flag',
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

/**
 * Value keys that must never reach the log, even by accident.
 *
 * Three families, and the reason differs for each:
 *
 *   * **Content** — card names, queries, notes, error prose. The original list.
 *   * **Identity and credentials** — keys, tokens, emails, ids.
 *   * **Postal and money.** These carry no card text, so nothing above would
 *     have caught them, and both `zip: '94110'` and `city: 'Austin'` satisfy
 *     `SAFE_STRING` — they would have sailed straight through. They are here
 *     ahead of the marketplace that will need them rather than after it,
 *     because the failure mode is silent: a postcode in the log looks exactly
 *     like a working event. No event has ever passed one of these, so nothing
 *     regresses by forbidding them.
 *
 * An order's value is still answerable — pass a BUCKET, the way collection
 * size already is, never the amount. A bucket is a count; an amount is a fact
 * about one person's money.
 */
const FORBIDDEN_KEYS = new Set([
  // content
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
  // identity and credentials
  'key',
  'apikey',
  'token',
  'url',
  'href',
  'endpoint',
  'email',
  'user',
  'id',
  'handle',
  // postal
  'address',
  'addr',
  'street',
  'line1',
  'line2',
  'city',
  'state',
  'region',
  'zip',
  'postcode',
  'postal',
  'country',
  'phone',
  'recipient',
  'tracking',
  // money
  'amount',
  'price',
  'total',
  'subtotal',
  'fee',
  'cost',
  'value',
  'balance',
  'payout',
])
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,32}$/
const SAFE_KEY = /^[a-z][A-Za-z0-9]{0,20}$/

/**
 * The content-free contract, in one function: an unknown key or a value that
 * looks like prose never reaches the log. Exported so a test can hold it to
 * that, since every `track` call in the app depends on it.
 */
export function redact(data: Record<string, unknown>): Record<string, string | number | boolean> {
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

/**
 * Grouping key for text the scanner read — a hash, never the text. Repeat
 * failures of one card collapse into a single bucket, so "this card fails
 * everywhere" is answerable, while the log itself stays content-free.
 * Case, spacing, punctuation and accents are normalised away first so the
 * same card hashes the same however cleanly it was read.
 */
export function hashToken(text: string): string {
  const normal = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  return normal ? fnv1a(normal) : ''
}

/* Sessions: one visit's worth of events, so opens, screens and scans can be
 * counted per person rather than per event. */

const DAY_MS = 86_400_000
/** Foreground gap that ends a visit — glancing at another app doesn't. */
const SESSION_GAP_MS = 30 * 60_000

let sessionId = ''
let sessionStartedAt = 0
let sessionScreens = 0
let sessionScans = 0
let sessionOpen = false
let hiddenAt = 0

let queue: Promise<void> = Promise.resolve()

function enqueue(work: () => Promise<void>): void {
  queue = queue.then(work).catch(() => {})
}

export function track(type: EventType, data: Record<string, unknown> = {}): void {
  const event: AnalyticsEvent = { t: type, at: Date.now(), data: redact(data) }
  // Stamped after redaction: the session id is ours, not caller data, and
  // it's what turns loose events into visits.
  if (sessionId) event.data.sid = sessionId
  if (type === 'screen_view') sessionScreens++
  else if (type === 'scan_attempt') sessionScans++
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

export interface Identity {
  /** Random per-install id. Not a login, not derived from the device. */
  device: string
  firstSeen: number
  sessions: number
  activeDays: number
}

/** Reads the install record and counts this open against it. */
async function bumpIdentity(): Promise<Identity> {
  const device = await deviceId()
  const now = Date.now()
  const today = Math.floor(now / DAY_MS)
  const firstSeen = (await metaNumber('firstSeen', 0)) || now
  const sessions = (await metaNumber('sessions', 0)) + 1
  const lastDay = await metaNumber('lastDay', 0)
  const activeDays = (await metaNumber('activeDays', 0)) + (lastDay === today ? 0 : 1)
  await adb.meta.bulkPut([
    { key: 'firstSeen', value: firstSeen },
    { key: 'sessions', value: sessions },
    { key: 'lastDay', value: today },
    { key: 'activeDays', value: activeDays },
  ])
  return { device, firstSeen, sessions, activeDays }
}

const SIZE_BUCKETS: [number, string][] = [
  [10, '1-9'],
  [50, '10-49'],
  [250, '50-249'],
  [1000, '250-999'],
  [5000, '1k-5k'],
]

/** Collection sizes travel as a bucket, never an exact count — the shape of
 * the user base without a figure precise enough to single anybody out. */
export function sizeBucket(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  for (const [limit, label] of SIZE_BUCKETS) if (n < limit) return label
  return '5k-up'
}

/** USD, in dollars. */
const AMOUNT_BUCKETS: [number, string][] = [
  [5, 'u5'],
  [10, '5-10'],
  [25, '10-25'],
  [50, '25-50'],
  [100, '50-100'],
  [250, '100-250'],
]

/**
 * Order values travel as a bucket, for the same reason collection sizes do,
 * and one more: an exact amount is a fact about a specific transaction between
 * two identifiable people, which is precisely what this log is built not to
 * hold. `amount` and `price` are in `FORBIDDEN_KEYS`, so an exact figure is
 * dropped rather than merely discouraged — this is the supported way to ask
 * "are people buying cheap cards or expensive ones".
 *
 * The label deliberately avoids `$` and `+`: `SAFE_STRING` would reject them
 * and the value would vanish silently.
 */
export function amountBucket(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '0'
  for (const [limit, label] of AMOUNT_BUCKETS) if (usd < limit) return label
  return '250-up'
}

const PLATFORMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/i, 'ios'],
  [/Android/i, 'android'],
  [/Macintosh|Mac OS/i, 'mac'],
  [/Windows/i, 'windows'],
  [/Linux|CrOS/i, 'linux'],
]
/** Order matters: Edge, Opera and Samsung all carry "Chrome" in their user
 * agent, and every browser on this list carries "Safari" — the impostors
 * have to be ruled out before the names they borrow. */
const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'edge'],
  [/OPR\/|Opera/, 'opera'],
  [/SamsungBrowser/, 'samsung'],
  [/Firefox\/|FxiOS/, 'firefox'],
  [/CriOS|Chrome\//, 'chrome'],
  [/Safari\//, 'safari'],
]

function firstMatch(table: [RegExp, string][], text: string): string {
  for (const [pattern, label] of table) if (pattern.test(text)) return label
  return 'other'
}

interface NavLike {
  userAgent?: string
  language?: string
  onLine?: boolean
  /** iOS Safari's home-screen flag; absent everywhere else. */
  standalone?: boolean
}

interface WinLike {
  innerWidth?: number
  devicePixelRatio?: number
  matchMedia?: (query: string) => { matches: boolean }
}

export interface DeviceShape {
  platform: string
  browser: string
  /** Launched from a home screen — i.e. installed as an app. */
  standalone: boolean
  lang: string
  tzo: number
  dpr: number
  vw: number
  online: boolean
}

/** Device shape from an injected navigator/window, so the parsing is pure and
 * node-testable and can never reach for a global that isn't there. */
export function describeDevice(nav: NavLike = {}, win: WinLike = {}): DeviceShape {
  const ua = nav.userAgent ?? ''
  return {
    platform: firstMatch(PLATFORMS, ua),
    browser: firstMatch(BROWSERS, ua),
    standalone: nav.standalone === true || win.matchMedia?.('(display-mode: standalone)').matches === true,
    // A language tag is a locale, not a person: keep the region ("pt-BR"
    // separates a real audience from "pt-PT") and drop anything else.
    lang: (nav.language ?? '').slice(0, 12).replace(/[^A-Za-z-]/g, '') || 'unknown',
    tzo: new Date().getTimezoneOffset(),
    dpr: Math.round((win.devicePixelRatio ?? 1) * 10) / 10,
    vw: Math.round(win.innerWidth ?? 0),
    online: nav.onLine !== false,
  }
}

/** Coarse shape of what the user keeps — resolved by the caller, which is
 * where the database lives. */
export interface Cohort {
  cards?: number
  decks?: number
  friends?: number
  games?: number
}

function cohortFields(cohort: Cohort): Record<string, string | number> {
  const fields: Record<string, string | number> = {}
  if (cohort.cards != null) fields.owned = sizeBucket(cohort.cards)
  if (cohort.decks != null) fields.decks = cohort.decks
  if (cohort.friends != null) fields.friends = cohort.friends
  if (cohort.games != null) fields.games = cohort.games
  return fields
}

async function openSession(kind: 'boot' | 'resume', loadCohort?: () => Promise<Cohort>): Promise<void> {
  // Set before the awaits: anything tracked while the cohort loads belongs
  // to this visit already.
  sessionId = uid().slice(0, 12)
  sessionStartedAt = Date.now()
  sessionScreens = 0
  sessionScans = 0
  sessionOpen = true
  hiddenAt = 0
  const [identity, cohort] = await Promise.all([
    bumpIdentity().catch(() => null),
    Promise.resolve()
      .then(() => loadCohort?.() ?? {})
      .catch(() => ({}) as Cohort),
  ])
  track('app_open', {
    ...describeDevice(typeof navigator === 'undefined' ? {} : navigator, typeof window === 'undefined' ? {} : window),
    ...cohortFields(cohort),
    version: APP_VERSION,
    kind,
    sessions: identity?.sessions ?? 1,
    activeDays: identity?.activeDays ?? 1,
    ageDays: identity ? Math.floor((Date.now() - identity.firstSeen) / DAY_MS) : 0,
    returning: (identity?.sessions ?? 1) > 1,
    sw: typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller,
  })
}

/** Diagnostics must never take the app down with them. */
function beginSession(kind: 'boot' | 'resume', loadCohort?: () => Promise<Cohort>): void {
  openSession(kind, loadCohort).catch(() => {})
}

function closeSession(): void {
  if (!sessionOpen) return
  sessionOpen = false
  hiddenAt = Date.now()
  track('session_end', {
    secs: Math.round((hiddenAt - sessionStartedAt) / 1000),
    screens: sessionScreens,
    scans: sessionScans,
  })
}

/** Screen names come from the router's fixed set — no free text reaches here. */
export function trackScreen(screen: string): void {
  track('screen_view', { screen, first: sessionScreens === 0 })
}

let sessionInstalled = false

/**
 * Opens a session now and keeps it in step with the foreground. A session_end
 * emitted as the app hides may not survive the tab closing — it is written
 * locally either way and ships with the next batch, so counts settle rather
 * than vanish.
 */
export function installSessionTracking(loadCohort?: () => Promise<Cohort>): void {
  if (sessionInstalled || typeof window === 'undefined') return
  sessionInstalled = true
  beginSession('boot', loadCohort)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      closeSession()
      return
    }
    // Never hidden yet — nothing to resume.
    if (!hiddenAt) return
    if (Date.now() - hiddenAt > SESSION_GAP_MS) {
      beginSession('resume', loadCohort)
      return
    }
    // Same visit continuing: only foreground time is counted towards it.
    sessionStartedAt = Date.now()
    sessionOpen = true
  })
  window.addEventListener('pagehide', closeSession)
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

export interface FailureStats {
  total: number
  /** Where the pipeline gave up: no-text, no-match, api. */
  byStage: Record<string, number>
  byGame: Record<string, number>
  /** Repeat offenders, hashed, most-failed first. */
  cards: { card: string; game: string; n: number }[]
}

export function failureStats(events: AnalyticsEvent[], topN = 8): FailureStats {
  const byStage: Record<string, number> = {}
  const byGame: Record<string, number> = {}
  const perCard = new Map<string, { card: string; game: string; n: number }>()
  let total = 0
  for (const event of events) {
    if (event.t !== 'scan_failure') continue
    total++
    const stage = typeof event.data.stage === 'string' ? event.data.stage : 'unknown'
    const game = typeof event.data.game === 'string' ? event.data.game : 'unknown'
    byStage[stage] = (byStage[stage] ?? 0) + 1
    byGame[game] = (byGame[game] ?? 0) + 1
    // Only failures that read *something* can name a repeat offender; a frame
    // the scanner never read has nothing to group by.
    const card = typeof event.data.card === 'string' ? event.data.card : ''
    if (!card) continue
    const row = perCard.get(card) ?? { card, game, n: 0 }
    row.n++
    perCard.set(card, row)
  }
  const cards = [...perCard.values()].sort((a, b) => b.n - a.n).slice(0, topN)
  return { total, byStage, byGame, cards }
}

export interface UsageStats {
  sessions: number
  screens: Record<string, number>
  /** Median foreground seconds per visit. */
  medianSecs: number
  platforms: Record<string, number>
  /** Opens from an installed (home-screen) copy. */
  installs: number
}

export function usageStats(events: AnalyticsEvent[]): UsageStats {
  const screens: Record<string, number> = {}
  const platforms: Record<string, number> = {}
  const lengths: number[] = []
  let sessions = 0
  let installs = 0
  for (const event of events) {
    if (event.t === 'app_open') {
      sessions++
      const platform = typeof event.data.platform === 'string' ? event.data.platform : 'unknown'
      platforms[platform] = (platforms[platform] ?? 0) + 1
      if (event.data.standalone === true) installs++
    } else if (event.t === 'screen_view') {
      const screen = typeof event.data.screen === 'string' ? event.data.screen : 'unknown'
      screens[screen] = (screens[screen] ?? 0) + 1
    } else if (event.t === 'session_end' && typeof event.data.secs === 'number') {
      lengths.push(event.data.secs)
    }
  }
  return { sessions, screens, medianSecs: percentile(lengths, 50), platforms, installs }
}

export interface Insights {
  days: number
  since: number
  scans: ScanStats
  failures: FailureStats
  usage: UsageStats
  counts: Record<EventType, number>
  total: number
  oldestAt: number | null
  lastFlushAt: number | null
  queued: number
  /** Install record — lifetime, not windowed by `days`. */
  device: string | null
  firstSeen: number | null
  allSessions: number
  activeDays: number
}

function emptyInsights(days: number, since: number): Insights {
  return {
    days,
    since,
    scans: { attempts: 0, hits: 0, successRate: 0, byEngine: {}, missReasons: {} },
    failures: { total: 0, byStage: {}, byGame: {}, cards: [] },
    usage: { sessions: 0, screens: {}, medianSecs: 0, platforms: {}, installs: 0 },
    counts: countByType([]),
    total: 0,
    oldestAt: null,
    lastFlushAt: null,
    queued: 0,
    device: null,
    firstSeen: null,
    allSessions: 0,
    activeDays: 0,
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
    // Read the install id rather than deviceId(): opening Settings shouldn't
    // mint an identity for someone who has never sent anything.
    const device = await adb.meta.get('device')
    return {
      days,
      since,
      scans: scanStats(events),
      failures: failureStats(events),
      usage: usageStats(events),
      counts: countByType(events),
      total,
      oldestAt: oldest?.at ?? null,
      lastFlushAt: lastFlushAt || null,
      queued,
      device: typeof device?.value === 'string' ? device.value : null,
      firstSeen: (await metaNumber('firstSeen', 0)) || null,
      allSessions: await metaNumber('sessions', 0),
      activeDays: await metaNumber('activeDays', 0),
    }
  } catch {
    return emptyInsights(days, since)
  }
}

export async function clearAnalytics(): Promise<void> {
  try {
    await adb.events.clear()
    // The install record is part of the log: "clear" has to mean the counts
    // and the identity behind them, or the next upload re-links the two.
    await adb.meta.bulkDelete(['flushedThrough', 'lastFlushAt', 'device', 'firstSeen', 'sessions', 'lastDay', 'activeDays'])
    devicePromise = null
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

interface InstallRecord {
  firstSeen: number
  sessions: number
  activeDays: number
}

function payload(events: AnalyticsEvent[], device: string, install: InstallRecord) {
  return {
    app: 'cardstock',
    v: APP_VERSION,
    device,
    ...install,
    sentAt: new Date().toISOString(),
    events: events.map((event) => ({ t: event.t, at: event.at, ...event.data })),
  }
}

function byteLength(text: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length
}

export async function flushTelemetry({ force = false, keepalive = false } = {}): Promise<void> {
  if (flushing) return
  // Still doubly gated, but on the two things that can actually differ: whether
  // this BUILD has somewhere to post to, and whether this USER said yes. The
  // destination is no longer a pair of text fields nobody could fill in.
  const config = settings()
  // Three gates, and each answers a different question: does this build have a
  // receiver, has this person been TOLD, and did they say yes. The middle one
  // is what makes an on-by-default sane — nothing ships before the disclosure
  // has been shown, however the flag got set.
  if (!DIAG_AVAILABLE || !config.diagConsentAt || !config.diagShare) return
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
    const install: InstallRecord = {
      firstSeen: await metaNumber('firstSeen', 0),
      sessions: await metaNumber('sessions', 0),
      activeDays: await metaNumber('activeDays', 0),
    }
    // The RPC argument name is `p_batch` — see `ingest_events()` in migration
    // 0007. The envelope inside it is unchanged.
    let body = JSON.stringify({ p_batch: payload(events, device, install) })
    while (keepalive && events.length > 1 && byteLength(body) > KEEPALIVE_BYTES) {
      events = events.slice(0, Math.floor(events.length / 2))
      body = JSON.stringify({ p_batch: payload(events, device, install) })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS)
    let ok = false
    try {
      ok = (
        await fetch(DIAG_ENDPOINT, {
          method: 'POST',
          // The publishable key, not a bearer token: this posts as `anon` and
          // is deliberately never associated with the signed-in user. Sending
          // the session JWT here would tie a content-free counter to an
          // account, which is the one thing this log is built not to do.
          headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
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

/**
 * Record that the user has now been told, and draw a line under everything
 * collected before that moment.
 *
 * The line is the point. Flipping `diagShare` on for an install that has been
 * running for weeks would otherwise upload weeks of events gathered while the
 * answer was no — retroactive consent, which is not consent. Advancing
 * `flushedThrough` to the newest event id means only what happens AFTER the
 * disclosure is ever sent.
 *
 * Called for both answers. Someone who declines still gets the line drawn, so
 * that changing their mind later starts from the same clean point.
 */
export async function noteDiagConsent(share: boolean): Promise<void> {
  try {
    const newest = await adb.events.orderBy('id').last()
    if (typeof newest?.id === 'number') {
      await adb.meta.put({ key: 'flushedThrough', value: newest.id })
    }
  } catch {
    /* diagnostics only */
  }
  settings().set({ diagShare: share, diagConsentAt: Date.now() })
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
