/**
 * One sign-in, shared by the cloud vault and hosted social.
 *
 * Extracted from `cloud.ts` when social arrived, because "who is this user"
 * belongs to neither feature. The alternative — having `socialcloud.ts` import
 * `cloud.ts` — would have made every social action depend on the vault module
 * and its passphrase state, which are unrelated concerns the user can enable
 * independently.
 *
 * Hand-rolled against GoTrue's REST surface rather than `@supabase/supabase-js`
 * for the reasons in `cloud.ts`: the surface used here is five endpoints, the
 * SDK is a large dependency for a bundle already shipping an OCR engine, and —
 * the deciding one — doing it by hand keeps precise control of the redirect
 * behaviour, which is exactly what breaks in iOS Home Screen web apps.
 *
 * **Session tokens live in their own storage key**, NOT in the settings store,
 * so they are never swept into a settings export or a backup file. Which
 * storage — localStorage, or sessionStorage when the user asked not to be
 * remembered — is the whole of what the "Keep me signed in" checkbox controls.
 *
 * ## Staying signed in
 *
 * People reported being signed out, and a checkbox was never going to fix it:
 * sessions have always persisted. Three things did, and all three live below —
 * concurrent callers share one refresh (`refreshing`), a rejected token is
 * re-checked against storage before it ends a session (`redeem`), and tabs
 * share what they learn (`watchOtherTabs`). The checkbox is the smaller, real
 * feature that rides along: a way to say *don't*.
 */

import { SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'

const SESSION_KEY = 'cardstock-cloud-session'
/**
 * "Keep me signed in", stored as its OPPOSITE: `'0'` means don't. Absent —
 * which is every install that has never touched the checkbox — means remember,
 * so the default costs no write and an unreadable storage still defaults to
 * staying signed in.
 *
 * It lives in localStorage even when the answer is "don't remember me", and
 * that is deliberate in two ways. It has to outlive the tab, because the
 * Google round trip destroys the page that held the choice (the same problem
 * `captureReferral()` solves for `?via=`), and it errs toward forgetting: a
 * lingering "no" on a shared machine is the safe direction for a stale
 * preference to fail.
 */
const REMEMBER_KEY = 'cardstock-remember'

export interface CloudSession {
  accessToken: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
  email: string
  userId: string
}

export class CloudError extends Error {}

let session: CloudSession | null = null

/**
 * Reaching a Storage can THROW, not just return null — Safari with cookies
 * blocked raises on the property itself, before any get. Every access goes
 * through here so no caller has to remember that.
 */
function store(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage
  } catch {
    return null
  }
}

/**
 * Is this device one the session should outlive the tab on?
 *
 * Note what this is NOT: it is not a switch that turns persistence on. Sessions
 * have always persisted and still do — the checkbox exists so somebody on a
 * borrowed or shared machine can say *don't*, and it defaults to remembering
 * because that is what the overwhelming majority want and already had.
 */
export function rememberMe(): boolean {
  return store('local')?.getItem(REMEMBER_KEY) !== '0'
}

/**
 * Record the choice and MOVE any live session to the storage it now belongs
 * in, so the answer takes effect on the session already in hand rather than
 * only on the next sign-in.
 */
export function setRememberMe(on: boolean): void {
  const current = loadSession()
  try {
    if (on) store('local')?.removeItem(REMEMBER_KEY)
    else store('local')?.setItem(REMEMBER_KEY, '0')
  } catch {
    /* private mode — the choice lasts for this run only */
  }
  if (current) saveSession(current)
}

/**
 * The session as STORAGE has it, ignoring the in-memory copy.
 *
 * The preferred store is read first, the other as a fallback, because the
 * preference can change between a save and a read — flipping the checkbox must
 * not look like being signed out while `setRememberMe` is mid-move.
 */
function readStored(): CloudSession | null {
  const order = rememberMe() ? (['local', 'session'] as const) : (['session', 'local'] as const)
  for (const kind of order) {
    try {
      const raw = store(kind)?.getItem(SESSION_KEY)
      if (!raw) continue
      const parsed = JSON.parse(raw) as CloudSession
      if (typeof parsed?.accessToken !== 'string' || typeof parsed?.refreshToken !== 'string') continue
      return parsed
    } catch {
      /* corrupt or unreadable — try the other store */
    }
  }
  return null
}

function loadSession(): CloudSession | null {
  if (session) return session
  session = readStored()
  return session
}

/**
 * Write to the store the preference names and clear the other one, so a
 * session never exists in both — a leftover copy in localStorage after the
 * user asked us to forget them is the whole thing the checkbox promises not
 * to do.
 */
function saveSession(next: CloudSession | null): void {
  session = next
  const keep = rememberMe() ? 'local' : 'session'
  try {
    store(keep === 'local' ? 'session' : 'local')?.removeItem(SESSION_KEY)
    if (next) store(keep)?.setItem(SESSION_KEY, JSON.stringify(next))
    else store(keep)?.removeItem(SESSION_KEY)
  } catch {
    /* private mode — the session simply won't survive a reload */
  }
}

export function signedInAs(): string | null {
  return loadSession()?.email || null
}

/**
 * Whether a session exists at all, which is NOT the same question as
 * `signedInAs()`. The OAuth fragment carries tokens but no identity, so a
 * Google sign-in produces a perfectly valid session with an empty email —
 * and a UI that gates on the email alone puts the user back on the sign-in
 * screen while signed in, with no way forward.
 */
export function isSignedIn(): boolean {
  return loadSession() !== null
}

/** The signed-in user's id, which is also their social identity. */
export function currentUserId(): string | null {
  return loadSession()?.userId || null
}

/** Listeners that need to drop derived state when the session ends. */
const signOutHooks = new Set<() => void>()

export function onSignOut(fn: () => void): void {
  signOutHooks.add(fn)
}

function fireSignOutHooks(): void {
  for (const fn of signOutHooks) {
    try {
      fn()
    } catch {
      /* a hook must never block signing out */
    }
  }
}

export function signOut(): void {
  saveSession(null)
  // Belt and braces: `saveSession` clears the store the preference names and
  // the other one, but a session written before the preference last changed
  // could sit in either, and signing out must leave nothing behind anywhere.
  try {
    store('local')?.removeItem(SESSION_KEY)
    store('session')?.removeItem(SESSION_KEY)
  } catch {
    /* nothing readable to clear */
  }
  fireSignOutHooks()
}

/**
 * Other tabs of the same origin share this storage, and until this existed
 * they did not share the session.
 *
 * A `storage` event fires in every tab EXCEPT the one that wrote, which is
 * exactly the set that would otherwise be holding a refresh token the writer
 * has already spent. Dropping the memo makes the next read pick up what they
 * wrote; a session that vanished means they signed out, and this tab has to
 * let go of the same derived state a local sign-out would.
 */
function watchOtherTabs(): void {
  const target = typeof window !== 'undefined' ? window : undefined
  if (typeof target?.addEventListener !== 'function') return
  target.addEventListener('storage', (event: StorageEvent) => {
    // `key === null` is `storage.clear()` — everything went, ours included.
    if (event.key !== null && event.key !== SESSION_KEY && event.key !== REMEMBER_KEY) return
    const had = session !== null
    session = readStored()
    if (had && !session) fireSignOutHooks()
  })
}

watchOtherTabs()

/**
 * Refresh on the way back in, before the app's own pollers ask.
 *
 * A phone left on the Friends screen overnight wakes with an hour-dead access
 * token and fires every poller at once. One quiet refresh here means the burst
 * finds a live token, and a refresh that fails because the platform has not
 * finished reconnecting fails invisibly here instead of as a red toast on
 * whatever the user tapped first.
 */
export function installSessionKeepalive(): void {
  const warm = (): void => {
    const current = loadSession()
    if (!current || Date.now() < current.expiresAt) return
    void freshToken().catch(() => {})
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') warm()
    })
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', warm)
  }
}

export function authHeaders(token: string): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

export async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as Record<string, unknown>
    const msg = body?.error_description ?? body?.msg ?? body?.message ?? body?.error
    return typeof msg === 'string' && msg ? msg : fallback
  } catch {
    return fallback
  }
}

function sessionFrom(body: Record<string, unknown>): CloudSession {
  const user = body.user as { id?: string; email?: string } | undefined
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    throw new CloudError('The sign-in response was missing its tokens')
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    // Refresh a minute early so a slow request can't straddle the expiry.
    expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000,
    email: user?.email ?? '',
    userId: user?.id ?? '',
  }
}

/**
 * The one in-flight refresh, shared by every caller.
 *
 * WITHOUT THIS, OPENING THE APP SIGNED YOU OUT. Refresh tokens rotate: the
 * server accepts a given one once and rejects it thereafter. Opening Friends
 * fires `listRequests()`, `matchWants()` and `listOrders()` at the same moment,
 * and each independently called `freshToken()`. With an expired access token
 * all three raced to redeem the SAME refresh token — the first won, the losers
 * got a 400, and the 400 handler below called `signOut()`. A perfectly good
 * session was destroyed by its own app being busy, and the user was asked for
 * their email again as if they had never signed up.
 *
 * It latches this DOCUMENT, which is why it is not the whole answer — see
 * `redeem()` for the other half of the same race, between tabs.
 */
let refreshing: Promise<string> | null = null

/**
 * Does this response mean the session is genuinely finished, as opposed to the
 * server being unhappy for a moment?
 *
 * Only a definitive rejection of the token itself may sign someone out. A 500,
 * a 502 or a rate limit says nothing about whether the refresh token is valid,
 * and treating those as "your session is over" turns a blip on their train
 * journey into a re-signup.
 */
function isTokenRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) return false
  return /invalid|expired|revoked|not_found|already/i.test(body)
}

/**
 * Spend a refresh token, and — the load-bearing part — do not believe a
 * rejection until storage has been re-read.
 *
 * The latch above dedupes callers within one document. Two TABS have two
 * latches and one shared localStorage, so the second tab to wake redeems a
 * token the first already rotated. GoTrue forgives that for
 * `refresh_token_reuse_interval` (10s on this project) and rejects it flatly
 * after, with "Already Used" — indistinguishable, to the old code, from a
 * revoked session. It called `signOut()`, and a user with the app open in two
 * places was signed out of both for the crime of having two tabs.
 *
 * So a rejection is a QUESTION now: has the stored token moved since we sent
 * ours? If it has, the other tab succeeded and left us a good session sitting
 * in storage — adopt it. Only a rejection of the token storage still holds is
 * the end of a session. One retry, because two rejections of two different
 * tokens is no longer a race.
 */
async function redeem(current: CloudSession, retried = false): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: current.refreshToken }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    if (!isTokenRejection(res.status, detail)) {
      // Transient. Leave the session alone so the next call can try again;
      // whatever asked for a token simply fails this once.
      throw new CloudError('Could not reach your account — check your connection')
    }
    const stored = readStored()
    if (!retried && stored && stored.refreshToken !== current.refreshToken) {
      // Another tab rotated it while this request was in flight. Their session
      // is the live one.
      session = stored
      if (Date.now() < stored.expiresAt) return stored.accessToken
      return redeem(stored, true)
    }
    // Genuinely over: the server has rejected the token storage still holds.
    signOut()
    throw new CloudError('Your session expired — sign in again')
  }
  const next = sessionFrom((await res.json()) as Record<string, unknown>)
  saveSession({ ...next, email: next.email || current.email, userId: next.userId || current.userId })
  return next.accessToken
}

/** A valid access token, refreshing first if this one is close to expiry. */
export async function freshToken(): Promise<string> {
  // From STORAGE, not the memo. Another tab may have refreshed since this one
  // last looked, and spending a token it has already rotated is what the
  // retry in `redeem()` exists to survive — better not to need it. A stored
  // session wins; nothing stored leaves the memo alone, because a browser that
  // refuses storage entirely still has a working session for this run.
  const stored = readStored()
  if (stored) session = stored
  const current = session
  if (!current) throw new CloudError('Not signed in')
  if (Date.now() < current.expiresAt) return current.accessToken
  // Everyone who arrives while a refresh is in flight waits on that one rather
  // than starting a second and invalidating the first.
  if (refreshing) return refreshing

  refreshing = redeem(current)
  try {
    return await refreshing
  } finally {
    refreshing = null
  }
}

/* --------------------------------------------------------------------- auth */

/**
 * The address as the account will be keyed by it.
 *
 * GoTrue lowercases and keeps one user per address, so "Rae@Example.com" and
 * "rae@example.com" are already the same account — but the code is requested
 * with one string and verified with another, and the two must agree or the
 * verify is rejected for an address that never asked for a code. Doing it here
 * also means the confirmation screen shows the address the account actually
 * has, rather than whatever capitalisation the keyboard produced.
 */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

/**
 * Email a six-digit code. No redirect anywhere, which is why this is the
 * path that works identically in Safari and in an iOS Home Screen app —
 * see the OAuth caveat on `startGoogleSignIn`.
 *
 * Requires custom SMTP on the project: on Supabase's own sender the six-digit
 * code cannot work at all, because template edits are refused on the free tier
 * and the stock template emits only `{{ .ConfirmationURL }}`. This project
 * sends through Resend on `corrupt.solutions`. If sign-in starts failing with
 * what looks like a rejected address, check the sender before anything here.
 */
export async function sendEmailCode(email: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normalizeEmail(email), create_user: true }),
  })
  if (!res.ok) throw new CloudError(await readError(res, 'Could not send the code'))
}

export async function verifyEmailCode(email: string, code: string): Promise<CloudSession> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normalizeEmail(email), token: code, type: 'email' }),
  })
  if (!res.ok) throw new CloudError(await readError(res, 'That code was not accepted'))
  const next = sessionFrom((await res.json()) as Record<string, unknown>)
  saveSession(next)
  return next
}

/**
 * Google sign-in, by full-page redirect.
 *
 * Deliberately NOT a popup: `window.open` from an iOS Home Screen app opens
 * Safari, which lands the session in a different storage container than the
 * app — the same partitioning that makes the vault necessary. A top-level
 * navigation at least returns to the app on iOS 12.2+, but this path has a
 * long history of breaking in standalone mode, which is why emailed codes
 * exist above and are offered alongside it rather than as a fallback nobody
 * finds.
 */
export function startGoogleSignIn(): void {
  const back = `${location.origin}${location.pathname}`
  location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(back)}`
}

/**
 * GoTrue returns OAuth tokens in the URL *fragment*. The app also routes on
 * the fragment, so this must run before the router reads it, and must clear
 * what it consumed. Returns true if a session was adopted.
 */
export async function adoptOAuthRedirect(): Promise<boolean> {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
  if (!hash.includes('access_token=')) return false
  const params = new URLSearchParams(hash)
  const access = params.get('access_token')
  const refresh = params.get('refresh_token')
  if (!access || !refresh) return false
  const expiresIn = Number(params.get('expires_in') ?? 3600)
  saveSession({
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000,
    email: '',
    userId: '',
  })
  history.replaceState(null, '', `${location.pathname}${location.search}#/collection`)
  // The fragment has no identity in it, so ask who this is before anything
  // renders. One request, and only ever on the redirect itself.
  await fillIdentity().catch(() => {})
  return true
}

/**
 * Fill in the email/id an OAuth session arrives without. Best-effort: a
 * failure here costs a name in the UI, never the session itself.
 *
 * The user id matters more now than it did for the vault: it is the caller's
 * social identity, so a session without one cannot publish a binder.
 */
export async function fillIdentity(): Promise<void> {
  const current = loadSession()
  if (!current || (current.email && current.userId)) return
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: authHeaders(current.accessToken) })
  if (!res.ok) return
  const user = (await res.json()) as { id?: string; email?: string }
  saveSession({ ...current, email: user.email || current.email, userId: user.id || current.userId })
}
