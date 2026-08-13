import { db, kvGet, kvPut } from './db'
import { fetchJson } from './fetchJson'
import { mergePrices } from './prices'
import { settings } from './settings'
import type { Card, CatalogCache, Finish, Game, PriceEntry } from './types'
import { ebaySoldLink, normalizeName, similarity, sleep, tcgplayerSearchLink } from './util'

/**
 * TCGCSV (tcgcsv.com) mirrors TCGplayer's catalog + daily prices as static
 * JSON with open CORS. Games with no dedicated search API (Riftbound, One
 * Piece, Star Wars: Unlimited, Digimon, Gundam) load their whole catalog once
 * — a few hundred KB for young games — cache it in Dexie for a day, and
 * search locally. Category ids are resolved by name at runtime so nothing
 * breaks when TCGplayer shuffles ids.
 *
 * The load is all-or-nothing per set: a set that fails to download marks the
 * catalog incomplete, which is served for the moment but retried in minutes
 * and never persisted — otherwise the missing set's cards would read as
 * "doesn't exist" until the day cache expired.
 *
 * Refreshes are incremental: product lists (the heavy files) barely change
 * once a set matures, so a recent product pass is reused and only prices —
 * small files that change daily — are refetched. New, young and undated
 * (promo) sets still get a full daily fetch: those are the ones that grow
 * and get their card data backfilled by TCGplayer.
 */

const API = 'https://tcgcsv.com/tcgplayer'
const CATALOG_TTL_MS = 20 * 3_600_000
/** Bump when catalog-building logic changes so already-stored (possibly partial) caches refetch. */
const CATALOG_VERSION = 3
/** How soon a knowingly incomplete catalog (a set failed to download) retries. */
const INCOMPLETE_RETRY_MS = 5 * 60_000
/** How long a product pass is reused before every set's list is refetched. */
const PRODUCTS_TTL_MS = 7 * 86_400_000
/** Sets younger than this refetch products daily — their data is still settling. */
const YOUNG_GROUP_MS = 45 * 86_400_000
/** The category list is a fixed constant for weeks at a time. */
const CATEGORIES_TTL_MS = 7 * 86_400_000
/** tcgcsv is static files behind HTTP/2 — wider fans out fine. */
const FETCH_CONCURRENCY = 12
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

/** Retry a flaky static-file fetch once before giving up on it. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    await sleep(500)
    return fn()
  }
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

function categories(): Promise<any[]> {
  categoriesPromise ??= (async () => {
    const cached = await kvGet<any[]>('tcg-categories', CATEGORIES_TTL_MS)
    if (cached?.length) return cached
    const rows = await results(`${API}/categories`)
    if (rows.length) kvPut('tcg-categories', rows)
    return rows
  })().catch((err) => {
    categoriesPromise = null
    throw err
  })
  return categoriesPromise
}

async function categoryId(spec: CatalogSpec, signal?: AbortSignal): Promise<number> {
  const list = await categories()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const hits = list.filter((c) => spec.category.test(c?.name ?? '') || spec.category.test(c?.displayName ?? ''))
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
  productId?: number
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
  const cost = extValue(product, 'Cost', 'Energy Cost', 'Play Cost', 'Energy')
  const power = extValue(product, 'Power', 'DP', 'Might')
  const statBits = [
    extValue(product, 'Color', 'Domain'),
    cost ? `Cost ${cost}` : null,
    power ? `Power ${power}` : null,
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

/** Names that read as packaging, not as a card. */
const PACKAGING_NAME =
  /booster|\bbox(?:es)?\b|\bdisplay\b|\bcase\b|bundle|\bdecks?\b|\btins?\b|collection|pre-?release|starter|gift set|\bkit\b|\bpacks?\b|blister|carton|\bbrick\b/i

/**
 * A product is a single card (not a booster/box/accessory) if it carries card
 * data. Number/Rarity are the classic markers, but TCGplayer lists young sets
 * with sparse data and fills it in over the following weeks (Riftbound's new
 * sets arrive like this), so any card-facing stat counts too — and a product
 * with no card data at all still counts as a single unless its name reads
 * like packaging or an accessory. `Description` alone stays neutral: sealed
 * products carry their marketing blurb in that same field.
 */
function isSingle(product: any): boolean {
  if (extValue(product, 'Number', 'Card Number') != null || extValue(product, 'Rarity') != null) return true
  const cardStat = extValue(
    product,
    'CardType', 'Card Type', 'Color', 'Domain', 'Cost', 'Energy Cost', 'Play Cost', 'Energy',
    'Power', 'DP', 'Might', 'Attribute', 'Level', 'Life', 'Counter',
  )
  if (cardStat != null) return true
  const name = String(product.name ?? '')
  return !PACKAGING_NAME.test(name) && !NOT_SEALED.test(name)
}

/* --- catalog cache ------------------------------------------------------- */

const memory = new Map<Game, CatalogCache>()
const loading = new Map<Game, Promise<Card[]>>()

interface FetchedCatalog {
  cards: Card[]
  /** Parallel to `cards`: the TCGplayer group each card came from. */
  cardGroups: number[]
  /** When every set's product list was last fully fetched. */
  productsAt: number
  /** False when at least one set failed to download — don't trust it for a day. */
  complete: boolean
}

function mapPrices(rows: PriceRow[]): Map<number, PriceRow[]> {
  const byProduct = new Map<number, PriceRow[]>()
  for (const row of rows) {
    const list = byProduct.get(row.productId!) ?? []
    list.push(row)
    byProduct.set(row.productId!, list)
  }
  return byProduct
}

/** Today's prices onto a card built from a reused product pass. */
function repriceCard(card: Card, rows: PriceRow[], spec: CatalogSpec): Card {
  const finishes = [
    ...new Set(rows.map((row) => (/foil|premium/i.test(row.subTypeName ?? '') ? spec.premiumFinish : 'nonfoil'))),
  ]
  return {
    ...card,
    finishes: finishes.length ? finishes : card.finishes,
    prices: mergePrices(priceEntries(rows, spec.premiumFinish)),
  }
}

/** Young and undated (promo) sets grow and get backfilled — refetch them whole. */
function groupIsYoung(group: any, now: number): boolean {
  const published = typeof group?.publishedOn === 'string' ? Date.parse(group.publishedOn) : NaN
  return !Number.isFinite(published) || now - published < YOUNG_GROUP_MS
}

async function fetchCatalog(game: Game, spec: CatalogSpec, prior?: CatalogCache): Promise<FetchedCatalog> {
  const category = await categoryId(spec)
  const groups = await results(`${API}/${category}/groups`)
  const now = Date.now()
  // Product lists are the heavy files and barely change once a set matures:
  // reuse a recent product pass for mature sets and refetch only their
  // prices — small files that DO change daily.
  const reusable =
    prior &&
    prior.v === CATALOG_VERSION &&
    prior.cardGroups?.length === prior.cards.length &&
    now - (prior.productsAt ?? 0) < PRODUCTS_TTL_MS
      ? prior
      : null
  const priorGroupIds = new Set(reusable?.cardGroups ?? [])
  let failed = 0
  interface GroupResult {
    groupId: number
    /** Fresh cards from a full product fetch… */
    cards?: Card[]
    /** …or fresh prices for the reused pass (null: keep yesterday's). */
    reprice?: Map<number, PriceRow[]> | null
  }
  const perGroup = await pool(groups, FETCH_CONCURRENCY, async (group): Promise<GroupResult | null> => {
    const groupId = Number(group?.groupId)
    if (!Number.isFinite(groupId)) return null
    if (reusable && priorGroupIds.has(groupId) && !groupIsYoung(group, now)) {
      // A failed prices file keeps yesterday's numbers — better than none.
      const rows = await withRetry(() => results(`${API}/${category}/${groupId}/prices`)).catch(() => null)
      return { groupId, reprice: rows ? mapPrices(rows) : null }
    }
    try {
      const [products, priceRows] = await Promise.all([
        // The set's cards must load; a missing prices file (brand-new set
        // with no listings yet) is fine.
        withRetry(() => results(`${API}/${category}/${groupId}/products`)),
        withRetry(() => results(`${API}/${category}/${groupId}/prices`)).catch(() => []),
      ])
      const pricesByProduct = mapPrices(priceRows)
      return {
        groupId,
        cards: products
          .filter(isSingle)
          .map((product) => toCard(game, product, group, pricesByProduct.get(product.productId) ?? [], spec)),
      }
    } catch {
      // Count the loss instead of swallowing it: one lost set must not
      // silently vanish from search until the day cache expires.
      failed++
      return null
    }
  })

  const cards: Card[] = []
  const cardGroups: number[] = []
  const fullyFetched = new Set<number>()
  const repriceByGroup = new Map<number, Map<number, PriceRow[]> | null>()
  for (const result of perGroup) {
    if (!result) continue
    if (result.cards) {
      fullyFetched.add(result.groupId)
      for (const card of result.cards) {
        cards.push(card)
        cardGroups.push(result.groupId)
      }
    } else {
      repriceByGroup.set(result.groupId, result.reprice ?? null)
    }
  }
  if (reusable) {
    for (let i = 0; i < reusable.cards.length; i++) {
      const groupId = reusable.cardGroups![i]
      if (fullyFetched.has(groupId)) continue // replaced by this round's fetch
      if (!repriceByGroup.has(groupId)) continue // the set left TCGplayer
      const rows = repriceByGroup.get(groupId)
      const card = reusable.cards[i]
      cards.push(rows ? repriceCard(card, rows.get(Number(card.apiId)) ?? [], spec) : card)
      cardGroups.push(groupId)
    }
  }
  if (!cards.length) throw new Error('The TCGplayer catalog came back empty')
  return {
    cards,
    cardGroups,
    productsAt: reusable ? (reusable.productsAt ?? now) : now,
    complete: failed === 0,
  }
}

async function catalog(game: Game, signal?: AbortSignal): Promise<Card[]> {
  const spec = CATALOG_GAMES[game]
  if (!spec) throw new Error(`${game} has no TCGplayer catalog mapping`)
  const now = Date.now()
  const inMemory = memory.get(game)
  if (inMemory && now - inMemory.at < CATALOG_TTL_MS) return inMemory.cards

  // One shared, signal-free load per game. The search box aborts its request
  // on every keystroke; letting that abort cancel — or truncate — the
  // day-long catalog every later lookup reuses is how sets went missing for
  // hours. An aborted caller just stops waiting; the download finishes.
  let load = loading.get(game)
  if (!load) {
    load = (async () => {
      const stored = await db.catalogs.get(game).catch(() => undefined)
      if (stored && stored.v === CATALOG_VERSION && now - stored.at < CATALOG_TTL_MS && stored.cards.length) {
        memory.set(game, stored)
        return stored.cards
      }
      try {
        // An expired cache is still gold: its product pass makes the refresh
        // prices-only for every mature set.
        const { cards, cardGroups, productsAt, complete } = await fetchCatalog(game, spec, stored ?? inMemory)
        const cache: CatalogCache = { game, v: CATALOG_VERSION, at: Date.now(), productsAt, cards, cardGroups }
        if (complete) {
          memory.set(game, cache)
          // Persisting is best-effort: quota pressure must not fail the search.
          db.catalogs.put(cache).catch(() => {})
        } else {
          // A set is missing. Serve what arrived, retry soon, never persist.
          memory.set(game, { ...cache, at: Date.now() - CATALOG_TTL_MS + INCOMPLETE_RETRY_MS })
        }
        return cards
      } catch (err) {
        // Offline / API hiccup: a stale catalog still beats an error screen.
        const fallback = stored ?? inMemory
        if (fallback?.cards.length) {
          memory.set(game, { ...fallback, at: now - CATALOG_TTL_MS + INCOMPLETE_RETRY_MS })
          return fallback.cards
        }
        throw err
      }
    })().finally(() => loading.delete(game))
    loading.set(game, load)
  }
  const cards = await load
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return cards
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

/**
 * Fire-and-forget: pull a catalog game's card list into the day cache so the
 * first scan/search doesn't pay for the download. No-op for API-backed games.
 */
export function warmCatalog(game: Game): void {
  if (isCatalogGame(game)) catalog(game).catch(() => {})
}

/**
 * Warm the catalogs of the games the user demonstrably plays (collection +
 * decks), one at a time so a phone isn't parsing three catalogs at once.
 * Games turned off in settings never warm — owning cards in one keeps the
 * data visible but shouldn't keep pulling its catalog. Skipped under Data
 * Saver; refreshes are incremental, so on a typical day this moves only each
 * game's price files.
 */
export async function warmOwnedCatalogs(): Promise<void> {
  try {
    if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return
    const [collectionGames, deckGames] = await Promise.all([
      db.collection.orderBy('game').uniqueKeys(),
      db.decks.orderBy('game').uniqueKeys(),
    ])
    const enabled = settings().enabledGames
    for (const game of new Set([...collectionGames, ...deckGames] as Game[])) {
      if (isCatalogGame(game) && enabled.includes(game)) await catalog(game).catch(() => {})
    }
  } catch {
    /* warming is best-effort */
  }
}

export async function searchCatalog(game: Game, query: string, signal?: AbortSignal): Promise<Card[]> {
  const cards = await catalog(game, signal)
  return rank(cards, query)
    .slice(0, SEARCH_LIMIT)
    .map((r) => r.card)
}

/**
 * Collector digits for matching: the leading run before any "/298" set-size
 * suffix, zero-padding dropped — "045/298", "OGN-045" and a read of "45" all
 * agree.
 */
function collectorDigits(value: string | null | undefined): string | undefined {
  return value?.split('/')[0]?.replace(/\D+/g, '').replace(/^0+(?=\d)/, '') || undefined
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
  const digits = collectorDigits(number)
  const set = setCode?.trim().toLowerCase()
  let best: Ranked | null = null
  for (const row of ranked.slice(0, 40)) {
    let score = row.score
    if (digits && collectorDigits(row.card.number) === digits) score += 0.2
    if (set && (row.card.setCode?.toLowerCase() === set || row.card.number?.toLowerCase().startsWith(set))) score += 0.1
    if (!best || score > best.score) best = { card: row.card, score }
  }
  return best?.card ?? null
}

/**
 * Identify by the printed collector fraction alone ("158/166") — the last
 * resort when the name couldn't be read. Both halves must agree with a
 * catalog row for a hit; newest set breaks ties.
 */
export async function catalogByCollector(game: Game, number: string, printedTotal: string): Promise<Card | null> {
  const digits = collectorDigits(number)
  if (!digits) return null
  const cards = await catalog(game)
  const hits = cards
    .filter((card) => {
      if (collectorDigits(card.number) !== digits) return false
      const total = card.number?.split('/')[1]?.replace(/\D+/g, '')
      return !!total && total.replace(/^0+(?=\d)/, '') === printedTotal.replace(/^0+(?=\d)/, '')
    })
    // Variants share the collector number as separate products ("Akali -
    // Silent (Alternate Art)") — with number-only evidence the BASE printing
    // is the honest pick, so parenthetical variants rank behind it.
    .sort(
      (a, b) =>
        Number(/\(/.test(a.name)) - Number(/\(/.test(b.name)) ||
        a.name.length - b.name.length ||
        (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''),
    )
  return hits[0] ?? null
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

/* --- sealed products (every game) ---------------------------------------- */

/**
 * Sealed products — booster packs, boxes, bundles — exist on TCGplayer for
 * ALL games, including the ones whose singles come from dedicated APIs. This
 * section resolves any game to its TCGplayer category, day-caches the group
 * (set) list, and serves one group's products split into singles vs sealed.
 */

const GAME_CATEGORY: Record<Game, RegExp> = {
  mtg: /^magic/i,
  pokemon: /^pokemon/i,
  yugioh: /^yu-?gi-?oh/i,
  lorcana: /lorcana/i,
  riftbound: /riftbound/i,
  onepiece: /one\s*piece/i,
  starwars: /star\s*wars:?\s*unlimited/i,
  digimon: /digimon/i,
  gundam: /gundam/i,
}

/**
 * Extra TCGplayer categories whose sets ALSO belong to a game's sealed index.
 * Japanese Pokémon product is its own category ("Pokemon Japan", separate
 * from "Pokemon"), and its packs are what pack scans kept missing: their
 * fronts carry no English set name, only the printed set code ("sv4K") that
 * sealedmatch.ts matches on.
 */
const AUX_GROUP_CATEGORIES: Partial<Record<Game, RegExp[]>> = {
  pokemon: [/^pokemon\W*japan/i],
}

export function tcgplayerCategoryId(game: Game, signal?: AbortSignal): Promise<number> {
  return categoryId({ category: GAME_CATEGORY[game], premiumFinish: 'foil' }, signal)
}

export interface TcgGroup {
  groupId: number
  /** The TCGplayer category the group lives in — differs from the game's
   * primary category for aux sets (Japanese Pokémon). Absent on data cached
   * by older builds; readers fall back to the game's primary category. */
  categoryId?: number
  name: string
  abbreviation?: string
  publishedOn?: string
}

const groupsMemory = new Map<Game, { at: number; groups: TcgGroup[] }>()
const groupsLoading = new Map<Game, Promise<TcgGroup[]>>()

/** All sets (TCGplayer groups) of a game — the index pack scans match against. */
export async function tcgplayerGroups(game: Game, signal?: AbortSignal): Promise<TcgGroup[]> {
  const inMemory = groupsMemory.get(game)
  if (inMemory && Date.now() - inMemory.at < CATALOG_TTL_MS) return inMemory.groups
  const inFlight = groupsLoading.get(game)
  if (inFlight) return inFlight
  const load = (async () => {
    // v2: entries carry categoryId + aux-category sets; v1 caches (up to a
    // day old, English-only) must not shadow them after an update.
    const key = `tcg-groups:v2:${game}`
    const cached = await kvGet<TcgGroup[]>(key, CATALOG_TTL_MS)
    if (cached?.length) {
      groupsMemory.set(game, { at: Date.now(), groups: cached })
      return cached
    }
    const fetchCategoryGroups = async (category: number): Promise<TcgGroup[]> => {
      const rows = await results(`${API}/${category}/groups`, signal)
      return rows
        .map((row) => ({
          groupId: Number(row?.groupId),
          categoryId: category,
          name: String(row?.name ?? ''),
          abbreviation: row?.abbreviation || undefined,
          publishedOn: typeof row?.publishedOn === 'string' ? row.publishedOn.slice(0, 10) : undefined,
        }))
        .filter((group) => Number.isFinite(group.groupId) && group.name)
    }
    // The game's own category must load; aux categories (Japanese Pokémon)
    // are best-effort — but an incomplete merge is served without being
    // persisted, so the missing half retries next session instead of
    // reading as "doesn't exist" for a day.
    const groups = await fetchCategoryGroups(await tcgplayerCategoryId(game, signal))
    let complete = true
    for (const spec of AUX_GROUP_CATEGORIES[game] ?? []) {
      try {
        const category = await categoryId({ category: spec, premiumFinish: 'foil' }, signal)
        groups.push(...(await fetchCategoryGroups(category)))
      } catch {
        complete = false
      }
    }
    if (groups.length) {
      // An incomplete merge is memory-cached backdated (same trick as the
      // card catalog): served now, retried in minutes, never persisted.
      const at = complete ? Date.now() : Date.now() - CATALOG_TTL_MS + INCOMPLETE_RETRY_MS
      groupsMemory.set(game, { at, groups })
      if (complete) kvPut(key, groups)
    }
    return groups
  })().finally(() => groupsLoading.delete(game))
  groupsLoading.set(game, load)
  return load
}

/** Accessories share the shelf with sealed product — never offer sleeves as "packs". */
const NOT_SEALED =
  /sleeve|playmat|play mat|binder|portfolio|deck box|deck case|storage|album|toploader|top loader|card case|dice|counter|figure|plush|pin badge|life pad|art print|poster|lanyard|keychain/i

/** Rough product kind read off the name, for labels and ranking. */
export function sealedKind(name: string): string {
  const n = name.toLowerCase()
  if (/\bcase\b/.test(n)) return 'Case'
  if (/booster box|booster display|display box/.test(n)) return 'Booster box'
  if (/elite trainer/.test(n)) return 'Elite Trainer Box'
  if (/bundle|fat pack/.test(n)) return 'Bundle'
  if (/booster|blister/.test(n)) return 'Booster pack'
  if (/starter deck|structure deck|commander deck|precon|deck\b/.test(n)) return 'Deck'
  if (/\btin\b/.test(n)) return 'Tin'
  if (/collection|\bbox\b/.test(n)) return 'Box'
  return 'Sealed'
}

function toSealedCard(game: Game, product: any, group: TcgGroup, prices: PriceRow[], categoryId: number): Card {
  const name: string = product.name ?? product.cleanName ?? 'Unknown product'
  const kind = sealedKind(name)
  return {
    id: `${game}:tp-${product.productId}`,
    game,
    apiId: `tp-${product.productId}`,
    name,
    setCode: group.abbreviation || undefined,
    setName: group.name || undefined,
    releasedAt: group.publishedOn,
    typeLine: kind,
    supertype: 'Sealed',
    imageSmall: product.imageUrl || undefined,
    imageLarge: largeImage(product.imageUrl) ?? undefined,
    sealed: { categoryId, groupId: group.groupId, kind },
    prices: mergePrices(priceEntries(prices, 'foil')),
    links: {
      market: product.url || undefined,
      tcgplayer: product.url || tcgplayerSearchLink(name),
      ebaySold: ebaySoldLink({ name, setName: group.name, game }),
    },
  }
}

export interface GroupContents {
  group: TcgGroup
  /** Cards that could be pulled from this set, as listed on TCGplayer. */
  singles: Card[]
  /** Sealed products of the set: packs, boxes, bundles, decks, tins. */
  sealed: Card[]
}

const GROUP_TTL_MS = 30 * 60_000
const groupMemory = new Map<string, { at: number; contents: GroupContents }>()
const groupLoading = new Map<string, Promise<GroupContents>>()

/** One set's products + today's prices, split into singles and sealed. */
export async function groupContents(game: Game, group: TcgGroup, signal?: AbortSignal): Promise<GroupContents> {
  const key = `${game}:${group.groupId}`
  const inMemory = groupMemory.get(key)
  if (inMemory && Date.now() - inMemory.at < GROUP_TTL_MS) return inMemory.contents
  const inFlight = groupLoading.get(key)
  if (inFlight) return inFlight
  const load = (async () => {
    // A group knows its own category (Japanese Pokémon sets live apart from
    // the game's primary category); only legacy-cached groups fall back.
    const category = group.categoryId ?? (await tcgplayerCategoryId(game, signal))
    const [products, priceRows] = await Promise.all([
      results(`${API}/${category}/${group.groupId}/products`, signal),
      results(`${API}/${category}/${group.groupId}/prices`, signal).catch(() => []),
    ])
    const pricesByProduct = new Map<number, PriceRow[]>()
    for (const row of priceRows) {
      const list = pricesByProduct.get(row.productId) ?? []
      list.push(row)
      pricesByProduct.set(row.productId, list)
    }
    const spec: CatalogSpec = {
      category: GAME_CATEGORY[game],
      premiumFinish: game === 'pokemon' ? 'holo' : 'foil',
    }
    const singles: Card[] = []
    const sealed: Card[] = []
    for (const product of products) {
      const rows = pricesByProduct.get(product.productId) ?? []
      if (isSingle(product)) singles.push(toCard(game, product, group, rows, spec))
      else if (!NOT_SEALED.test(String(product.name ?? ''))) sealed.push(toSealedCard(game, product, group, rows, category))
    }
    const contents: GroupContents = { group, singles, sealed }
    groupMemory.set(key, { at: Date.now(), contents })
    return contents
  })().finally(() => groupLoading.delete(key))
  groupLoading.set(key, load)
  return load
}

/** Re-fetch a stored sealed product for fresh prices. */
export async function sealedRefresh(card: Card): Promise<Card | null> {
  const info = card.sealed
  if (!info) return null
  const group: TcgGroup = {
    groupId: info.groupId,
    categoryId: info.categoryId,
    name: card.setName ?? '',
    abbreviation: card.setCode,
    publishedOn: card.releasedAt,
  }
  try {
    const contents = await groupContents(card.game, group)
    return contents.sealed.find((product) => product.id === card.id) ?? null
  } catch {
    return null
  }
}
