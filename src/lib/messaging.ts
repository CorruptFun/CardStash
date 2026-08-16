/**
 * Messages: two collectors talking about a card.
 *
 * The transport half of `supabase/migrations/0019`. Read that file's header
 * before changing anything here — the rules it states (who may open a
 * conversation, what a block does, why this is not the trade inbox) are
 * enforced in SQL, and this module's job is to present them honestly rather
 * than to re-decide them.
 *
 * NO LOCAL MIRROR, for the reasons `marketplace.ts` gives about orders and one
 * more. A conversation is a shared fact between two people, so the server is
 * the only thing that can be right about it; mirroring it into Dexie would buy
 * an offline view of a screen whose every button needs the network anyway. The
 * extra reason is the backup: Dexie rows ride `exportBackup`, the CSV export
 * and the daily Drive backup, and a private conversation with somebody else
 * does not belong in a file the user hands around. Threads are fetched.
 *
 * Everything the server returns is untrusted and is sanitized below, exactly
 * like a pasted link (decision 7) — the `about` block goes through
 * `sanitizeSharedCard`, which is the same door a share link uses, because it
 * is the same wire shape.
 *
 * PLAINTEXT, and it must never be described otherwise. `binders` is plaintext
 * because a friend's app has to read it; this is plaintext for exactly the
 * same reason, and the vault's encryption (15b — a key we hold) does not
 * extend here. Bounded instead: text and one card reference, no attachments,
 * no images, no addresses.
 */

import { track } from './analytics'
import { authHeaders, CloudError, currentUserId, freshToken, isSignedIn, onSignOut, readError } from './authsession'
import { CLOUD_AVAILABLE, SUPABASE_URL } from './cloudconfig'
import { settings } from './settings'
import { sanitizeSharedCard } from './social'
import type { SharedCard } from './types'

/** Same cap the `body` check constraint enforces — stated once on each side. */
export const MESSAGE_MAX_CHARS = 2_000

/** One page of a conversation. Older messages load on demand. */
const PAGE = 200

export interface ChatMessage {
  id: number
  threadId: number
  senderId: string
  body: string
  /** The card this message is about, when it was sent from one. */
  about?: SharedCard
  at: number
}

export interface ChatThread {
  id: number
  otherId: string
  handle: string
  displayName: string
  lastAt: number
  lastPreview: string
  /** Who spoke last — so the list can say "you:" without reading the thread. */
  lastSender: string
  unread: number
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

/**
 * The machine codes `send_message()` raises, in words. Same split as
 * `socialcloud.ts`: SQL raises a short code so the copy lives next to the UI.
 *
 * `thread_full` and `too_many_messages` deliberately say what to do rather
 * than what the server counted. A cap someone hits is nearly always a person
 * who has sent five messages to somebody who has not answered, and telling
 * them the limit is 15 is an invitation to send ten more.
 */
const RPC_MESSAGES: Record<string, string> = {
  not_signed_in: 'Sign in first',
  bad_recipient: 'That is not someone you can message',
  empty_message: 'Write something first',
  message_too_long: `Messages are up to ${MESSAGE_MAX_CHARS} characters`,
  attachment_too_large: 'That card is too big to attach',
  not_reachable: 'They are not reachable — add each other as friends first',
  thread_full: 'Give them a chance to reply before sending more',
  too_many_messages: 'You have sent a lot of messages recently — try again shortly',
  not_in_thread: 'That conversation is not yours',
}

function humanize(err: unknown): never {
  const raw = err instanceof Error ? err.message : String(err)
  for (const [code, message] of Object.entries(RPC_MESSAGES)) {
    if (raw.includes(code)) throw new CloudError(message)
  }
  throw err instanceof Error ? err : new CloudError(raw)
}

const call = <T>(fn: string, args: Record<string, unknown>): Promise<T> =>
  rest<T>(`/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }).catch(humanize)

/**
 * Messaging is reachable on this device.
 *
 * The same test as `socialConfigured()` and deliberately not a separate
 * switch: being reachable IS what claiming a handle buys, and a second toggle
 * would mean someone could be findable, receive trade proposals, and still
 * have no way to answer the person sending them. Not being reachable is
 * expressed by publishing nothing and accepting nobody, which the server
 * already enforces (`can_message`).
 */
export function messagingReady(): boolean {
  return CLOUD_AVAILABLE && !!settings().socialHandle && isSignedIn()
}

/* ------------------------------------------------------------- sanitizing */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asStr = (value: unknown, max: number): string => {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

const asId = (value: unknown): number => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0
}

const asTime = (value: unknown): number => {
  if (typeof value !== 'string') return Date.now()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/**
 * One message row.
 *
 * The body is capped at the same length the column is, and never rendered as
 * anything but text — React escapes it, and nothing downstream turns it into
 * markup. A message is the one place in this app where a stranger's free text
 * reaches another user's screen, so it stays a string all the way down.
 */
export function sanitizeMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null
  const id = asId(raw.id)
  const threadId = asId(raw.thread_id)
  const senderId = asStr(raw.sender, 64)
  const body = asStr(raw.body, MESSAGE_MAX_CHARS)
  if (!id || !threadId || !senderId || !body) return null
  return {
    id,
    threadId,
    senderId,
    body,
    // The same sanitizer a `#/x?d=…` link's cards go through — this is the
    // same wire shape, so it gets the same door rather than a second one.
    about: (raw.about != null && sanitizeSharedCard(raw.about)) || undefined,
    at: asTime(raw.created_at),
  }
}

export function sanitizeThread(raw: unknown): ChatThread | null {
  if (!isRecord(raw)) return null
  const id = asId(raw.thread_id)
  const otherId = asStr(raw.other_id, 64)
  const handle = asStr(raw.handle, 24)
  if (!id || !otherId || !handle) return null
  const unread = Number(raw.unread)
  return {
    id,
    otherId,
    handle,
    displayName: asStr(raw.display_name, 60) || `@${handle}`,
    lastAt: asTime(raw.last_at),
    lastPreview: asStr(raw.last_preview, 140),
    lastSender: asStr(raw.last_sender, 64),
    unread: Number.isFinite(unread) ? Math.max(0, Math.min(9_999, Math.floor(unread))) : 0,
  }
}

/* ------------------------------------------------------------------ reading */

/** My conversations, newest first, with unread counts already worked out. */
export async function listThreads(): Promise<ChatThread[]> {
  if (!messagingReady()) return []
  const rows = await call<unknown[]>('list_threads', {})
  const threads: ChatThread[] = []
  for (const row of rows ?? []) {
    const thread = sanitizeThread(row)
    // A malformed row is one conversation's problem, not a failed load.
    if (thread) threads.push(thread)
  }
  return threads
}

/**
 * One conversation, oldest first.
 *
 * `afterId` pages forward from what is already on screen, which is what the
 * open-thread poll uses: re-reading a long conversation every 25 seconds to
 * find one new line is exactly the cost `pullFriends` avoids with revisions.
 */
export async function loadMessages(threadId: number, afterId = 0): Promise<ChatMessage[]> {
  if (!messagingReady() || !threadId) return []
  const rows = await rest<unknown[]>(
    `/messages?thread_id=eq.${threadId}&id=gt.${afterId}&select=id,thread_id,sender,body,about,created_at&order=id.asc&limit=${PAGE}`,
  )
  const out: ChatMessage[] = []
  for (const row of rows ?? []) {
    const message = sanitizeMessage(row)
    if (message) out.push(message)
  }
  return out
}

/** Can I open a conversation with this account? Asked before offering to. */
export async function canMessage(userId: string): Promise<boolean> {
  if (!messagingReady() || !userId || userId === currentUserId()) return false
  try {
    return (await call<boolean>('can_message', { p_to: userId })) === true
  } catch {
    // Offline is not "no". The send itself is checked server-side regardless,
    // so the honest failure here is to leave the button where it was.
    return false
  }
}

/* ------------------------------------------------------------------ writing */

/** Say something. Returns the thread it landed in, creating it if needed. */
export async function sendMessage(toUserId: string, body: string, about?: SharedCard): Promise<number> {
  if (!messagingReady()) throw new CloudError('Claim a handle first')
  const text = body.trim()
  if (!text) throw new CloudError('Write something first')
  const threadId = asId(
    await call<number>('send_message', {
      p_to: toUserId,
      p_body: text.slice(0, MESSAGE_MAX_CHARS),
      // Only the card, never the whole row a friend's binder holds: `about` is
      // a reference to what is being discussed, not a republication of their
      // binder into a table with a different audience.
      p_about: about ? { ...about } : null,
    }),
  )
  // Content-free, like everything else here: whether a card was attached, not
  // which card, and never the recipient (a handle is identity — decision 20).
  track('message_sent', { about: !!about })
  return threadId
}

export async function markThreadRead(threadId: number): Promise<void> {
  if (!messagingReady() || !threadId) return
  await call('mark_thread_read', { p_thread: threadId })
}

/**
 * Stop hearing from someone, or start again.
 *
 * One-sided and silent by design (0019): the thread leaves my list, their
 * messages are still accepted and stored, and they are never told. Being told
 * you are blocked is an instruction to make a second account.
 */
export async function setThreadBlocked(threadId: number, blocked: boolean): Promise<void> {
  if (!messagingReady() || !threadId) return
  await call('set_thread_block', { p_thread: threadId, p_blocked: blocked })
}

/* ------------------------------------------------------------- the badge */

/**
 * Refresh the unread count the nav badge reads, and return the threads.
 *
 * The count is cached in settings rather than held in a store because the
 * badge has to be right on the FIRST frame after a cold launch — a nav that
 * shows nothing for two seconds and then a "3" is how people learn to ignore
 * it. It is a cache of a server fact, exactly like `socialHandle`, and it is
 * corrected by the next poll whenever it is wrong.
 */
export async function refreshUnread(): Promise<ChatThread[]> {
  const threads = await listThreads()
  const unread = threads.reduce((sum, thread) => sum + thread.unread, 0)
  if (settings().messageUnread !== unread) settings().set({ messageUnread: unread })
  return threads
}

/** Signing out, erasing, or switching accounts: the cached badge is not ours. */
export function resetUnread(): void {
  settings().set({ messageUnread: 0 })
}

// A badge counting the last account's conversations on the next account's
// screen would be a small lie that survives until the first poll.
onSignOut(resetUnread)
