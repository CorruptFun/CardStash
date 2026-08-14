/**
 * The cloud vault transport: sign in, push, pull, merge.
 *
 * Hand-rolled against Supabase's REST surface (GoTrue for auth, PostgREST for
 * the table) rather than pulling in `@supabase/supabase-js`. Three reasons:
 * the API surface used here is six endpoints, the SDK is a large dependency
 * for a bundle that already ships an OCR engine, and — the deciding one —
 * doing it by hand keeps precise control of the redirect behaviour, which is
 * exactly what breaks in iOS Home Screen web apps.
 *
 * ## What is stored where
 *
 * - **Session tokens** live in their own localStorage key, NOT in the settings
 *   store, so they are never swept into a settings export or a backup file.
 * - **Salt and key check** live in settings: they are not secret, and having
 *   them locally lets a returning device derive the key without a round trip.
 * - **The passphrase and the derived key are never persisted.** The key is
 *   held in memory for the session; a reload asks again. That is the cost of
 *   the server genuinely not being able to read the vault.
 *
 * ## Conflicts
 *
 * Every write sends the revision it last saw. `put_vault()` rejects a stale
 * base, and this module answers that by pulling, merging (`cloudmerge.ts`),
 * and retrying — so two devices editing offline converge instead of one
 * silently overwriting the other.
 */

import { SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'
import { deriveKey, encryptJson, decryptJson, fromBase64, keyCheck, randomSalt, toBase64, type VaultEnvelope } from './crypto'
import { mergeBackups, type MergeReport } from './cloudmerge'
import { exportBackup, importBackup, sanitizeBackup, type Backup } from './db'
import { settings } from './settings'

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
/** The server rejected our base revision — another device wrote first. */
export class VaultConflict extends Error {
  constructor(readonly serverRevision: number) {
    super('Another device saved first')
    this.name = 'VaultConflict'
  }
}

/* ------------------------------------------------------------------ session */

let session: CloudSession | null = null
/** Never persisted — the whole point is that only this device, this run, holds it. */
let vaultKey: CryptoKey | null = null

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

export function hasVaultKey(): boolean {
  return vaultKey !== null
}

export function signOut(): void {
  saveSession(null)
  vaultKey = null
}

function authHeaders(token: string): Record<string, string> {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function readError(res: Response, fallback: string): Promise<string> {
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

/** A valid access token, refreshing first if this one is close to expiry. */
async function freshToken(): Promise<string> {
  const current = loadSession()
  if (!current) throw new CloudError('Not signed in')
  if (Date.now() < current.expiresAt) return current.accessToken

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: current.refreshToken }),
  })
  if (!res.ok) {
    // A refresh token is single-use and expires; a failure here means the
    // session is genuinely over, so clear it rather than retry forever.
    signOut()
    throw new CloudError(await readError(res, 'Your session expired — sign in again'))
  }
  const next = sessionFrom((await res.json()) as Record<string, unknown>)
  saveSession({ ...next, email: next.email || current.email, userId: next.userId || current.userId })
  return next.accessToken
}

/* --------------------------------------------------------------------- auth */

/**
 * Email a six-digit code. No redirect anywhere, which is why this is the
 * path that works identically in Safari and in an iOS Home Screen app —
 * see the OAuth caveat on `startGoogleSignIn`.
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
 * app — the same partitioning that makes this whole feature necessary. A
 * top-level navigation at least returns to the app on iOS 12.2+, but this
 * path has a long history of breaking in standalone mode, which is why
 * emailed codes exist above and are offered alongside it rather than as a
 * fallback nobody finds.
 */
export function startGoogleSignIn(): void {
  const back = `${location.origin}${location.pathname}`
  location.href =
    `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(back)}`
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
  // renders. One request, and only ever on the redirect itself — an ordinary
  // boot returns above without touching the network.
  await fillIdentity().catch(() => {})
  return true
}

/** Fill in the email/id an OAuth session arrives without. Best-effort: a
 * failure here costs a name in the UI, never the session itself. */
async function fillIdentity(): Promise<void> {
  const current = loadSession()
  if (!current || (current.email && current.userId)) return
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: authHeaders(current.accessToken) })
  if (!res.ok) return
  const user = (await res.json()) as { id?: string; email?: string }
  saveSession({ ...current, email: user.email || current.email, userId: user.id || current.userId })
}

/* -------------------------------------------------------------------- vault */

interface VaultRow {
  envelope: VaultEnvelope
  key_check: string
  revision: number
  updated_at: string
  device: string | null
}

async function fetchVault(): Promise<VaultRow | null> {
  const token = await freshToken()
  const res = await fetch(`${SUPABASE_URL}/rest/v1/vaults?select=envelope,key_check,revision,updated_at,device`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw new CloudError(await readError(res, 'Could not reach the vault'))
  const rows = (await res.json()) as VaultRow[]
  return Array.isArray(rows) && rows.length ? rows[0] : null
}

/**
 * Unlock with a passphrase. On a device that has never synced this mints a
 * salt; on one joining an existing vault it adopts the server's salt and
 * refuses a mismatched passphrase before downloading anything large.
 */
export async function unlock(passphrase: string): Promise<{ existing: boolean }> {
  const row = await fetchVault()
  const salt = row ? fromBase64(row.envelope.salt) : randomSalt()
  const check = await keyCheck(passphrase, salt)
  if (row && row.key_check !== check) {
    throw new CloudError('That passphrase does not match the vault on this account')
  }
  vaultKey = await deriveKey(passphrase, salt)
  settings().set({ cloudSalt: toBase64(salt), cloudKeyCheck: check })
  return { existing: Boolean(row) }
}

export interface SyncOutcome {
  pushed: boolean
  report: MergeReport | null
  revision: number
}

async function putVault(envelope: VaultEnvelope, check: string, base: number): Promise<number> {
  const token = await freshToken()
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/put_vault`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ p_envelope: envelope, p_key_check: check, p_device: deviceLabel(), p_base: base }),
  })
  if (!res.ok) {
    const message = await readError(res, 'Could not save to the vault')
    const conflict = /vault_conflict:(\d+)/.exec(message)
    if (conflict) throw new VaultConflict(Number(conflict[1]))
    throw new CloudError(message)
  }
  const row = (await res.json()) as VaultRow | VaultRow[]
  const saved = Array.isArray(row) ? row[0] : row
  return saved?.revision ?? base + 1
}

function deviceLabel(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  return 'Browser'
}

/**
 * One full cycle: pull what's there, merge it into local, push the result.
 *
 * Pull-merge-push rather than push-if-newer, because the whole reason two
 * devices disagree is that each has cards the other lacks. A conflict from a
 * concurrent write is answered by going round again with the newer base.
 */
export async function syncNow(): Promise<SyncOutcome> {
  if (!vaultKey) throw new CloudError('Unlock the vault with your passphrase first')
  const key = vaultKey
  const salt = fromBase64(settings().cloudSalt || '')
  const check = settings().cloudKeyCheck

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await fetchVault()
    const local = await exportBackup()
    let toWrite: Backup = local
    let report: MergeReport | null = null

    if (row) {
      const decoded = await decryptJson(row.envelope, key)
      // Anything decoded from outside is untrusted, even our own ciphertext —
      // decryption proves the passphrase, not the shape (decision 7).
      const remote = sanitizeBackup(decoded)
      const merged = mergeBackups(local, remote)
      toWrite = merged.merged
      report = merged.report
      if (report.added || report.updated) await importBackup(toWrite)
    }

    const envelope = await encryptJson(toWrite, key, salt)
    try {
      const revision = await putVault(envelope, check, row?.revision ?? 0)
      settings().set({ cloudRevision: revision, cloudSyncedAt: Date.now() })
      return { pushed: true, report, revision }
    } catch (err) {
      if (!(err instanceof VaultConflict) || attempt === 2) throw err
      // Someone else wrote between our read and our write — go again.
    }
  }
  throw new CloudError('The vault kept changing underneath us — try again')
}
