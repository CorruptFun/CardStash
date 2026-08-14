import { exportBackup, importBackup, type Backup } from './db'
import { settings } from './settings'
import { track } from './analytics'

/**
 * Free-tier backup to the user's OWN Google Drive — never to a server of ours.
 *
 * This is the answer to decision 14's loss problem, and the shape matters as
 * much as the feature. The browser talks to Google directly; the app hosts
 * nothing, stores nothing, and never sees the file. The data sits in the user's
 * own Drive, in the hidden per-app folder, where nothing else — not even other
 * software the user runs — can read it.
 *
 * Four properties that are not negotiable:
 *
 *  1. **The free tier must not gain a dependency on OUR backend.** Backup talks
 *     to Google and nothing else. When the hosted sync server exists it must not
 *     become the route for this; a user who never signs up for anything still
 *     gets their collection protected.
 *  2. **Dormant until configured.** With no `VITE_GOOGLE_CLIENT_ID`, every
 *     export here no-ops and the app behaves exactly as it does today. Same
 *     contract as viva-maya's `isCloudConfigured()`.
 *  3. **Nothing loads until the user opts in.** Google Identity Services is a
 *     THIRD-PARTY script from accounts.google.com. It is injected on first use
 *     and never on boot, so a user who never turns backup on never contacts
 *     Google at all, and the offline scan loop is untouched.
 *  4. **Failure is silent and harmless.** Offline, revoked, rate-limited — every
 *     path returns a result the caller can ignore. Backup is never load-bearing;
 *     losing it must never change what the app does.
 *
 * Scope is `drive.appdata` and NOTHING else. It grants access only to this app's
 * hidden folder and never to the user's files, which is why it avoids Google's
 * restricted-scope review. Deliberately no identity scope either: we show "last
 * backed up" rather than an email address, so the consent screen stays one line
 * and we never learn who the user is.
 */

const CLIENT_ID = ((import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_CLIENT_ID ?? '').trim()
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const GIS_SRC = 'https://accounts.google.com/gsi/client'

const FILES_API = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'
const REQUEST_TIMEOUT_MS = 30_000

/**
 * How many backups to keep. NOT one file overwritten in place: an automatic
 * backup that clobbers the only good copy after a corruption would be a
 * data-loss trap of our own making, which is the exact class of bug this
 * feature exists to fix. Five is enough to reach back past a bad session.
 */
const KEEP_BACKUPS = 5

/** The single gate every path here checks. */
export function isDriveConfigured(): boolean {
  return !!CLIENT_ID
}

export interface DriveBackupFile {
  id: string
  name: string
  /** Epoch ms, from Drive's own clock. */
  modifiedAt: number
  bytes: number
}

export class DriveError extends Error {
  /** True when re-consent would plausibly fix it — the caller can offer a button. */
  readonly needsAuth: boolean
  constructor(message: string, needsAuth = false) {
    super(message)
    this.name = 'DriveError'
    this.needsAuth = needsAuth
  }
}

/* --- Google Identity Services ------------------------------------------- */

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void
}

interface GoogleOAuth2 {
  initTokenClient: (config: {
    client_id: string
    scope: string
    callback: (response: TokenResponse) => void
    error_callback?: (error: { type?: string }) => void
  }) => TokenClient
  revoke: (token: string, done?: () => void) => void
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } }
  }
}

let gisPromise: Promise<GoogleOAuth2> | null = null

/**
 * Inject the GIS client on first use. Never called at boot — see property 3.
 * The failure is retryable: a rejected load clears the cached promise so a
 * later attempt (back online, ad-blocker disabled) can succeed.
 */
function loadGis(): Promise<GoogleOAuth2> {
  if (gisPromise) return gisPromise
  const pending = new Promise<GoogleOAuth2>((resolve, reject) => {
    const existing = window.google?.accounts?.oauth2
    if (existing) return resolve(existing)
    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.onload = () => {
      const oauth2 = window.google?.accounts?.oauth2
      // A blocker can serve an empty 200 rather than failing the load, so the
      // presence of the API is the real test, not the load event.
      if (oauth2) resolve(oauth2)
      else reject(new DriveError('Google sign-in could not load — a content blocker may be stopping it'))
    }
    script.onerror = () => reject(new DriveError("Couldn't reach Google — check your connection"))
    document.head.appendChild(script)
  })
  gisPromise = pending
  pending.catch(() => {
    if (gisPromise === pending) gisPromise = null
  })
  return pending
}

let tokenClient: TokenClient | null = null
/** Access token + expiry, in MEMORY ONLY. Never persisted: it is a credential,
 * it lives about an hour, and silent renewal can always mint another. */
let accessToken = ''
let expiresAt = 0
/** One in-flight auth at a time — two concurrent popups is a broken experience. */
let authInFlight: Promise<string> | null = null

/** A minute of headroom, so a token never expires mid-upload. */
const EXPIRY_SKEW_MS = 60_000

function tokenIsFresh(): boolean {
  return !!accessToken && Date.now() < expiresAt - EXPIRY_SKEW_MS
}

/**
 * Get a usable access token.
 *
 * `interactive: false` is the ordinary path — Google reissues silently when the
 * user has already granted the scope and still has a session, which is what
 * makes automatic backup possible without ever interrupting anybody. Only the
 * first connection, and a session that has genuinely lapsed, needs
 * `interactive: true`, and that MUST be called from a user gesture or the
 * browser will block the popup.
 */
async function getToken(interactive: boolean): Promise<string> {
  if (tokenIsFresh()) return accessToken
  if (authInFlight) return authInFlight
  const pending = (async () => {
    const oauth2 = await loadGis()
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }
      tokenClient ??= oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (response) => {
          if (response.access_token) {
            accessToken = response.access_token
            expiresAt = Date.now() + (response.expires_in ?? 3600) * 1000
            finish(() => resolve(accessToken))
          } else {
            finish(() => reject(new DriveError(response.error ?? 'Google did not return access', true)))
          }
        },
        error_callback: (error) => {
          // A silent attempt that needs consent is not an error worth showing —
          // it is the normal answer to "can you do this without asking?".
          finish(() => reject(new DriveError(authMessage(error?.type), true)))
        },
      })
      // '' asks Google to skip the consent screen when the grant already
      // exists; 'consent' forces it, which is what a first connection needs.
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' })
    })
  })()
  authInFlight = pending
  try {
    return await pending
  } finally {
    authInFlight = null
  }
}

function authMessage(type?: string): string {
  if (type === 'popup_closed') return 'Sign-in was closed before it finished'
  if (type === 'popup_failed_to_open') return 'Your browser blocked the Google sign-in window'
  return 'Google Drive needs you to sign in again'
}

/** Forget the in-memory token. Does not revoke — see `disconnectDrive`. */
export function forgetDriveToken(): void {
  accessToken = ''
  expiresAt = 0
}

/**
 * Turn backup off and hand the grant back to Google, so "disconnect" means what
 * the user thinks it means rather than just hiding a button.
 */
export async function disconnectDrive(): Promise<void> {
  const token = accessToken
  forgetDriveToken()
  settings().set({ driveBackup: false, driveAt: 0 })
  if (!token) return
  try {
    const oauth2 = await loadGis()
    await new Promise<void>((resolve) => oauth2.revoke(token, resolve))
  } catch {
    // Best effort. The token expires within the hour regardless, and the user
    // can always revoke from their Google account page.
  }
}

/* --- Drive REST ----------------------------------------------------------- */

async function driveFetch(url: string, init: RequestInit, interactive = false): Promise<Response> {
  const token = await getToken(interactive)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) {
      // The grant was revoked from the user's Google account, or the token went
      // stale early. Drop it so the next attempt re-authenticates rather than
      // retrying the same dead credential forever.
      forgetDriveToken()
      throw new DriveError('Google Drive access has expired or been revoked', true)
    }
    if (!res.ok) throw new DriveError(`Google Drive said ${res.status}`)
    return res
  } catch (err) {
    if (err instanceof DriveError) throw err
    if ((err as Error)?.name === 'AbortError') throw new DriveError('Google Drive did not answer in time')
    throw new DriveError("Couldn't reach Google Drive — you may be offline")
  } finally {
    clearTimeout(timer)
  }
}

const BACKUP_PREFIX = 'cardstash-backup-'

/** Newest first. Only ever sees this app's own hidden folder. */
export async function listDriveBackups(interactive = false): Promise<DriveBackupFile[]> {
  const query = new URLSearchParams({
    spaces: 'appDataFolder',
    fields: 'files(id,name,modifiedTime,size)',
    orderBy: 'modifiedTime desc',
    pageSize: '20',
  })
  const res = await driveFetch(`${FILES_API}?${query}`, { method: 'GET' }, interactive)
  const body = (await res.json()) as { files?: { id?: string; name?: string; modifiedTime?: string; size?: string }[] }
  return (body.files ?? [])
    .filter((file) => !!file.id && (file.name ?? '').startsWith(BACKUP_PREFIX))
    .map((file) => ({
      id: file.id as string,
      name: file.name ?? '',
      modifiedAt: Date.parse(file.modifiedTime ?? '') || 0,
      bytes: Number(file.size ?? 0) || 0,
    }))
}

/** Rotate: keep the newest `KEEP_BACKUPS`, drop the rest. Never fatal. */
async function rotate(files: DriveBackupFile[]): Promise<void> {
  for (const file of files.slice(KEEP_BACKUPS)) {
    try {
      await driveFetch(`${FILES_API}/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
    } catch {
      // A backup we failed to delete costs quota, not data. Never block on it.
    }
  }
}

/**
 * Write a new backup. `interactive` must be true when this is the user tapping
 * Connect or Back up now, and false for automatic runs — an automatic backup
 * must never open a popup.
 */
export async function backupToDrive(interactive = false): Promise<DriveBackupFile> {
  if (!isDriveConfigured()) throw new DriveError('Google Drive backup is not configured in this build')
  const started = Date.now()
  const backup = await exportBackup()
  const body = JSON.stringify(backup)
  const metadata = {
    name: `${BACKUP_PREFIX}${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`,
    parents: ['appDataFolder'],
    mimeType: 'application/json',
  }
  const boundary = `cardstash${Math.random().toString(36).slice(2)}`
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`
  const res = await driveFetch(
    `${UPLOAD_API}?uploadType=multipart&fields=id,name,modifiedTime,size`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    },
    interactive,
  )
  const file = (await res.json()) as { id?: string; name?: string; modifiedTime?: string; size?: string }
  settings().set({ driveAt: Date.now() })
  track('backup_run', {
    dest: 'drive',
    ok: true,
    ms: Date.now() - started,
    kb: Math.round(body.length / 1024),
    auto: !interactive,
  })
  const written: DriveBackupFile = {
    id: file.id ?? '',
    name: file.name ?? metadata.name,
    modifiedAt: Date.parse(file.modifiedTime ?? '') || Date.now(),
    bytes: Number(file.size ?? body.length),
  }
  // Rotation reads the list fresh so it can never delete something this upload
  // did not account for. Failures here are swallowed by design.
  try {
    await rotate(await listDriveBackups())
  } catch {
    /* quota housekeeping, never the user's problem */
  }
  return written
}

/**
 * Read one backup back. Returns the parsed object WITHOUT applying it — the
 * caller shows what it contains first, because restoring is the one action here
 * that touches existing data.
 */
export async function fetchDriveBackup(fileId: string): Promise<Backup> {
  const res = await driveFetch(`${FILES_API}/${encodeURIComponent(fileId)}?alt=media`, { method: 'GET' }, true)
  return (await res.json()) as Backup
}

/**
 * Apply a backup. Goes through `importBackup`, which sanitizes every row
 * exactly as a pasted link or a backup file is sanitized — a Drive response is
 * untrusted input like any other (decision 7).
 *
 * `bulkPut` merges by primary key rather than replacing the database, so a
 * restore onto a non-empty collection adds what is missing and lets the backup
 * win on rows that exist in both. That is the right default for the case this
 * feature exists for: restoring into a freshly installed, empty app.
 */
export async function restoreDriveBackup(fileId: string): Promise<void> {
  const started = Date.now()
  const backup = await fetchDriveBackup(fileId)
  await importBackup(backup)
  track('backup_restore', { dest: 'drive', ok: true, ms: Date.now() - started })
}

/* --- the automatic path --------------------------------------------------- */

/** Once a day is enough: a collection changes in sittings, not continuously. */
const AUTO_BACKUP_GAP_MS = 22 * 60 * 60 * 1000

export function driveBackupDue(): boolean {
  const config = settings()
  if (!isDriveConfigured() || !config.driveBackup) return false
  return Date.now() - (config.driveAt || 0) > AUTO_BACKUP_GAP_MS
}

let autoRan = false

/**
 * The automatic daily backup. Never interactive, never throws, and never runs
 * more than once per launch. Called well after boot so it cannot contend with
 * the first paint or the camera coming up.
 */
export async function runAutoBackup(): Promise<boolean> {
  if (autoRan || !driveBackupDue()) return false
  autoRan = true
  try {
    await backupToDrive(false)
    return true
  } catch {
    // Offline, session lapsed, blocker installed — all normal, all silent. The
    // next launch tries again, and the Settings screen shows the stale date.
    return false
  }
}
