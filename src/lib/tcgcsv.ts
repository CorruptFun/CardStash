import { db } from './db'
import { fetchJson } from './fetchJson'
import { mergePrices } from './prices'
import type { Card, CatalogCache, Finish, Game, PriceEntry } from './types'
import { ebaySoldLink, normalizeName, similarity, tcgplayerSearchLink } from './util'

/**
 * TCGCSV (tcgcsv.com) mirrors TCGplayer's catalog + daily prices as static
 * JSON with open CORS. Games with no dedicated search API (Riftbound, One
 * Piece, Star Wars: Unlimited, Digimon, Gundam) load their whole catalog once
 * — a few hundred KB for young games — cache it in Dexie for a day, and
 * search locally. Category ids are resolved by name at runtime so nothing
 * breaks when TCGplayer shuffles ids.
 */

const API = 'https://tcgcsv.com/tcgplayer'
const CATALOG_TTL_MS = 20 * 3_600_000
const FETCH_CONCURRENCY = 6
const SEARCH_LIMIT = 30

interface CatalogSpec {
  category: RegExp
  /** What a TCGplayer "Foil" price row means for this game. */
  premiumFinish: Finish
}

const CATALOG_GAMES: Partial<Record<Game, CatalogSpec>> = {
  riftbound: { category: /riftbound/i, premiumFinish: 'foil' },
  onepiece: { category: /one\s*piece/i, premiumFinish: 'foil' },
  starwars: { category: /star\s*wars:?\s*unlimited/i, premiumFinish: 'foil' },
  digimon: { category: /digimon/i, premiumFinish: 'foil' },
  gundam: { category: /gundam/i, premiumFinish: 'foil' },
}

export function isCatalogGame(game: Game): boolean {
  return game in CATALOG_GAMES
}

/* --- fetch plumbing ------------------------------------------------------ */

async function results(url: string, signal?: AbortSignal): Promise<any[]> {
  const res = await fetchJson(url, { signal, timeoutMs: 20_000 })
  const rows = Array.isArray(res) ? res : res?.results
  return Array.isArray(rows) ? rows : []
}

/** Run `fn` over `items` with a small concurrency pool, keeping order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++
      out[at] = await fn(items[at])
    }
  })
  await Promise.all(workers)
  return out
}

let categoriesPromise: Promise<any[]> | null = null

async function categoryId(spec: CatalogSpec, signal?: AbortSignal): Promise<number> {
  categoriesPromise ??= results(`${API}/categories`).catch((err) => {
    categoriesPromise = null
    throw err
  })
  const categories = await categoriesPromise
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const hits = categories.filter((c) => spec.category.test(c?.name ?? '') || spec.category.test(c?.displayName ?? ''))
  // Prefer the shortest name so "One Piece Card Game" beats regional variants.
  hits.sort((a, b) => String(a?.name ?? '').length - String(b?.name ?? '').length)
  const id = Number(hits[0]?.categoryId)
  if (!Number.isFinite(id)) throw new Error('This game is not in the TCGplayer catalog yet')
  return id
}

/* --- normalization ------------------------------------------------------- */

function extValue(product: any, ...names: string[]): string | undefined {
  const rows: any[] = Array.isArray(product?.extendedData) ? product.extendedData : []
  for (const name of names) {
    const hit = rows.find((row) => String(row?.name ?? '').toLowerCase() === name.toLowerCase())
    const value = hit?.value
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function stripHtml(text: string | undefined): string | undefined {
  if (!text) return undefined
  const plain = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return plain || undefined
}

function largeImage(imageUrl: string | undefined): string | undefined {
  if (!imageUrl) return undefined
  return imageUrl.replace(/_(?:\d+w|in_\d+x\d+)(\.\w+)$/, '_in_1000x1000$1')
}

interface PriceRow {
  lowPrice?: number
  midPrice?: number
  highPrice?: number
  marketPrice?: number
  subTypeName?: string
}

function priceEntries(rows: PriceRow[], premiumFinish: Finish): PriceEntry[] {
  const entries: PriceEntry[] = []
  for (const row of rows) {
    const finish: Finish = /foil|premium/i.test(row.subTypeName ?? '') ? premiumFinish : 'nonfoil'
    const push = (kind: PriceEntry['kind'], value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        entries.push({ source: 'tcgplayer', kind, finish, currency: 'USD', value })
    }
    push('market', row.marketPrice)
    push('low', row.lowPrice)
    push('mid', row.midPrice)
    push('high', row.highPrice)
  }
  return entries
}

function toCard(game: Game, product: any, group: any, prices: PriceRow[], spec: CatalogSpec): Card {
  const name: string = product.name ?? product.cleanName ?? 'Unknown card'
  const cardType = extValue(product, 'CardType', 'Card Type', 'Type')
  const supertype = cardType?.split(/[,/·;|]/)[0]?.trim()
  const statBits = [
    extValue(product, 'Color'),
    extValue(product, 'Cost', 'Energy Cost', 'Play Cost') ? `Cost ${extValue(product, 'Cost', 'Energy Cost', 'Play Cost')}` : null,
    extValue(product, 'Power', 'DP') ? `Power ${extValue(product, 'Power', 'DP')}` : null,
  ].filter(Boolean)
  const finishes = [
    ...new Set(prices.map((row) => (/foil|premium/i.test(row.subTypeName ?? '') ? spec.premiumFinish : 'nonfoil'))),
  ]
  const releasedAt = typeof group?.publishedOn === 'string' ? group.publishedOn.slice(0, 10) : undefined
  return {
    id: `${game}:${product.productId}`,
    game,
    apiId: String(product.productId),
    name,
    setCode: group?.abbreviation || undefined,
    setName: group?.name || undefined,
    number: extValue(product, 'Number', 'Card Number') ?? undefined,
    rarity: extValue(product, 'Rarity'),
    releasedAt,
    finishes: finishes.length ? finishes : undefined,
    imageSmall: product.imageUrl || undefined,
    imageLarge: largeImage(product.imageUrl) ?? undefined,
    typeLine: cardType ? [cardType, statBits.join(' · ')].filter(Boolean).join(' — ') : undefined,
    subtext: stripHtml(extValue(product, 'Description', 'CardText', 'Card Text', 'Effect')),
    supertype,
    prices: mergePrices(priceEntries(prices, spec.premiumFinish)),
    links: {
      market: product.url || undefined,
      tcgplayer: product.url || tcgplayerSearchLink(name),
      ebaySold: ebaySoldLink({ name, setName: group?.name, game }),
    },
  }
}

/** A product is a single card (not a booster/box) if it carries card data. */
function isSingle(product: any): boolean {
  return extValue(product, 'Number', 'Card Number') != null || extValue(product, 'Rarity') != null
}

/* --- catalog cache ------------------------------------------------------- */

const memory = new Map<Game, CatalogCache>()
const loading = new Map<Game, Promise<Card[]>>()

async function fetchCatalog(game: Game, spec: CatalogSpec, signal?: AbortSignal): Promise<Card[]> {
  const category = await categoryId(spec, signal)
  const groups = await results(`${API}/${category}/groups`, signal)
  const perGroup = await pool(groups, FETCH_CONCURRENCY, async (group) => {
    const groupId = group?.groupId
    if (groupId == null) return []
    const [products, priceRows] = await Promise.all([
      results(`${API}/${category}/${groupId}/products`, signal).catch(() => []),
      results(`${API}/${category}/${groupId}/prices`, signal).catch(() => []),
    ])
    const pricesByProduct = new Map<number, PriceRow[]>()
    for (const row of priceRows) {
      const list = pricesByProduct.get(row.productId) ?? []
      list.push(row)
      pricesByProduct.set(row.productId, list)
    }
    return products
      .filter(isSingle)
      .map((product) => toCard(game, product, group, pricesByProduct.get(product.productId) ?? [], spec))
  })
  const cards = perGroup.flat()
  if (!cards.length) throw new Error('The TCGplayer catalog came back empty')
  return cards
}

async function catalog(game: Game, signal?: AbortSignal): Promise<Card[]> {
  const spec = CATALOG_GAMES[game]
  if (!spec) throw new Error(`${game} has no TCGplayer catalog mapping`)
  const now = Date.now()
  const inMemory = memory.get(game)
  if (inMemory && now - inMemory.at < CATALOG_TTL_MS) return inMemory.cards

  const inFlight = loading.get(game)
  if (inFlight) return inFlight

  const load = (async () => {
    const stored = await db.catalogs.get(game).catch(() => undefined)
    if (stored && now - stored.at < CATALOG_TTL_MS && stored.cards.length) {
      memory.set(game, stored)
      return stored.cards
    }
    try {
      const cards = await fetchCatalog(game, spec, signal)
      const cache: CatalogCache = { game, at: Date.now(), cards }
      memory.set(game, cache)
      // Persisting is best-effort: quota pressure must not fail the search.
      db.catalogs.put(cache).catch(() => {})
      return cards
    } catch (err) {
      // Offline / API hiccup: a stale catalog still beats an error screen.
      const fallback = stored ?? inMemory
      if (fallback?.cards.length) {
        memory.set(game, { ...fallback, at: now - CATALOG_TTL_MS + 5 * 60_000 })
        return fallback.cards
      }
      throw err
    }
  })().finally(() => loading.delete(game))
  loading.set(game, load)
  return load
}

/* --- the adapter API ----------------------------------------------------- */

interface Ranked {
  card: Card
  score: number
}

function rank(cards: Card[], query: string): Ranked[] {
  const needle = normalizeName(query)
  if (!needle) return []
  const ranked: Ranked[] = []
  for (const card of cards) {
    const name = normalizeName(card.name)
    if (!name) continue
    let score = similarity(query, card.name)
    if (name === needle) score += 0.6
    else if (name.startsWith(needle)) score += 0.3
    else if (name.includes(needle)) score += 0.2
    if (score < 0.35) continue
    ranked.push({ card, score })
  }
  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (b.card.prices.best ?? b.card.prices.bestFoil ?? 0) - (a.card.prices.best ?? a.card.prices.bestFoil ?? 0),
  )
}

export async function searchCatalog(game: Game, query: string, signal?: AbortSignal): Promise<Card[]> {
  const cards = await catalog(game, signal)
  return rank(cards, query)
    .slice(0, SEARCH_LIMIT)
    .map((r) => r.card)
}

export async function matchCatalog(
  game: Game,
  name: string,
  setCode?: string | null,
  number?: string | null,
): Promise<Card | null> {
  const cards = await catalog(game)
  const ranked = rank(cards, name)
  if (!ranked.length) return null
  const digits = number?.replace(/\D+/g, '')
  const set = setCode?.trim().toLowerCase()
  let best: Ranked | null = null
  for (const row of ranked.slice(0, 40)) {
    let score = row.score
    if (digits && row.card.number?.replace(/\D+/g, '').replace(/^0+(?=\d)/, '') === digits.replace(/^0+(?=\d)/, ''))
      score += 0.2
    if (set && (row.card.setCode?.toLowerCase() === set || row.card.number?.toLowerCase().startsWith(set))) score += 0.1
    if (!best || score > best.score) best = { card: row.card, score }
  }
  return best?.card ?? null
}

export async function catalogById(game: Game, apiId: string): Promise<Card | null> {
  try {
    const cards = await catalog(game)
    return cards.find((card) => card.apiId === apiId) ?? null
  } catch {
    return null
  }
}

/** Every catalog product with this exact name — reprints across sets. */
export async function catalogPrintings(game: Game, name: string, signal?: AbortSignal): Promise<Card[]> {
  const cards = await catalog(game, signal)
  const target = normalizeName(name)
  if (!target) return []
  return cards
    .filter((card) => normalizeName(card.name) === target)
    .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? '') || (a.setName ?? '').localeCompare(b.setName ?? ''))
    .slice(0, 60)
}
