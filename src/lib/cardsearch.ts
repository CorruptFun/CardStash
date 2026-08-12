import { lorcanaPrintings, matchLorcana, lorcanaById, searchLorcana } from './lorcast'
import { matchMtg, mtgById, mtgCollection, mtgPrintings, searchMtg } from './scryfall'
import { matchPokemon, pokemonById, pokemonPrintings, searchPokemon } from './pokemon'
import { catalogById, catalogPrintings, matchCatalog, sealedRefresh, searchCatalog } from './tcgcsv'
import { sealedVariants } from './sealed'
import { matchYgo, searchYgo, ygoById, ygoPrintingVariants } from './ygo'
import type { Card, Game } from './types'
import { normalizeName, similarity, sleep } from './util'

export interface ApiKeys {
  pokemonKey?: string
  signal?: AbortSignal
}

export function searchGame(game: Game, query: string, keys: ApiKeys = {}, signal?: AbortSignal): Promise<Card[]> {
  switch (game) {
    case 'mtg':
      return searchMtg(query, signal)
    case 'pokemon':
      return searchPokemon(query, keys.pokemonKey, signal)
    case 'yugioh':
      return searchYgo(query, signal)
    case 'lorcana':
      return searchLorcana(query, signal)
    default:
      // Riftbound, One Piece, Star Wars: Unlimited, Digimon, Gundam — TCGCSV.
      return searchCatalog(game, query, signal)
  }
}

export function matchGame(
  game: Game,
  name: string,
  setCode?: string | null,
  number?: string | null,
  keys: ApiKeys = {},
): Promise<Card | null> {
  switch (game) {
    case 'mtg':
      return matchMtg(name, setCode, number)
    case 'pokemon':
      return matchPokemon(name, setCode, number, keys.pokemonKey)
    case 'yugioh':
      return matchYgo(name)
    case 'lorcana':
      return matchLorcana(name, setCode, number)
    default:
      return matchCatalog(game, name, setCode, number)
  }
}

export function cardById(game: Game, apiId: string, keys: ApiKeys = {}): Promise<Card | null> {
  // Sealed product ids (`tp-…`) can't be resolved without their group — those
  // refresh through refreshCard, which has the full card.
  if (apiId.startsWith('tp-')) return Promise.resolve(null)
  switch (game) {
    case 'mtg':
      return mtgById(apiId)
    case 'pokemon':
      return pokemonById(apiId, keys.pokemonKey)
    case 'yugioh':
      return ygoById(apiId)
    case 'lorcana':
      return lorcanaById(apiId)
    default:
      return catalogById(game, apiId)
  }
}

/** Re-fetch a card from its source API for fresh prices. */
export function refreshCard(card: Card, keys: ApiKeys = {}): Promise<Card | null> {
  if (card.sealed) return sealedRefresh(card)
  return cardById(card.game, card.apiId, keys)
}

const MTG_BATCH = 75

export interface RefreshStats {
  ok: number
  failed: number
}

/**
 * Refresh many cards: MTG goes through the batch collection endpoint, the
 * rest one-by-one with a polite gap.
 */
export async function refreshCards(
  cards: Card[],
  opts: ApiKeys & { gapMs?: number; onCard?: (card: Card) => void | Promise<void> } = {},
): Promise<RefreshStats> {
  const gapMs = opts.gapMs ?? 110
  const stats: RefreshStats = { ok: 0, failed: 0 }
  // Sealed products refresh one-by-one via their TCGplayer group, never
  // through the Scryfall batch endpoint.
  const mtg = cards.filter((c) => c.game === 'mtg' && c.apiId && !c.sealed)
  const rest = cards.filter((c) => !(c.game === 'mtg' && c.apiId && !c.sealed))
  let calls = 0
  for (let i = 0; i < mtg.length; i += MTG_BATCH) {
    if (opts.signal?.aborted) return stats
    if (calls++) await sleep(gapMs)
    const chunk = mtg.slice(i, i + MTG_BATCH)
    const found = await mtgCollection(chunk.map((c) => c.apiId)).catch(() => new Map<string, Card>())
    for (const card of chunk) {
      const fresh = found.get(card.apiId)
      if (fresh) {
        stats.ok++
        await opts.onCard?.(fresh)
      } else stats.failed++
    }
  }
  for (const card of rest) {
    if (opts.signal?.aborted) break
    if (calls++) await sleep(gapMs)
    const fresh = await refreshCard(card, opts).catch(() => null)
    if (fresh) {
      stats.ok++
      await opts.onCard?.(fresh)
    } else stats.failed++
  }
  return stats
}

export interface ImportRow {
  name: string
  game?: Game
  setCode?: string
  number?: string
  apiId?: string
  qty: number
  [key: string]: unknown
}

export interface ResolveStats {
  resolved: number
  missed: number
}

/** Resolve CSV import rows to live cards, batching MTG ids up front. */
export async function resolveImportRows(
  rows: ImportRow[],
  opts: ApiKeys & { gapMs?: number; onRow: (row: ImportRow, card: Card | null) => void | Promise<void> },
): Promise<ResolveStats> {
  const gapMs = opts.gapMs ?? 110
  const stats: ResolveStats = { resolved: 0, missed: 0 }
  const cache = new Map<string, Card>()
  const key = (game: string, apiId: string) => `${game}|${apiId}`

  const mtgIds = [...new Set(rows.filter((r) => (r.game ?? 'mtg') === 'mtg' && r.apiId).map((r) => r.apiId!))]
  for (let i = 0; i < mtgIds.length; i += MTG_BATCH) {
    if (opts.signal?.aborted) return stats
    const found = await mtgCollection(mtgIds.slice(i, i + MTG_BATCH)).catch(() => new Map<string, Card>())
    for (const [id, card] of found) cache.set(key('mtg', id), card)
  }

  let lastCall = 0
  const politeGap = async () => {
    const since = Date.now() - lastCall
    if (lastCall && since < gapMs) await sleep(gapMs - since)
    lastCall = Date.now()
  }

  for (const row of rows) {
    if (opts.signal?.aborted) break
    const game = row.game ?? 'mtg'
    let card = row.apiId ? cache.get(key(game, row.apiId)) : undefined
    if (!card && row.apiId && game !== 'mtg') {
      await politeGap()
      card = (await cardById(game, row.apiId, opts).catch(() => null)) ?? undefined
      if (card) cache.set(key(game, row.apiId), card)
    }
    if (!card) {
      await politeGap()
      card = (await matchGame(game, row.name, row.setCode, row.number, opts).catch(() => null)) ?? undefined
    }
    card ? stats.resolved++ : stats.missed++
    await opts.onRow(row, card ?? null)
  }
  return stats
}

/** Try a name against several games; return the closest name match. */
export async function bestMatchAcrossGames(
  name: string,
  games: Game[],
  keys: ApiKeys & { timeoutMs?: number } = {},
): Promise<{ card: Card; score: number } | null> {
  // A soft per-game budget: one slow API answers "no" for its game instead of
  // holding every other game's answer hostage.
  const withBudget = (match: Promise<Card | null>): Promise<Card | null> =>
    keys.timeoutMs ? Promise.race([match, sleep(keys.timeoutMs).then(() => null)]) : match
  const settled = await Promise.allSettled(games.map((game) => withBudget(matchGame(game, name, null, null, keys))))
  let best: { card: Card; score: number } | null = null
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) continue
    const score = similarity(name, result.value.name)
    if (!best || score > best.score) best = { card: result.value, score }
  }
  return best
}

/* --- printings / variants ------------------------------------------------ */

const VARIANTS_TTL_MS = 10 * 60_000
const variantsCache = new Map<string, { at: number; cards: Card[] }>()

/**
 * Every printing/variant of a card (same name across sets), newest-ish first,
 * so the user can pick the exact edition — set, collector number, rarity —
 * when the scanner's best guess isn't the copy in their hand.
 */
export async function printingVariants(card: Card, keys: ApiKeys = {}, signal?: AbortSignal): Promise<Card[]> {
  // Sealed: the "variants" are the set's other products (pack ↔ box ↔ bundle).
  if (card.sealed) return withCurrent(await sealedVariants(card, signal), card)
  const cacheKey = `${card.game}|${normalizeName(card.name)}`
  const cached = variantsCache.get(cacheKey)
  if (cached && Date.now() - cached.at < VARIANTS_TTL_MS) return withCurrent(cached.cards, card)

  let cards: Card[]
  switch (card.game) {
    case 'mtg':
      cards = await mtgPrintings(card.name, signal)
      break
    case 'pokemon':
      cards = await pokemonPrintings(card.name, keys.pokemonKey, signal)
      break
    case 'yugioh': {
      // One YGO api id covers every reprint; the set list rides on the card.
      const source = card.printings?.length ? card : ((await ygoById(card.apiId)) ?? card)
      cards = ygoPrintingVariants(source)
      break
    }
    case 'lorcana':
      cards = await lorcanaPrintings(card.name, signal)
      break
    default:
      cards = await catalogPrintings(card.game, card.name, signal)
  }
  variantsCache.set(cacheKey, { at: Date.now(), cards })
  return withCurrent(cards, card)
}

/** Make sure the printing the sheet opened on is present in the list. */
function withCurrent(cards: Card[], card: Card): Card[] {
  return cards.some((c) => c.id === card.id) ? cards : [card, ...cards]
}
