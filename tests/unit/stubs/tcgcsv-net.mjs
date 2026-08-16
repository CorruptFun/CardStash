/**
 * fetchJson stub for tcgcsv unit tests: serves a tiny in-memory TCGplayer
 * mirror (categories + per-category group lists) and records what was asked.
 */

export const requested = []

const CATEGORIES = [
  { categoryId: 3, name: 'Pokemon', displayName: 'Pokemon' },
  { categoryId: 85, name: 'Pokemon Japan', displayName: 'Pokemon Japan' },
  { categoryId: 1, name: 'Magic', displayName: 'Magic: The Gathering' },
]

const GROUPS = {
  3: [{ groupId: 23600, name: 'SV08: Surging Sparks', abbreviation: 'SV08', publishedOn: '2024-11-08T00:00:00' }],
  85: [{ groupId: 23411, name: 'SV4K: Ancient Roar', abbreviation: 'SV4K', publishedOn: '2023-10-27T00:00:00' }],
  1: [{ groupId: 100, name: 'Duskmourn: House of Horror', abbreviation: 'DSK', publishedOn: '2024-09-27T00:00:00' }],
}

export async function fetchJson(url) {
  requested.push(url)
  const categories = url.match(/\/tcgplayer\/categories$/)
  if (categories) return { results: CATEGORIES }
  const groups = url.match(/\/tcgplayer\/(\d+)\/groups$/)
  if (groups) return { results: GROUPS[groups[1]] ?? [] }
  throw new Error(`tcgcsv-net stub: unexpected url ${url}`)
}

export function isAbort() {
  return false
}

/** Mirrors fetchJson's real export: the status rides on the rejection. */
export function httpStatus(err) {
  return typeof err?.status === 'number' ? err.status : null
}
