import { matchLorcana, lorcanaById, searchLorcana } from './lorcast'
import { matchMtg, mtgById, mtgCollection, searchMtg } from './scryfall'
import { matchPokemon, pokemonById, searchPokemon } from './pokemon'
import { catalogById, matchCatalog, searchCatalog } from './tcgcsv'
import { matchYgo, searchYgo, ygoById } from './ygo'
import type { Card, Game } from './types'
import { similarity, sleep } from './util'

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
  const mtg = cards.filter((c) => c.game === 'mtg' && c.apiId)
  const rest = cards.filter((c) => !(c.game === 'mtg' && c.apiId))
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
  keys: ApiKeys = {},
): Promise<{ card: Card; score: number } | null> {
  const settled = await Promise.allSettled(games.map((game) => matchGame(game, name, null, null, keys)))
  let best: { card: Card; score: number } | null = null
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) continue
    const score = similarity(name, result.value.name)
    if (!best || score > best.score) best = { card: result.value, score }
  }
  return best
}
