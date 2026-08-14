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
import { deriveKey, encryptJson, decryptJson, fromBase64, keyCheck, randomSalt, toBase64, type VaultEnvelope } from './crypto'
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
