/**
 * The catalog mirror: our own copy of the big three card catalogs, asked only
 * when the real ones fall short.
 *
 * WHY THIS EXISTS. Every card here normally comes straight from Scryfall,
 * TCGdex/pokemontcg.io or YGOPRODeck, and that stays true — the mirror is a
 * FALLBACK, never the first answer. But those APIs have bad days (the app
 * already carries a TCGdex fallback because pokemontcg.io is dying), and none
 * of them can answer one question at all: which PRINTING of a card is in the
 * frame, when the collector line never got read. The mirror answers both — it
 * serves rows when an API is down or empty, and it carries an artwork
 * fingerprint (`art_hash`, computed by the sync worker with the same
 * `cardArtHash` the capture side uses) so a scan can tell alternate arts of
 * one card apart. Schema, grants and the ingestion contract: migration 0021;
 * the worker: scripts/sync-catalog.mjs; the pure logic: catalogmatch.ts.
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
 *    project can have 0013 applied and not 0021).
 *
 * Dormant with no project configured (`CLOUD_AVAILABLE` false): nothing in
 * this file makes a request and the app behaves as if it did not exist.
 */

import { track } from './analytics'
import { CloudError, readError } from './authsession'
import {
  type CatalogHit,
  cardFromCatalog,
  isCatalogGame,
  pickPrintingByArt,
  sanitizeCatalogHit,
} from './catalogmatch'
import { CLOUD_AVAILABLE, SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'
import { settings } from './settings'
import type { Card, Game } from './types'
import { captureArtHashes } from './vision'

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

/** The scan pipeline's leash: a fallback that outlives the scan is a miss. */
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
    // 0021 applied, which every project is on the day this ships. Permanent
    // for the session, so it stands the mirror down at once.
    if (res.status === 404) throw new MissingFunction(message)
    throw new CloudError(message)
  }
  return (await res.json()) as T
}

async function hits(fn: string, body: unknown, signal?: AbortSignal): Promise<CatalogHit[]> {
  try {
    const rows = await anonRpc<unknown[]>(fn, body, signal)
    noteSuccess()
    return (Array.isArray(rows) ? rows : []).map(sanitizeCatalogHit).filter((hit): hit is CatalogHit => hit !== null)
  } catch (err) {
    if (signal?.aborted) throw err
    noteFailure(err instanceof MissingFunction)
    return []
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
 * Choose between printings of an identified card by artwork, when nothing
 * printed pinned the edition. Sits in identify.ts BESIDE the cloud printing
 * tie-break, under the same `!refined?.read.number` gate — a read collector
 * number always outranks art similarity. Thresholds and their measurement:
 * catalogmatch.ts. Returns null for "keep the name match's pick"; every
 * failure is indistinguishable from that on purpose.
 */
export async function artPrintingTiebreak(card: Card, canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Card | null> {
  if (!mirrorLookupOn() || !isCatalogGame(card.game)) return null
  try {
    // The offset-search neighborhood, not one crop: refinement is not
    // 1%-exact and one misaligned hash reads as a different card (see
    // captureArtHashes). The picker takes each candidate's best alignment.
    const captureHashes = captureArtHashes(canvas, canvas.width, canvas.height)
    const leash = new Promise<CatalogHit[]>((resolve) => setTimeout(() => resolve([]), CATALOG_TIMEOUT_MS))
    const candidates = await Promise.race([
      hits('catalog_printings_of', { p_game: card.game, p_name: card.name }, signal),
      leash,
    ])
    const picked = pickPrintingByArt(captureHashes, card.name, candidates)
    if (!picked || picked.hit.apiId === card.apiId) return null
    track('catalog_art_pick', { game: card.game })
    return cardFromCatalog(picked.hit)
  } catch {
    return null
  }
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
