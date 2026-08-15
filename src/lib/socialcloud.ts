/**
 * Hosted social: accounts, handles, mutual friends, a trade inbox and global
 * want-matching, against the Supabase project in `cloudconfig.ts`.
 *
 * Schema and the reasoning behind it: `supabase/migrations/0001`–`0004` and
 * `docs/social.md`. Two things from there are load-bearing here:
 *
 * - **Scope drives visibility.** A `scope: 'trade'` binder is readable by any
 *   signed-in user; `scope: 'all'` only by accepted friends. This module never
 *   decides that — it passes the user's own scope to `publish_binder()`, which
 *   owns the rule. Do not add a second notion of visibility on this side.
 * - **Everything the server returns is untrusted** and goes through the
 *   `social.ts` sanitizers, exactly like a pasted link (decision 7). Hosting
 *   earns the server no trust it would not extend to a string from a chat app.
 *
 * Off unless `socialOn` **and** a session **and** a handle. With it off,
 * nothing here runs and the app is exactly as social as it always was: links
 * and files, published nowhere.
 */

import { track } from './analytics'
import { authHeaders, CloudError, currentUserId, freshToken, isSignedIn, readError } from './authsession'
import { CLOUD_AVAILABLE, SUPABASE_URL } from './cloudconfig'
import { applyTradeReply, db, recordIncomingTrade, upsertFriendFromProfile } from './db'
import { settings } from './settings'
import { buildProfilePayload, myProfile, sanitizePayload, wantKeyFor } from './social'
import type { ProfilePayload, ReplyPayload, SocialPayload, TradePayload } from './types'

const POLL_INTERVAL_MS = 25_000
/** One page of inbox drain. More than this in one poll is not a real inbox. */
const INBOX_PAGE = 200

export interface SocialProfile {
  userId: string
  handle: string
  displayName: string
}

export interface FriendRequest extends SocialProfile {
  at: number
}

export interface WantMatch {
  wantKey: string
  userId: string
  handle: string
  displayName: string
  qty: number
}

export interface SocialSummary {
  published: boolean
  friendsUpdated: number
  tradesReceived: number
  repliesApplied: number
}

/** A project is configured at all — a fork without one never sees this UI. */
export function socialAvailable(): boolean {
  return CLOUD_AVAILABLE
}

/**
 * Hosted social is usable on this device: signed in, with a handle.
 *
 * Deliberately NOT the same question as "am I publishing my binder".
 * Claiming a handle makes you findable and reachable — friends can add you,
 * trades can arrive — and publishes no cards at all. Putting your binder up
 * is the separate, privacy-bearing act below, because bundling them would
 * mean joining costs you a decision about who can see your collection.
 */
export function socialConfigured(): boolean {
  const config = settings()
  return CLOUD_AVAILABLE && !!config.socialHandle && isSignedIn()
}

/** My binder is being published and kept current. */
export function socialPublishing(): boolean {
  return socialConfigured() && settings().socialOn
}

/* ------------------------------------------------------------------ plumbing */

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await freshToken()
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: { ...authHeaders(token), ...init.headers },
  })
  if (!res.ok) throw new CloudError(await readError(res, 'The server refused that'))
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

const rpc = <T>(fn: string, args: Record<string, unknown>): Promise<T> =>
  rest<T>(`/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })

/**
 * Turn a Postgres `raise exception 'handle_taken'` into something a person can
 * read. The RPCs raise short machine codes on purpose so the copy lives here,
 * next to the UI, rather than in SQL.
 */
const RPC_MESSAGES: Record<string, string> = {
  not_signed_in: 'Sign in first',
  bad_handle: 'Handles can use letters, numbers and underscores, 3–24 characters',
  handle_taken: 'That handle is already taken — try another',
  handle_reserved: 'That handle is reserved',
  handle_locked: 'Your handle is permanent, so it cannot be changed',
  no_profile: 'Claim a handle first',
  bad_display_name: 'Add a display name',
  no_such_handle: 'No collector with that handle',
  cannot_friend_self: 'That is your own handle',
  bad_scope: 'Pick what to share first',
  bad_recipient: 'That is not someone you can send to',
  not_reachable: 'They are not accepting proposals — add each other as friends first',
  inbox_full: 'They have too many unanswered proposals from you already',
  payload_too_large: 'That trade is too big to send',
}

function humanize(err: unknown): never {
  const raw = err instanceof Error ? err.message : String(err)
  for (const [code, message] of Object.entries(RPC_MESSAGES)) {
    if (raw.includes(code)) throw new CloudError(message)
  }
  throw err instanceof Error ? err : new CloudError(raw)
}

const call = <T>(fn: string, args: Record<string, unknown>): Promise<T> => rpc<T>(fn, args).catch(humanize)

/* ------------------------------------------------------------------ identity */

interface ProfileRow {
  user_id: string
  handle: string
  display_name: string
}

const toProfile = (row: ProfileRow): SocialProfile => ({
  userId: row.user_id,
  handle: row.handle,
  displayName: row.display_name,
})

/**
 * Adopt the account as this device's one social identity.
 *
 * `profileId` is what link shares travel under, so pointing it at the Supabase
 * user id makes a link-added friend and a handle-added friend the SAME person
 * rather than two rows for one collector. It also means the identity survives
 * clearing storage, which the minted `uid()` never did.
 */
function adoptIdentity(profile: SocialProfile): SocialProfile {
  settings().set({ socialHandle: profile.handle, profileId: profile.userId })
  return profile
}

export const normalizeHandle = (handle: string): string =>
  handle.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '')

/**
 * Claim my handle. **One per account, permanently** — see migration 0010.
 *
 * Re-sending the handle I already have is how the display name is changed by
 * an older client, and the server still allows exactly that; sending a
 * *different* one raises `handle_locked` rather than renaming me. Never call
 * this to "fix" a handle: check `loadMyProfile()` first and don't offer the
 * field at all if one comes back.
 */
export async function claimHandle(handle: string, displayName: string): Promise<SocialProfile> {
  const row = await call<ProfileRow | ProfileRow[]>('set_profile', {
    p_handle: normalizeHandle(handle),
    p_display_name: displayName,
  })
  return adoptIdentity(toProfile(Array.isArray(row) ? row[0] : row))
}

/** Whether a handle can still be claimed — asked while the user types. */
export type HandleStatus = 'ok' | 'mine' | 'taken' | 'reserved' | 'bad'

/**
 * Ask the server whether a handle is free.
 *
 * `lookupHandle` is not a substitute: it reads `profiles`, which knows nothing
 * about handles that were claimed and then erased. Those are still spoken for,
 * and finding that out at the moment of claiming — after being told the name
 * was permanent — is the worst possible time.
 */
export async function checkHandle(handle: string): Promise<HandleStatus> {
  const clean = normalizeHandle(handle)
  if (clean.length < 3) return 'bad'
  return await call<HandleStatus>('handle_available', { p_handle: clean })
}

/** Change the name friends see. The handle it sits beside never moves. */
export async function updateDisplayName(name: string): Promise<SocialProfile> {
  const row = await call<ProfileRow | ProfileRow[]>('set_display_name', { p_display_name: name.trim() })
  return toProfile(Array.isArray(row) ? row[0] : row)
}

/** My stored profile, or null if I have never claimed a handle. */
export async function loadMyProfile(): Promise<SocialProfile | null> {
  const me = currentUserId()
  if (!me) return null
  const rows = await rest<ProfileRow[]>(`/profiles?user_id=eq.${me}&select=user_id,handle,display_name`)
  if (!rows?.length) return null
  return adoptIdentity(toProfile(rows[0]))
}

/**
 * Pull the account's handle down onto a device that has never seen it.
 *
 * `socialHandle` is a localStorage cache, so a brand-new device has none even
 * when the account has had one for a year — and everything that asks "are they
 * set up?" (`nextConnectStep`, the nudge, the welcome screen) reads that cache.
 * Without this, signing in on a second phone looks exactly like never having
 * claimed a handle, which is precisely the mistake that used to rename people.
 *
 * Runs at most once per session: on success the cache is filled, and a null
 * result means this account genuinely has no handle, which re-asking every
 * 25 seconds would not change.
 */
let hydrating: Promise<unknown> | null = null

export function hydrateIdentity(): Promise<unknown> {
  if (hydrating) return hydrating
  if (!CLOUD_AVAILABLE || !isSignedIn() || settings().socialHandle) return Promise.resolve(null)
  hydrating = loadMyProfile().catch(() => {
    // Offline or a blip — let the next tick try again rather than spending the
    // rest of the session believing this account has no handle.
    hydrating = null
    return null
  })
  return hydrating
}

export async function lookupHandle(handle: string): Promise<SocialProfile | null> {
  const clean = handle.trim().toLowerCase().replace(/^@/, '')
  if (!clean) return null
  const rows = await rest<ProfileRow[]>(
    `/profiles?handle=eq.${encodeURIComponent(clean)}&select=user_id,handle,display_name`,
  )
  return rows?.length ? toProfile(rows[0]) : null
}

/* ---------------------------------------------------------------- publishing */

/** Skip the write when the binder has not actually changed since last publish. */
let lastPublishedHash: string | null = null

function hashPayload(payload: ProfilePayload): string {
  const { at, ...rest } = payload
  void at
  return JSON.stringify(rest)
}

/**
 * The rows that enter the global want index.
 *
 * Card-level and deduped by want key, because `wantKeyFor` is card-level:
 * two printings of one Charizard are one offer, and a want for "Charizard"
 * matches either. Quantities are summed so the match list can say how many
 * copies are going.
 */
function offersFrom(payload: ProfilePayload): { want_key: string; game: string; name: string; qty: number }[] {
  const byKey = new Map<string, { want_key: string; game: string; name: string; qty: number }>()
  for (const card of payload.cards) {
    if (card.forTrade <= 0) continue
    const key = wantKeyFor(card.game, card.name)
    const existing = byKey.get(key)
    if (existing) existing.qty = Math.min(9999, existing.qty + card.forTrade)
    else byKey.set(key, { want_key: key, game: card.game, name: card.name, qty: Math.min(9999, card.forTrade) })
  }
  return [...byKey.values()]
}

/**
 * Publish my binder. Returns false when nothing changed.
 *
 * The scope handed to the server is the user's own `shareScope` — the same
 * one driving link shares — so what a stranger can see is never wider than
 * what the Friends screen says is being shared.
 */
export async function publishBinder(force = false): Promise<boolean> {
  const userId = currentUserId()
  if (!userId) throw new CloudError('Sign in first')
  // The account id wins over whatever `profileId` holds: the row is keyed by
  // auth.uid() server-side, and a payload claiming a different id would make
  // a friend's copy disagree with the row it came from.
  const me = { ...myProfile(), id: userId }
  const [items, wants] = await Promise.all([db.collection.toArray(), db.wants.toArray()])
  const payload = buildProfilePayload(items, me, wants)
  const hash = hashPayload(payload)
  if (!force && hash === lastPublishedHash) return false

  await call('publish_binder', {
    p_scope: payload.scope,
    p_payload: { app: 'cardstock-social', v: 1, ...payload },
    p_card_count: payload.cards.length,
    p_want_count: payload.wants?.length ?? 0,
    p_offers: offersFrom(payload),
  })
  lastPublishedHash = hash
  return true
}

/** Stop publishing: drops the binder row and every want-index entry with it. */
export async function unpublish(): Promise<void> {
  await call('unpublish_binder', {})
  lastPublishedHash = null
}

/* ------------------------------------------------------------------- friends */

interface FriendshipRow {
  requester: string
  addressee: string
  status: string
  created_at: string
}

/** Accepted friendships, as the other person's user id. */
export async function listFriendIds(): Promise<string[]> {
  const me = currentUserId()
  if (!me) return []
  const rows = await rest<FriendshipRow[]>('/friendships?status=eq.accepted&select=requester,addressee')
  return (rows ?? []).map((row) => (row.requester === me ? row.addressee : row.requester))
}

export interface PendingRequests {
  /** They asked me — these need an answer. */
  incoming: FriendRequest[]
  /** I asked them — waiting. */
  outgoing: FriendRequest[]
}

export async function listRequests(): Promise<PendingRequests> {
  const me = currentUserId()
  if (!me) return { incoming: [], outgoing: [] }
  const rows = await rest<FriendshipRow[]>(
    '/friendships?status=eq.pending&select=requester,addressee,status,created_at',
  )
  const others = (rows ?? []).map((row) => ({
    other: row.requester === me ? row.addressee : row.requester,
    incoming: row.addressee === me,
    at: Date.parse(row.created_at) || Date.now(),
  }))
  if (!others.length) return { incoming: [], outgoing: [] }

  // One lookup for every counterparty rather than one per row.
  const ids = [...new Set(others.map((o) => o.other))]
  const profiles = await rest<ProfileRow[]>(
    `/profiles?user_id=in.(${ids.join(',')})&select=user_id,handle,display_name`,
  )
  const byId = new Map((profiles ?? []).map((p) => [p.user_id, toProfile(p)]))

  const incoming: FriendRequest[] = []
  const outgoing: FriendRequest[] = []
  for (const entry of others) {
    const profile = byId.get(entry.other)
    // A request from someone with no profile row is not renderable; skip it
    // rather than showing a blank name the user cannot judge.
    if (!profile) continue
    ;(entry.incoming ? incoming : outgoing).push({ ...profile, at: entry.at })
  }
  return { incoming, outgoing }
}

/** Ask by handle. Auto-accepts if they already asked me. */
export async function requestFriend(handle: string): Promise<'pending' | 'accepted'> {
  const clean = handle.trim().toLowerCase().replace(/^@/, '')
  const result = await call<string>('request_friend', { p_handle: clean })
  return result === 'accepted' ? 'accepted' : 'pending'
}

/** Answer a request addressed to me. Declining blocks a re-ask loop. */
export async function answerRequest(requesterId: string, accept: boolean): Promise<void> {
  const me = currentUserId()
  if (!me) throw new CloudError('Sign in first')
  await rest(`/friendships?requester=eq.${requesterId}&addressee=eq.${me}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: accept ? 'accepted' : 'blocked', updated_at: new Date().toISOString() }),
  })
}

export async function unfriend(otherId: string): Promise<void> {
  const me = currentUserId()
  if (!me) return
  // Either column order may hold the edge, and PostgREST has no OR across
  // two equality pairs without `or=(...)`; two deletes is clearer than one
  // clever filter, and the second is a no-op.
  await rest(`/friendships?requester=eq.${me}&addressee=eq.${otherId}`, { method: 'DELETE' })
  await rest(`/friendships?requester=eq.${otherId}&addressee=eq.${me}`, { method: 'DELETE' })
}

interface BinderRow {
  user_id: string
  revision: number
  payload?: unknown
}

const IS_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Re-read every binder I am entitled to and that actually moved.
 *
 * The **server's accepted-friend list drives this, not the local one**: a
 * friendship accepted on the other person's device exists only server-side
 * until something fetches it, so keying off `db.friends` alone would mean a
 * newly accepted friend never appears until they were somehow imported by
 * hand. Locally-known friends are unioned in so a link-imported friend who
 * later signs up keeps refreshing.
 *
 * Two steps on purpose: revisions first (a few bytes per friend), payloads
 * only for the ones that changed. Fetching every friend's cards on a
 * 25-second poll would move megabytes to discover that nothing happened.
 */
export async function pullFriends(): Promise<number> {
  const friends = await db.friends.toArray()
  const byId = new Map(friends.map((f) => [f.id, f]))
  const serverIds = await listFriendIds()
  // Friends imported from a link have a legacy uid, not a Supabase user id;
  // they are not on the server and asking for them would be a wasted request.
  const ids = [...new Set([...serverIds, ...friends.map((f) => f.id)])].filter((id) => IS_USER_ID.test(id))
  if (!ids.length) return 0

  const heads = await rest<BinderRow[]>(`/binders?user_id=in.(${ids.join(',')})&select=user_id,revision`)
  // An unknown id has no stored revision, so it reads as stale and is
  // fetched — which is exactly how a just-accepted friend arrives.
  const stale = (heads ?? []).filter((row) => byId.get(row.user_id)?.remoteRev !== row.revision)
  if (!stale.length) return 0

  const full = await rest<BinderRow[]>(
    `/binders?user_id=in.(${stale.map((r) => r.user_id).join(',')})&select=user_id,revision,payload`,
  )
  let updated = 0
  for (const row of full ?? []) {
    try {
      const payload = sanitizePayload(row.payload)
      if (payload.kind !== 'profile') continue
      await upsertFriendFromProfile(payload, undefined, row.revision)
      updated++
    } catch {
      // A malformed binder is one friend's problem, not a failed sync.
    }
  }
  return updated
}

/* --------------------------------------------------------------------- inbox */

/** Hand a proposal or reply to someone's inbox. */
export async function sendToInbox(recipientId: string, payload: TradePayload | ReplyPayload): Promise<void> {
  if (!recipientId) throw new CloudError('That trade has no hosted recipient')
  await call('send_to_inbox', {
    p_recipient: recipientId,
    p_payload: { app: 'cardstock-social', v: 1, ...payload },
  })
}

interface InboxRow {
  id: number
  sender: string
  payload: unknown
}

/**
 * Drain my inbox: proposals become trades, replies update existing ones.
 *
 * The `sender` COLUMN is authoritative, not the payload's `from.id` — the
 * former is stamped server-side from the caller's JWT, the latter is whatever
 * the sending client wrote. They normally agree; when they do not, the column
 * is the one that was checked.
 */
export async function drainInbox(): Promise<{ trades: number; replies: number }> {
  const since = settings().socialCursor
  const rows = await rest<InboxRow[]>(
    `/inbox?id=gt.${since}&select=id,sender,payload&order=id.asc&limit=${INBOX_PAGE}`,
  )
  if (!rows?.length) return { trades: 0, replies: 0 }

  let trades = 0
  let replies = 0
  let cursor = since
  for (const row of rows) {
    cursor = Math.max(cursor, row.id)
    let payload: SocialPayload
    try {
      payload = sanitizePayload(row.payload)
    } catch {
      continue // junk in the inbox is skipped, never fatal
    }
    try {
      if (payload.kind === 'trade') {
        const { tradeFromPayload } = await import('./social')
        const trade = tradeFromPayload(payload)
        trade.friendId = row.sender
        if ((await recordIncomingTrade(trade)) === 'saved') trades++
      } else if (payload.kind === 'reply') {
        if (await applyTradeReply(payload)) replies++
      }
    } catch {
      // A local write failing must not advance past the item silently — but
      // the cursor has already moved, and both writers are idempotent
      // (recordIncomingTrade keeps an answered proposal, applyTradeReply
      // refuses to reopen a settled trade), so a retry is safe either way.
    }
  }
  settings().set({ socialCursor: cursor })
  // Drained rows are the recipient's to clear; the cursor is the real guard,
  // so a failure here costs storage, never correctness.
  await rest(`/inbox?id=lte.${cursor}`, { method: 'DELETE' }).catch(() => {})
  return { trades, replies }
}

/* ------------------------------------------------------------------ matching */

interface MatchRow {
  want_key: string
  user_id: string
  handle: string
  display_name: string
  qty: number
}

/**
 * "Who is offering the cards I am hunting?" — across every discoverable
 * binder, not just friends. Capped server-side at 200 keys and 20 holders
 * per key.
 */
export async function matchWants(keys: string[]): Promise<WantMatch[]> {
  if (!keys.length) return []
  const rows = await call<MatchRow[]>('match_wants', { p_keys: keys.slice(0, 200) })
  return (rows ?? []).map((row) => ({
    wantKey: row.want_key,
    userId: row.user_id,
    handle: row.handle,
    displayName: row.display_name,
    qty: row.qty,
  }))
}

/* ---------------------------------------------------------------- the erasure */

/** Remove everything published or received. Leaves the vault alone. */
export async function eraseSocial(): Promise<void> {
  await call('erase_social', {})
  lastPublishedHash = null
  // The handle is cleared locally because the profile row is gone — but it is
  // still RESERVED to this account server-side (0010), so coming back means
  // reclaiming the same name rather than finding a stranger wearing it.
  hydrating = null
  settings().set({ socialOn: false, socialHandle: '', socialCursor: 0, socialAt: 0 })
}

/* ---------------------------------------------------------------- the loop */

let running = false

export async function syncSocialNow(force = false): Promise<SocialSummary> {
  if (!socialConfigured()) throw new CloudError('Claim a handle first')
  if (running) return { published: false, friendsUpdated: 0, tradesReceived: 0, repliesApplied: 0 }
  running = true
  try {
    // Friends and the inbox are pulled whether or not I publish: someone who
    // never puts a binder up still has friends to refresh and trades to
    // receive. Only the outbound half is gated.
    const published = settings().socialOn ? await publishBinder(force) : false
    const friendsUpdated = await pullFriends()
    const inbox = await drainInbox()
    settings().set({ socialAt: Date.now() })
    if (published || friendsUpdated || inbox.trades || inbox.replies) {
      track('sync_run', {
        published,
        friends: friendsUpdated,
        trades: inbox.trades,
        replies: inbox.replies,
      })
    }
    return { published, friendsUpdated, tradesReceived: inbox.trades, repliesApplied: inbox.replies }
  } finally {
    running = false
  }
}

let loopTimer: ReturnType<typeof setInterval> | null = null

/** Poll while the app is in front; a hidden tab syncs nothing. */
export function startSocialLoop(): void {
  if (loopTimer || typeof window === 'undefined') return
  const tick = () => {
    if (document.visibilityState !== 'visible') return
    // Ahead of the configured check, because on a device that has only just
    // signed in this is what makes that check true. Signing in on a new phone
    // is meant to be all it takes.
    if (!settings().socialHandle) {
      void hydrateIdentity()
      return
    }
    if (!socialConfigured()) return
    syncSocialNow().catch(() => {
      /* offline or refused — the next tick tries again */
    })
  }
  loopTimer = setInterval(tick, POLL_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick()
  })
  setTimeout(tick, 2_000)
}

/** Forget the publish cache — switching identities or scope. */
export function resetSocialState(): void {
  lastPublishedHash = null
  settings().set({ socialCursor: 0, socialAt: 0 })
}
