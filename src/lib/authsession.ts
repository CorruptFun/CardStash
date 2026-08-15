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
 * **Session tokens live in their own localStorage key**, NOT in the settings
 * store, so they are never swept into a settings export or a backup file.
 */

import { SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'

const SESSION_KEY = 'cardstock-cloud-session'

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

function loadSession(): CloudSession | null {
  if (session) return session
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CloudSession
    if (typeof parsed?.accessToken !== 'string' || typeof parsed?.refreshToken !== 'string') return null
    session = parsed
    return session
  } catch {
    return null
  }
}

function saveSession(next: CloudSession | null): void {
  session = next
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next))
    else localStorage.removeItem(SESSION_KEY)
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

export function signOut(): void {
  saveSession(null)
  for (const fn of signOutHooks) {
    try {
      fn()
    } catch {
      /* a hook must never block signing out */
    }
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

/** A valid access token, refreshing first if this one is close to expiry. */
export async function freshToken(): Promise<string> {
  const current = loadSession()
  if (!current) throw new CloudError('Not signed in')
  if (Date.now() < current.expiresAt) return current.accessToken
  // Everyone who arrives while a refresh is in flight waits on that one rather
  // than starting a second and invalidating the first.
  if (refreshing) return refreshing

  refreshing = (async () => {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: current.refreshToken }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (isTokenRejection(res.status, detail)) {
        // Genuinely over: the server has rejected the token itself.
        signOut()
        throw new CloudError('Your session expired — sign in again')
      }
      // Transient. Leave the session alone so the next call can try again;
      // whatever asked for a token simply fails this once.
      throw new CloudError('Could not reach your account — check your connection')
    }
    const next = sessionFrom((await res.json()) as Record<string, unknown>)
    saveSession({ ...next, email: next.email || current.email, userId: next.userId || current.userId })
    return next.accessToken
  })()

  try {
    return await refreshing
  } finally {
    refreshing = null
  }
}

/* --------------------------------------------------------------------- auth */

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
    body: JSON.stringify({ email, create_user: true }),
  })
  if (!res.ok) throw new CloudError(await readError(res, 'Could not send the code'))
}

export async function verifyEmailCode(email: string, code: string): Promise<CloudSession> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, token: code, type: 'email' }),
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
