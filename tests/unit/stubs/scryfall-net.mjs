/**
 * fetchJson stub for scryfall.ts unit tests: one set (NEO, printed_size 302)
 * and two of its prints, so the corner-only exact lookup and its
 * fail-closed set-size check can be exercised.
 */

export const requested = []

const SETS = {
  neo: { code: 'neo', name: 'Kamigawa: Neon Dynasty', printed_size: 302, card_count: 512 },
}

const PRINTS = {
  'neo/266': { id: 'aaaa1111-2222-3333-4444-555566667777', name: 'Boseiju, Who Endures', set: 'neo', collector_number: '266', prices: {} },
  'neo/175': { id: 'bbbb1111-2222-3333-4444-555566667777', name: 'Kodama of the West Tree', set: 'neo', collector_number: '175', prices: {} },
}

export async function fetchJson(url) {
  requested.push(url)
  const u = new URL(url)
  let m = u.pathname.match(/^\/sets\/([^/]+)$/)
  if (m) {
    const set = SETS[m[1]]
    if (set) return set
    throw Object.assign(new Error(`HTTP 404 for ${url}`), { status: 404 })
  }
  m = u.pathname.match(/^\/cards\/([^/]+)\/([^/]+)$/)
  if (m) {
    const print = PRINTS[`${m[1]}/${m[2]}`]
    if (print) return print
    throw Object.assign(new Error(`HTTP 404 for ${url}`), { status: 404 })
  }
  throw new Error(`scryfall-net stub: unexpected url ${url}`)
}

export function isAbort() {
  return false
}

/** Mirrors fetchJson's real export: the status rides on the rejection. */
export function httpStatus(err) {
  return typeof err?.status === 'number' ? err.status : null
}
