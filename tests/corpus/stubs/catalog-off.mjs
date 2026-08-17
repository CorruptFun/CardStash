/**
 * The catalog mirror, provably inert.
 *
 * `catalog.ts` reaches our Supabase project through the GLOBAL `fetch`, not
 * through `fetchJson`, so aliasing the transport would not stop it — and the
 * mirror is our own copy of these very three feeds, so letting it answer would
 * make the sweep grade the corpus against itself.
 *
 * Empty is also the honest posture: the mirror stands BEHIND every matcher
 * (cardsearch.ts), so a sweep that never lets it speak measures the matchers
 * exactly as a device with the switch off experiences them.
 */

export function mirrorLookupOn() {
  return false
}

export async function mirrorByCode() {
  return []
}

export async function mirrorByName() {
  return []
}

export async function mirrorPrintingsOf() {
  return []
}

export function clearMirrorStanddown() {}
