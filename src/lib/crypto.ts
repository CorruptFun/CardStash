/**
 * Client-side encryption for the cloud vault.
 *
 * The whole point: the server stores a blob it cannot read. Sign-in proves
 * *who* you are and decides which row you may fetch; this key decides whether
 * that row means anything. They are deliberately separate secrets — if the
 * key could be derived from the login, whoever runs the server could decrypt
 * every collection, which is the outcome we are paying this complexity to
 * avoid.
 *
 * Nothing here touches the network or the database, so it is unit-testable
 * end to end, and it is: `tests/unit/crypto.test.mjs` round-trips real
 * payloads and asserts the failure modes.
 */

/** Envelope version — bump if the KDF or cipher ever changes. */
export const VAULT_FORMAT = 1

/**
 * PBKDF2 is the only password KDF WebCrypto exposes (no Argon2/scrypt), so
 * the iteration count is the entire cost knob. OWASP's floor for
 * PBKDF2-SHA256 is 600k; this sits there, which costs a phone a beat under a
 * second — paid once per sign-in, not per sync.
 */
const PBKDF2_ITERATIONS = 600_000
const SALT_BYTES = 16
const IV_BYTES = 12

export interface VaultEnvelope {
  v: number
  /** base64 — not secret, and required to re-derive the key on a new device. */
  salt: string
  /** base64, unique per write. Reusing one with the same key breaks AES-GCM. */
  iv: string
  /** base64 ciphertext. */
  ct: string
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('This browser has no Web Crypto — sync needs a secure context (https).')
  return c.subtle
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function randomSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES))
}

/**
 * Passphrase + salt → AES-GCM key. The salt is stored beside the ciphertext
 * so any device with the passphrase can re-derive; it exists to stop one
 * precomputed table covering every user, not to be secret.
 */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ])
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptJson(value: unknown, key: CryptoKey, salt: Uint8Array): Promise<VaultEnvelope> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const plain = new TextEncoder().encode(JSON.stringify(value))
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource)
  return { v: VAULT_FORMAT, salt: toBase64(salt), iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) }
}

/** Thrown when the passphrase is wrong — the one failure users actually hit. */
export class WrongPassphraseError extends Error {
  constructor() {
    super('That passphrase does not match this vault')
    this.name = 'WrongPassphraseError'
  }
}

export async function decryptJson(envelope: VaultEnvelope, key: CryptoKey): Promise<unknown> {
  if (envelope?.v !== VAULT_FORMAT) throw new Error(`Unsupported vault format (v${envelope?.v})`)
  let plain: ArrayBuffer
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv) as BufferSource },
      key,
      fromBase64(envelope.ct) as BufferSource,
    )
  } catch {
    // AES-GCM authentication failure is indistinguishable from a corrupt
    // blob, but a wrong passphrase is the overwhelmingly likely cause and
    // the only one the user can act on.
    throw new WrongPassphraseError()
  }
  return JSON.parse(new TextDecoder().decode(plain))
}

/**
 * A short, non-secret fingerprint of the key, stored alongside the vault so a
 * device can say "wrong passphrase" *before* downloading and failing to
 * decrypt a large blob. It is a hash of the salt and the derived bits, so it
 * leaks nothing useful about the passphrase.
 */
export async function keyCheck(passphrase: string, salt: Uint8Array): Promise<string> {
  const bits = await subtle().digest(
    'SHA-256',
    new TextEncoder().encode(`cardstock-vault-check:${toBase64(salt)}:${passphrase}`) as BufferSource,
  )
  return toBase64(new Uint8Array(bits).slice(0, 8))
}
