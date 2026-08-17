/**
 * Dexie's four doors into the matching layer, with nothing behind them.
 *
 * A corpus sweep has no user, so there are no patches and no hand-typed cards:
 * `patched`/`patchedAll` are the identity they already are on a fresh install,
 * and `searchCustomCards` answers empty. Stubbed rather than bundled so the
 * sweep never depends on a browser database being importable in node.
 */

export function patched(card) {
  return card
}

export function patchedAll(cards) {
  return cards
}

export function patchFor() {
  return null
}

export async function searchCustomCards() {
  return []
}

/**
 * The other three doors, reached only by the games this sweep does not cover
 * (`tcgcsv.ts`'s day-cache and `sports.ts`). They exist so the bundle RESOLVES
 * — an unbundleable sibling would take the whole matching layer with it — and
 * an empty key-value store is honestly what a fresh install has.
 */
export const db = { table: () => ({}) }

export async function kvGet() {
  return undefined
}

export async function kvPut() {}
