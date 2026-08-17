/**
 * The catalog mirror: our own copy of the big three card catalogs, asked only
 * when the real ones fall short.
 *
 * WHY THIS EXISTS. Every card here normally comes straight from Scryfall,
 * TCGdex/pokemontcg.io or YGOPRODeck, and that stays true — the mirror is a
 * FALLBACK, never the first answer. But those APIs have bad days (the app
 * already carries a TCGdex fallback because pokemontcg.io is dying), so the
 * mirror serves rows when an API is down or answered empty: code lookups,
 * name search, the match layer and the variants picker all fall back here.
 * Schema, grants and the ingestion contract: migration 0022; the worker:
 * scripts/sync-catalog.mjs; the pure logic: catalogmatch.ts. (The schema
 * also reserves an `art_hash` column for a future artwork fingerprint;
 * nothing here reads it — see catalogmatch.ts.)
 *
 * THE RULES, inherited from the shared card index (cardsource.ts) because the
 * privacy shape is identical:
 *
 * 1. **Lookups are anonymous.** Publishable key as `anon`, NEVER the session
 *    JWT (decision 20) — what card someone is looking at must not become a
 *    row tied to an account, and the free path is signed out.
 * 2. **One switch.** `cardSourceLookup` already means "when the catalogs fall
 *    short, this app may ask Cardstock's own index" — the mirror is the same
 *    act with the same audience, so it obeys the same switch rather than
 *    growing a second one nobody can tell apart.
 * 3. **Everything that comes back is untrusted** and goes through
 *    `sanitizeCatalogHit` before it becomes a Card.
 * 4. **Fail soft, then stand down.** A mirror that is down or not yet
 *    migrated must cost near-nothing: every path answers null/[] on failure,
 *    and repeated failures stand the mirror down for the session, exactly as
 *    cardsource.ts does (its stand-down is separate from this one — a
 *    project can have 0013 applied and not 0022).
 *
 * Dormant with no project configured (`CLOUD_AVAILABLE` false): nothing in
 * this file makes a request and the app behaves as if it did not exist.
 */

import { track } from './analytics'
import { CloudError, readError } from './authsession'
import { type CatalogHit, cardFromCatalog, isCatalogGame, sanitizeCatalogHit } from './catalogmatch'
import { CLOUD_AVAILABLE, SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'
import { settings } from './settings'
import type { Card, Game } from './types'

/** See cardsource.ts: two in a row is a server, not a tunnel. */
const FAILURES_BEFORE_STANDDOWN = 2
let lookupFailures = 0
let stoodDown = false

class MissingFunction extends CloudError {}

function noteFailure(fatal: boolean): void {
  lookupFailures++
  if (fatal || lookupFailures >= FAILURES_BEFORE_STANDDOWN) stoodDown = true
}

function noteSuccess(): void {
  lookupFailures = 0
}

/** May the mirror be asked at all right now? */
export function mirrorLookupOn(): boolean {
  return CLOUD_AVAILABLE && settings().cardSourceLookup && !stoodDown
}

/**
 * The leash: a fallback that outlives what it was falling back FOR is a miss.
 * The scan pipeline reaches the mirror through matchGame/searchByCode, so
 * every mirror ask is time-bounded here rather than at one call site — past
 * the leash the ask answers empty while the request itself runs on, so the
 * stand-down bookkeeping still settles on what the server actually did.
 */
const CATALOG_TIMEOUT_MS = 3_500

async function anonRpc<T>(fn: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    // Publishable key only, no Authorization header — rule 1. Do not "fix"
    // this with authHeaders() because a signed-in user has a token handy.
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const message = await readError(res, 'The catalog mirror did not answer')
    // 404 from PostgREST: the RPC is not in the schema — a project without
    // 0022 applied, which every project is on the day this ships. Permanent
    // for the session, so it stands the mirror down at once.
    if (res.status === 404) throw new MissingFunction(message)
    throw new CloudError(message)
  }
  return (await res.json()) as T
}

async function hits(fn: string, body: unknown, signal?: AbortSignal): Promise<CatalogHit[]> {
  const ask = (async () => {
    try {
      const rows = await anonRpc<unknown[]>(fn, body, signal)
      noteSuccess()
      return (Array.isArray(rows) ? rows : []).map(sanitizeCatalogHit).filter((hit): hit is CatalogHit => hit !== null)
    } catch (err) {
      if (signal?.aborted) throw err
      noteFailure(err instanceof MissingFunction)
      return [] as CatalogHit[]
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const leash = new Promise<CatalogHit[]>((resolve) => {
    timer = setTimeout(() => resolve([]), CATALOG_TIMEOUT_MS)
  })
  try {
    return await Promise.race([ask, leash])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Exact printing by printed code — the fallback behind `searchByCode` when a
 * game's own API failed or had nothing. Exact-match semantics like the
 * primitives it stands behind; the SQL normalizes case and leading zeros.
 */
export async function mirrorByCode(game: Game, setCode: string, number: string | null, signal?: AbortSignal): Promise<Card[]> {
  if (!mirrorLookupOn() || !isCatalogGame(game) || !setCode) return []
  const found = await hits('catalog_by_code', { p_game: game, p_set: setCode, p_number: number }, signal)
  if (found.length) track('catalog_fallback', { game, how: 'code' })
  return found.map(cardFromCatalog)
}

/**
 * Name search — the fallback when a game's search API failed or answered
 * empty. Returns raw candidates; callers score them with the same
 * `nameScore` gates every other source goes through.
 */
export async function mirrorByName(game: Game, query: string, signal?: AbortSignal): Promise<Card[]> {
  if (!mirrorLookupOn() || !isCatalogGame(game) || query.trim().length < 2) return []
  const found = await hits('catalog_by_name', { p_game: game, p_query: query.trim() }, signal)
  if (found.length) track('catalog_fallback', { game, how: 'name' })
  return found.map(cardFromCatalog)
}

/**
 * Every mirrored printing of a card, as Cards — the fallback behind the
 * variants picker when a game's own printings API failed or had nothing.
 * Same posture as every other mirror read: behind the live source, never
 * beside it.
 */
export async function mirrorPrintingsOf(game: Game, name: string, signal?: AbortSignal): Promise<Card[]> {
  if (!mirrorLookupOn() || !isCatalogGame(game) || !name.trim()) return []
  const found = await hits('catalog_printings_of', { p_game: game, p_name: name.trim() }, signal)
  if (found.length) track('catalog_fallback', { game, how: 'printings' })
  return found.map(cardFromCatalog)
}

/** For Settings/diagnostics parity with cardsource: forget this session's stand-down. */
export function clearMirrorStanddown(): void {
  stoodDown = false
  lookupFailures = 0
}
