import { parseCardCode, type CardCode } from './cardcode'
import { lorcanaBySetNumber, lorcanaPrintings, matchLorcana, lorcanaById, searchLorcana } from './lorcast'
import { matchMtg, mtgById, mtgBySetNumber, mtgCollection, mtgPrintings, searchMtg } from './scryfall'
import { matchPokemon, pokemonById, pokemonByCollector, pokemonBySetNumber, pokemonPrintings, searchPokemon } from './pokemon'
import { matchSports, searchSports, sportsById, sportsPrintings } from './sports'
import { catalogByCode, catalogById, catalogPrintings, matchCatalog, sealedRefresh, searchCatalog } from './tcgcsv'
import { sealedVariants } from './sealed'
import { matchYgo, searchYgo, ygoById, ygoBySetCode, ygoPrintingVariants } from './ygo'
import { CUSTOM_PREFIX, customCard, isCustomCard } from './cardpatch'
import { isAbort } from './fetchJson'
import { patched, patchedAll, patchFor, searchCustomCards } from './db'
import type { Card, Game } from './types'
import { nameScore, normalizeName, sleep } from './util'

export interface ApiKeys {
  pokemonKey?: string
  signal?: AbortSignal
  /**
   * The caller committed to one game (scan filter set), so matchers may
   * spend extra requests on recovery retries. In the auto fan-out those
   * same retries serially tax every OTHER game's wait, so they stay off.
   */
  thorough?: boolean
}

/**
 * The printed set/batch code as a lookup — "BLMR-EN085", "OP01-016",
 * "NEO 266". It names ONE printing where a name names a dozen, and it is what
 * a collector can read off a card in a language nothing else in the app can
 * read. Each game answers it with the primitive it already uses to pin an
 * exact printing during a scan; the difference is that a typed code is a
 * statement of intent, so nothing here needs the corroboration a read off a
 * photo does.
 */
async function searchByCode(game: Game, code: CardCode, keys: ApiKeys, signal?: AbortSignal): Promise<Card[]> {
  const one = (card: Card | null) => (card ? [card] : [])
  switch (game) {
    case 'mtg': {
      if (!code.setCode) return []
      // "266a" keeps its variant letter; "0266" also gets tried unpadded,
      // which is how Scryfall spells collector numbers.
      for (const number of new Set([code.number, code.digits].filter(Boolean) as string[])) {
        const card = await mtgBySetNumber(code.setCode, number)
        if (card) return [card]
      }
      return []
    }
    case 'pokemon': {
      if (code.setCode && code.digits) {
        const hits = await pokemonBySetNumber(code.setCode, code.digits, keys.pokemonKey, signal)
        if (hits.length) return hits
      }
      // "123/198" with no set code: the denominator is the set size, which is
      // what pins the set.
      if (code.number && code.printedTotal)
        return one(await pokemonByCollector(code.number, code.printedTotal, keys.pokemonKey, code.setCode))
      return []
    }
    case 'yugioh':
      // The passcode IS the card id at YGOPRODeck; the print code needs the
      // set-code endpoint to become one.
      return one(code.passcode ? await ygoById(code.passcode) : await ygoBySetCode(code.code, signal))
    case 'lorcana':
      return code.setCode && code.number ? one(await lorcanaBySetNumber(code.setCode, code.number, signal)) : []
    case 'sports':
      // Sports cards are synthesized from the card in hand (lib/sports.ts) —
      // there is no catalog to look a printed number up in.
      return []
    default:
      return catalogByCode(game, code, signal)
  }
}

function searchSource(game: Game, query: string, keys: ApiKeys, signal?: AbortSignal): Promise<Card[]> {
  switch (game) {
    case 'mtg':
      return searchMtg(query, signal)
    case 'pokemon':
      return searchPokemon(query, keys.pokemonKey, signal)
    case 'yugioh':
      return searchYgo(query, signal)
    case 'lorcana':
      return searchLorcana(query, signal)
    case 'sports':
      return searchSports(query, signal)
    default:
      // Riftbound, One Piece, Star Wars: Unlimited, Digimon, Gundam — TCGCSV.
      return searchCatalog(game, query, signal)
  }
}

/**
 * Free-text search: the game's catalog, plus the cards this user added
 * themselves.
 *
 * The user's own cards come FIRST and are never dropped by the result cap. A
 * card someone typed in by hand exists because no catalog had it, so burying
 * it under forty catalog near-misses would make the feature look broken to the
 * one person guaranteed to be looking for it.
 *
 * When the API fails, local hits are returned INSTEAD of the error — they need
 * no network and they are real answers to what was typed. The cost is honest
 * and small: an outage that happens to match a local card looks like a thin
 * result set rather than a failure. With no local hits the error propagates
 * unchanged, so the search screen still explains itself. An abort always
 * rethrows: a cancelled search must not resolve as a result set.
 */
export async function searchGame(game: Game, query: string, keys: ApiKeys = {}, signal?: AbortSignal): Promise<Card[]> {
  // Both start together — the local read must not delay the network call.
  const local = searchCustomCards(game, query).catch(() => [] as Card[])
  // A query that reads as a printed card code is looked up as one AS WELL AS
  // being searched by name, and its answer leads. Running both is what makes
  // the parse safe to keep loose: a card name that merely LOOKS like a code
  // ("Mew 25", which is also a real printing) loses nothing either way.
  const code = parseCardCode(query)
  const coded = code ? searchByCode(game, code, keys, signal).catch(() => [] as Card[]) : null
  const source = searchSource(game, query, keys, signal)
  // Claim the rejection now: it may be swallowed below, and an unhandled one
  // in the meantime is a console error users would see for a handled case.
  source.catch(() => {})

  const mine = await local
  const byCode = coded ? await coded : []
  let found: Card[] = []
  try {
    found = await source
  } catch (err) {
    // A code hit answers the question as well as a name hit does, so it
    // suppresses the source error for the same reason a local card does.
    if ((!mine.length && !byCode.length) || isAbort(err) || signal?.aborted) throw err
  }
  // `seen` grows as it filters: a code hit and a name hit can be the same
  // card (every Yu-Gi-Oh printing shares one id), and the code's own answer is
  // the one to keep.
  const seen = new Set(mine.map((card) => card.id))
  return [...mine, ...patchedAll([...byCode, ...found]).filter((card) => !seen.has(card.id) && seen.add(card.id))]
}

export async function matchGame(
  game: Game,
  name: string,
  setCode?: string | null,
  number?: string | null,
  keys: ApiKeys = {},
): Promise<Card | null> {
  const found = await matchSource(game, name, setCode, number, keys)
  return found ? patched(found) : found
}

function matchSource(
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
      return matchPokemon(name, setCode, number, keys.pokemonKey, null, keys.thorough)
    case 'yugioh':
      return matchYgo(name, keys.thorough)
    case 'lorcana':
      return matchLorcana(name, setCode, number)
    case 'sports':
      return matchSports(name, setCode, number)
    default:
      return matchCatalog(game, name, setCode, number)
  }
}

export async function cardById(game: Game, apiId: string, keys: ApiKeys = {}): Promise<Card | null> {
  // A card the user described themselves has no upstream to ask. Its patch IS
  // the card, so it resolves out of the local table and never hits a network.
  if (apiId.startsWith(CUSTOM_PREFIX)) {
    const patch = patchFor(`${game}:${apiId}`)
    return patch ? customCard(patch.game, patch.fields, patch.image) : null
  }
  const found = await cardByIdSource(game, apiId, keys)
  return found ? patched(found) : found
}

function cardByIdSource(game: Game, apiId: string, keys: ApiKeys = {}): Promise<Card | null> {
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
    case 'sports':
      return sportsById(apiId)
    default:
      return catalogById(game, apiId)
  }
}

/** Re-fetch a card from its source API for fresh prices. */
export function refreshCard(card: Card, keys: ApiKeys = {}): Promise<Card | null> {
  // Nothing upstream to refresh from, and nothing to refresh: a card no
  // catalog lists has no price feed either (see cardpatch.ts).
  if (isCustomCard(card)) return Promise.resolve(null)
  if (card.sealed) return sealedRefresh(card)
  return cardById(card.game, card.apiId, keys)
}

/**
 * Sports cards have no price feed on the free path (see lib/sports.ts), so a
 * bulk refresh leaves them alone entirely rather than counting every one of
 * them as a failure. They surface as "skipped", which is what they are.
 */
function refreshable(card: Card): boolean {
  // Custom cards join sports for the same reason: no feed exists, so counting
  // them as failures would report a bulk refresh as broken when it worked.
  return card.game !== 'sports' && !isCustomCard(card)
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
  const live = cards.filter(refreshable)
  const mtg = live.filter((c) => c.game === 'mtg' && c.apiId && !c.sealed)
  const rest = live.filter((c) => !(c.game === 'mtg' && c.apiId && !c.sealed))
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

/** A name-similarity score this high can't be beaten, only tied. */
const PERFECT_SCORE = 0.999

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
  type Ranked = { card: Card; score: number }
  if (!games.length) return null
  // Overall best wins, ties broken by the games' order. A perfect name hit
  // ends the wait as soon as every game listed before it has answered — no
  // later game can beat it, so one slow API stops pacing every scan.
  const results: (Ranked | null | undefined)[] = new Array<Ranked | null | undefined>(games.length).fill(undefined)
  return new Promise((resolve) => {
    let unsettled = games.length
    for (const [at, game] of games.entries()) {
      withBudget(matchGame(game, name, null, null, { ...keys, thorough: games.length === 1 }))
        .then((card) => {
          // nameScore, not raw similarity: a read of just "Jinx" must still
          // clear the match threshold against "Jinx, Loose Cannon".
          results[at] = card ? { card, score: nameScore(name, card.name) } : null
        })
        .catch(() => {
          results[at] = null
        })
        .finally(() => {
          unsettled--
          let best: Ranked | null = null
          for (const result of results) {
            if (result === undefined) break // an earlier game could still tie-and-win
            if (result && (!best || result.score > best.score)) best = result
            if (best && best.score >= PERFECT_SCORE) return resolve(best)
          }
          if (!unsettled) resolve(best)
        })
    }
  })
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
  // A card the user typed in has exactly one printing: the one in their hand.
  if (isCustomCard(card)) return [card]
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
    case 'sports':
      cards = await sportsPrintings(card.name, signal)
      break
    default:
      cards = await catalogPrintings(card.game, card.name, signal)
  }
  variantsCache.set(cacheKey, { at: Date.now(), cards })
  // Patches apply AFTER the cache write, so turning one off takes effect on the
  // next render rather than ten minutes later.
  return withCurrent(patchedAll(cards), card)
}

/** Make sure the printing the sheet opened on is present in the list. */
function withCurrent(cards: Card[], card: Card): Card[] {
  return cards.some((c) => c.id === card.id) ? cards : [card, ...cards]
}
