/**
 * The cloud vault transport: push, pull, merge.
 *
 * Sign-in itself lives in `authsession.ts` — one login serves this and hosted
 * social, and neither owns it. This module is what happens *after* you are
 * signed in and hold a passphrase.
 *
 * ## What is stored where
 *
 * - **Session tokens** — `authsession.ts`, in their own localStorage key, so
 *   they are never swept into a settings export or a backup file.
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

import { authHeaders, CloudError, freshToken, onSignOut, readError } from './authsession'
import { SUPABASE_URL } from './cloudconfig'
import {
  encryptJson,
  decryptJson,
  fromBase64,
  importVaultKey,
  keyFingerprint,
  randomSalt,
  toBase64,
  type VaultEnvelope,
} from './crypto'
import { mergeBackups, type MergeReport } from './cloudmerge'
import { exportBackup, importBackup, sanitizeBackup, type Backup } from './db'

import { settings } from './settings'

// Re-exported so existing callers (and the live harness) keep one import site
// for "the cloud", even though auth moved out from under them.
export {
  adoptOAuthRedirect,
  CloudError,
  isSignedIn,
  sendEmailCode,
  signedInAs,
  signOut,
  startGoogleSignIn,
  verifyEmailCode,
  type CloudSession,
} from './authsession'

/** The server rejected our base revision — another device wrote first. */
export class VaultConflict extends Error {
  constructor(readonly serverRevision: number) {
    super('Another device saved first')
    this.name = 'VaultConflict'
  }
}

/** Never persisted — the whole point is that only this device, this run, holds it. */
let vaultKey: CryptoKey | null = null

export function hasVaultKey(): boolean {
  return vaultKey !== null
}

// Signing out must drop the derived key, or the next user of this device
// inherits the ability to decrypt the previous one's vault.
onSignOut(() => {
  vaultKey = null
})

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
 * Get this account's vault key, minting it on first use, and hold it for the
 * run. Replaces the old `unlock(passphrase)`.
 *
 * There is nothing for the user to do here, which is the entire point: the
 * passphrase version had ZERO users across the whole project and somebody lost
 * a real collection to browser eviction while a perfectly good backup route sat
 * unused behind it. Read migration 0009 for what that costs — this is
 * encryption at rest with a key the server holds, and it is not end-to-end.
 *
 * The salt stays in the envelope because the format has a slot for it, but it
 * is now decorative: nothing is derived any more. It is left rather than
 * removed so old envelopes keep their shape.
 */
export async function ensureVaultKey(): Promise<CryptoKey> {
  if (vaultKey) return vaultKey
  const token = await freshToken()
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_or_create_vault_key`, {
    method: 'POST',
    headers: authHeaders(token),
    body: '{}',
  })
  if (!res.ok) throw new CloudError(await readError(res, 'Could not reach your backup'))
  const raw = (await res.json()) as unknown
  const base64 = typeof raw === 'string' ? raw : ''
  if (!base64) throw new CloudError('The server did not return a usable key')
  const key = await importVaultKey(base64)
  vaultKey = key
  // `cloudKeyCheck` keeps its old meaning -- "is this the key the ciphertext
  // was written with" -- it is simply asked of a key now rather than a
  // passphrase. Settings still uses it to answer "is backup set up".
  settings().set({
    cloudKeyCheck: await keyFingerprint(base64),
    cloudSalt: settings().cloudSalt || toBase64(randomSalt()),
  })
  return key
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
/**
 * How many characters of card imagery the vault may carry — about 100 pictures
 * at the ~57 KB the encoder produces (`cardimage.ts`).
 *
 * Chosen against what the vault IS rather than against a storage limit: one
 * row, re-encrypted and re-uploaded on every sync, on whatever connection a
 * phone has. Six megabytes of base64 is already a slow sync; letting it grow
 * unbounded would make backup fail exactly for the users who had put the most
 * into it. Newest pictures win, and the rest are omitted rather than gutted —
 * an omitted patch merges as "the other device keeps its own".
 */
const VAULT_IMAGE_BUDGET = 6_000_000

export async function syncNow(): Promise<SyncOutcome> {
  const key = await ensureVaultKey()
  const salt = fromBase64(settings().cloudSalt || '')
  const check = settings().cloudKeyCheck

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await fetchVault()
    // The one caller that passes an image budget. See `ExportOptions` in db.ts:
    // the vault is a single text column rewritten on every sync, so the user's
    // own card photographs ride it up to a bound and the complete set lives in
    // the JSON export and the Drive backup, which are real file writes.
    const local = await exportBackup({ imageBudget: VAULT_IMAGE_BUDGET })
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
