import { track } from './analytics'
import { applyTradeReply, db, recordIncomingTrade, upsertFriendFromProfile } from './db'
import { settings } from './settings'
import { buildProfilePayload, myProfile, sanitizePayload } from './social'
import type { ProfilePayload, ReplyPayload, SocialPayload, TradePayload } from './types'
import { uid } from './util'

/**
 * Optional live sync against a Cardstock sync server (`server/sync-server.mjs`,
 * or the hosted backend later). The app stays local-first: without a server
 * address nothing here runs and links remain the way binders travel.
 *
 * What sync adds is polling, not trust. Everything the server returns is
 * decoded through the same sanitizers as a pasted link — a hostile or buggy
 * server can only ever hand us a well-formed profile/trade/reply.
 */

const REQUEST_TIMEOUT_MS = 12_000
const POLL_INTERVAL_MS = 20_000
/** Skip the PUT when the binder hasn't actually changed since last publish. */
let lastPublishedHash: string | null = null

export interface SyncSummary {
  published: boolean
  friendsUpdated: number
  tradesReceived: number
  repliesApplied: number
}

export interface SyncHealth {
  app: string
  v: number
  binders: number
}

export interface DirectoryEntry {
  id: string
  name: string
  updatedAt: number
  cards: number
  wants: number
}

/** Trim a user-typed address into an origin we can build paths on. */
export function normalizeSyncUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export function syncConfigured(): boolean {
  const config = settings()
  return config.syncOn && !!config.syncUrl
}

/** The token that proves this device owns its profile id on the server. */
function deviceToken(): string {
  const config = settings()
  if (!config.syncToken) config.set({ syncToken: uid() })
  return settings().syncToken
}

async function api<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const base = normalizeSyncUrl(settings().syncUrl)
  if (!base) throw new Error('No sync server address set')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.auth ? { Authorization: `Bearer ${deviceToken()}` } : {}),
        ...init.headers,
      },
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
    const text = await res.text()
    let body: any = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      throw new Error('That address answered with something that is not a Cardstock sync server')
    }
    if (!res.ok) throw new Error(body?.error ?? `Server said ${res.status}`)
    return body as T
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('The sync server did not answer in time')
    if (err instanceof TypeError) throw new Error('Could not reach that address — is the sync server running?')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function checkSyncServer(url: string): Promise<SyncHealth> {
  const base = normalizeSyncUrl(url)
  if (!base) throw new Error('Enter the address the sync server printed (e.g. http://192.168.1.20:8787)')
  const previous = settings().syncUrl
  settings().set({ syncUrl: base })
  try {
    const health = await api<SyncHealth>('/v1/health')
    if (health?.app !== 'cardstock-sync') throw new Error('That is not a Cardstock sync server')
    return health
  } catch (err) {
    settings().set({ syncUrl: previous })
    throw err
  }
}

/* --- publish / pull ------------------------------------------------------- */

function hashPayload(payload: ProfilePayload): string {
  // Cheap change detector: the wire form minus its timestamp.
  const { at, ...rest } = payload
  void at
  return JSON.stringify(rest)
}

/** Push my binder up, unless nothing changed since the last publish. */
export async function publishBinder(force = false): Promise<boolean> {
  const me = myProfile()
  if (!me.name) return false
  const [items, wants] = await Promise.all([db.collection.toArray(), db.wants.toArray()])
  const payload = buildProfilePayload(items, me, wants)
  const hash = hashPayload(payload)
  if (!force && hash === lastPublishedHash) return false
  await api(`/v1/binders/${encodeURIComponent(me.id)}`, {
    method: 'PUT',
    auth: true,
    body: JSON.stringify({ app: 'cardstock-social', v: 1, ...payload }),
  })
  lastPublishedHash = hash
  return true
}

/** Re-read every followed binder; returns how many actually changed. */
async function pullFriends(): Promise<number> {
  const friends = await db.friends.toArray()
  let updated = 0
  for (const friend of friends) {
    try {
      const row = await api<{ updatedAt: number; payload: unknown }>(`/v1/binders/${encodeURIComponent(friend.id)}`)
      const payload = sanitizePayload(row.payload)
      if (payload.kind !== 'profile') continue
      // Their own export stamp decides freshness, so a re-publish of identical
      // content doesn't churn local rows.
      if (payload.at <= friend.exportedAt) continue
      await upsertFriendFromProfile(payload)
      updated++
    } catch {
      // A friend who hasn't published here yet is normal, not an error.
    }
  }
  return updated
}

/** Drain my inbox: proposals become trades, replies update existing ones. */
async function pullInbox(): Promise<{ trades: number; replies: number }> {
  const me = myProfile()
  const since = settings().syncCursor
  const res = await api<{ items: { at: number; payload: unknown }[]; at: number }>(
    `/v1/inbox/${encodeURIComponent(me.id)}?since=${since}`,
    { auth: true },
  )
  let trades = 0
  let replies = 0
  let cursor = since
  for (const item of res.items ?? []) {
    cursor = Math.max(cursor, item.at)
    let payload: SocialPayload
    try {
      payload = sanitizePayload(item.payload)
    } catch {
      continue // junk in the inbox is skipped, never fatal
    }
    if (payload.kind === 'trade') {
      const { tradeFromPayload } = await import('./social')
      if ((await recordIncomingTrade(tradeFromPayload(payload))) === 'saved') trades++
    } else if (payload.kind === 'reply') {
      if (await applyTradeReply(payload)) replies++
    }
  }
  settings().set({ syncCursor: cursor })
  return { trades, replies }
}

/** Hand a proposal or reply to the other party's inbox. */
export async function sendToInbox(recipientId: string, payload: TradePayload | ReplyPayload): Promise<void> {
  if (!recipientId) throw new Error('That trade has no synced recipient')
  await api(`/v1/inbox/${encodeURIComponent(recipientId)}`, {
    method: 'POST',
    body: JSON.stringify({ app: 'cardstock-social', v: 1, ...payload }),
  })
}

export async function fetchDirectory(): Promise<DirectoryEntry[]> {
  const res = await api<{ binders: DirectoryEntry[] }>('/v1/directory')
  return res.binders ?? []
}

/** Follow someone listed in the server directory. */
export async function followFromServer(id: string): Promise<ProfilePayload> {
  const row = await api<{ payload: unknown }>(`/v1/binders/${encodeURIComponent(id)}`)
  const payload = sanitizePayload(row.payload)
  if (payload.kind !== 'profile') throw new Error('That id does not hold a binder')
  await upsertFriendFromProfile(payload)
  return payload
}

/* --- the loop ------------------------------------------------------------- */

let running = false

export async function syncNow(force = false): Promise<SyncSummary> {
  if (!syncConfigured()) throw new Error('Live sync is off')
  if (running) return { published: false, friendsUpdated: 0, tradesReceived: 0, repliesApplied: 0 }
  running = true
  try {
    const published = await publishBinder(force)
    const friendsUpdated = await pullFriends()
    const inbox = await pullInbox()
    settings().set({ syncAt: Date.now() })
    if (published || friendsUpdated || inbox.trades || inbox.replies) {
      track('sync_run', {
        published,
        friends: friendsUpdated,
        trades: inbox.trades,
        replies: inbox.replies,
      })
    }
    return {
      published,
      friendsUpdated,
      tradesReceived: inbox.trades,
      repliesApplied: inbox.replies,
    }
  } finally {
    running = false
  }
}

let loopTimer: ReturnType<typeof setInterval> | null = null

/** Poll while the app is in front; a hidden tab syncs nothing. */
export function startSyncLoop(): void {
  if (loopTimer || typeof window === 'undefined') return
  const tick = () => {
    if (document.visibilityState !== 'visible' || !syncConfigured()) return
    syncNow().catch(() => {
      /* offline or server down — the next tick tries again */
    })
  }
  loopTimer = setInterval(tick, POLL_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick()
  })
  setTimeout(tick, 2_000)
}

/** Forget the publish cache + cursor (switching servers or identities). */
export function resetSyncState(): void {
  lastPublishedHash = null
  settings().set({ syncCursor: 0, syncAt: 0 })
}
