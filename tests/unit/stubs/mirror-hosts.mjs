/**
 * Host stubs for bundling lib/catalog.ts in node tests: settings, analytics,
 * cloud config, the auth error shapes, and vision's capture side (node has no
 * canvas — tests inject the capture neighborhood via globalThis). Distance
 * math is REAL — the picker under test depends on it.
 */

/* ./settings */
export const settings = () => globalThis.__mirrorSettings ?? { cardSourceLookup: true }

/* ./analytics */
export const track = (t, data = {}) => {
  ;(globalThis.__mirrorTracked ??= []).push({ t, ...data })
}

/* ./cloudconfig */
export const SUPABASE_URL = 'https://mirror.invalid'
export const SUPABASE_KEY = 'pk_test'
export const CLOUD_AVAILABLE = true

/* ./authsession */
export class CloudError extends Error {}
export const readError = async (_res, fallback) => fallback

/* ./vision — real bit math, injectable capture hashes */
export const ART_HASH_BITS = 256
export const ART_REGION = { x: 0.1, y: 0.18, w: 0.8, h: 0.37 }
export function artHashDistance(a, b) {
  const len = ART_HASH_BITS / 4
  if (a.length !== len || b.length !== len) return ART_HASH_BITS
  let distance = 0
  for (let i = 0; i < len; i++) {
    const av = parseInt(a[i], 16)
    const bv = parseInt(b[i], 16)
    if (Number.isNaN(av) || Number.isNaN(bv)) return ART_HASH_BITS
    let xor = av ^ bv
    while (xor) {
      distance += xor & 1
      xor >>= 1
    }
  }
  return distance
}
export const cardArtHash = () => (globalThis.__mirrorCaptureHashes ?? ['0'.repeat(64)])[0]
export const captureArtHashes = () => globalThis.__mirrorCaptureHashes ?? ['0'.repeat(64)]
export const artHashFromGray = () => '0'.repeat(64)
