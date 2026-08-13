import { fetchJson, isAbort } from './fetchJson'
import { mergePrices } from './prices'
import type { Card, Finish, PriceEntry } from './types'
import { ebaySoldLink, nameScore, normalizeName, tcgplayerSearchLink } from './util'

const API = 'https://api.pokemontcg.io/v2'

const FINISH_BY_TCGPLAYER_KEY: Record<string, Finish> = {
  normal: 'nonfoil',
  holofoil: 'holo',
  reverseHolofoil: 'reverse',
  '1stEditionHolofoil': 'firstEd',
  '1stEditionNormal': 'firstEd',
  unlimitedHolofoil: 'holo',
}

function toCard(raw: any): Card {
  const entries: PriceEntry[] = []
  const tcg = raw.tcgplayer?.prices ?? {}
  for (const [variant, block] of Object.entries<any>(tcg)) {
    const finish = FINISH_BY_TCGPLAYER_KEY[variant] ?? 'nonfoil'
    for (const kind of ['market', 'low', 'mid', 'high'] as const) {
      const value = block?.[kind]
      if (typeof value === 'number' && value > 0)
        entries.push({ source: 'tcgplayer', kind, finish, currency: 'USD', value })
    }
  }
  const typeLine = [raw.supertype, raw.subtypes?.join(' · ')].filter(Boolean).join(' — ')
  // The TCGplayer price variants double as the printing's finish list
  // (normal / holo / reverse holo / 1st edition).
  const finishes = [...new Set(Object.keys(tcg).map((variant) => FINISH_BY_TCGPLAYER_KEY[variant] ?? 'nonfoil'))]

  return {
    id: `pokemon:${raw.id}`,
    game: 'pokemon',
    apiId: raw.id,
    name: raw.name,
    setCode: raw.set?.ptcgoCode ?? raw.set?.id?.toUpperCase(),
    setName: raw.set?.name,
    number: raw.number,
    rarity: raw.rarity,
    releasedAt: typeof raw.set?.releaseDate === 'string' ? raw.set.releaseDate.replace(/\//g, '-') : undefined,
    finishes: finishes.length ? finishes : undefined,
    imageSmall: raw.images?.small,
    imageLarge: raw.images?.large,
    typeLine: typeLine || undefined,
    subtext: raw.rules?.join('\n') ?? raw.flavorText,
    supertype: raw.supertype ?? 'Pokémon',
    prices: mergePrices(entries),
    links: {
      market: raw.tcgplayer?.url,
      tcgplayer: raw.tcgplayer?.url ?? tcgplayerSearchLink(`${raw.name} ${raw.set?.name ?? ''}`),
      ebaySold: ebaySoldLink({
        name: `${raw.name} ${raw.number ?? ''}`,
        setName: raw.set?.name,
        game: 'pokemon',
      }),
    },
  }
}

function headers(apiKey?: string): Record<string, string> | undefined {
  return apiKey ? { 'X-Api-Key': apiKey } : undefined
}

function stripQuotes(name: string): string {
  return name.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()
}

function stripLucene(term: string): string {
  return term.replace(/[+\-!(){}[\]^"~*?:\\/&|]/g, '').trim()
}

/** A read token worth querying by — OCR junk ANDed into a query kills it. */
function queryWord(word: string): boolean {
  if (/^(?:ex|gx|v|vmax|vstar)$/i.test(word)) return true
  if (/^hp$/i.test(word)) return false
  const letters = (word.match(/[A-Za-z]/g) ?? []).length
  return letters >= 3 && letters / word.length >= 0.7
}

/** Exact-name query first, then a per-word prefix query over the clean words. */
function nameQueries(name: string): string[] {
  const clean = stripQuotes(name)
  if (!clean) return []
  const queries = [`name:"${clean}"`]
  // "Charizard HP" or "Pikachu ? 4)" must still find the card: one junk
  // token in an AND-of-prefixes query returns nothing, so junk stays out.
  const words = clean.split(' ').filter(queryWord).map(stripLucene).filter(Boolean)
  if (words.length) {
    const prefix = words.map((w) => `name:${w}*`).join(' ')
    if (!queries.includes(prefix)) queries.push(prefix)
  }
  return queries
}

function searchUrl(query: string, pageSize: number): string {
  return `${API}/cards?q=${encodeURIComponent(query)}&pageSize=${pageSize}&orderBy=-set.releaseDate`
}

async function runQueries(queries: string[], pageSize: number, apiKey?: string, signal?: AbortSignal): Promise<any[]> {
  let lastError: unknown = null
  for (const query of queries) {
    if (signal?.aborted) break
    try {
      const res = await fetchJson(searchUrl(query, pageSize), {
        headers: headers(apiKey),
        signal,
        timeoutMs: 15_000,
      })
      if (res.data?.length) return res.data
    } catch (err) {
      if (isAbort(err)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError
  return []
}

/* --- TCGdex fallback ------------------------------------------------------
 * pokemontcg.io (the primary) has gone stale — its team moved on to a
 * commercial product, updates lag by whole set cycles and outages are
 * routine. TCGdex is the maintained open API: no key, current sets, open
 * CORS. It answers whenever the primary errors, returns nothing, or plainly
 * doesn't know the printed set. Prices are best-effort there (shape has
 * shifted between releases), so the primary stays first for its pricing.
 */

const DEX_API = 'https://api.tcgdex.net/v2/en'
/** apiId prefix marking a TCGdex-sourced card, so refreshes route back to it. */
const DEX_PREFIX = 'dex-'

interface DexBrief {
  id?: string
  localId?: string | number
  name?: string
  image?: string
}

/** TCGdex image fields are extension-less bases. */
function dexImage(base: string | undefined, quality: 'low' | 'high'): string | undefined {
  return typeof base === 'string' && base ? `${base}/${quality}.webp` : undefined
}

/** Defensive price mining — tcgdex pricing shapes have shifted release to release. */
function dexPriceEntries(raw: any): PriceEntry[] {
  const entries: PriceEntry[] = []
  const tcg = raw?.pricing?.tcgplayer
  if (!tcg || typeof tcg !== 'object') return entries
  for (const [variant, block] of Object.entries<any>(tcg)) {
    if (!block || typeof block !== 'object') continue
    const finish = FINISH_BY_TCGPLAYER_KEY[variant] ?? (/holo|foil/i.test(variant) ? 'holo' : 'nonfoil')
    for (const [kind, key] of [
      ['market', 'marketPrice'],
      ['low', 'lowPrice'],
      ['mid', 'midPrice'],
      ['high', 'highPrice'],
    ] as const) {
      const value = block[key] ?? block[kind]
      if (typeof value === 'number' && value > 0) entries.push({ source: 'tcgplayer', kind, finish, currency: 'USD', value })
    }
  }
  return entries
}

function dexToCard(raw: any): Card {
  const variants = raw?.variants ?? {}
  const finishes: Finish[] = []
  if (variants.normal) finishes.push('nonfoil')
  if (variants.holo) finishes.push('holo')
  if (variants.reverse) finishes.push('reverse')
  if (variants.firstEdition) finishes.push('firstEd')
  const name = String(raw?.name ?? 'Unknown card')
  return {
    id: `pokemon:${DEX_PREFIX}${raw.id}`,
    game: 'pokemon',
    apiId: `${DEX_PREFIX}${raw.id}`,
    name,
    setCode: typeof raw?.set?.id === 'string' ? raw.set.id.toUpperCase() : undefined,
    setName: raw?.set?.name,
    number: raw?.localId != null ? String(raw.localId) : undefined,
    rarity: raw?.rarity,
    finishes: finishes.length ? finishes : undefined,
    imageSmall: dexImage(raw?.image, 'low'),
    imageLarge: dexImage(raw?.image, 'high'),
    typeLine: [raw?.category, raw?.stage].filter(Boolean).join(' — ') || undefined,
    subtext: typeof raw?.description === 'string' ? raw.description : undefined,
    supertype: raw?.category ?? 'Pokémon',
    prices: mergePrices(dexPriceEntries(raw)),
    links: {
      tcgplayer: tcgplayerSearchLink(`${name} ${raw?.set?.name ?? ''}`.trim()),
      ebaySold: ebaySoldLink({ name: `${name} ${raw?.localId ?? ''}`.trim(), setName: raw?.set?.name, game: 'pokemon' }),
    },
  }
}

function dexBriefToCard(brief: DexBrief): Card {
  const id = String(brief.id)
  const name = String(brief.name ?? 'Unknown card')
  return {
    id: `pokemon:${DEX_PREFIX}${id}`,
    game: 'pokemon',
    apiId: `${DEX_PREFIX}${id}`,
    name,
    number: brief.localId != null ? String(brief.localId) : undefined,
    setCode: id.includes('-') ? id.split('-')[0].toUpperCase() : undefined,
    imageSmall: dexImage(brief.image, 'low'),
    imageLarge: dexImage(brief.image, 'high'),
    supertype: 'Pokémon',
    prices: mergePrices([]),
    links: {
      tcgplayer: tcgplayerSearchLink(name),
      ebaySold: ebaySoldLink({ name, game: 'pokemon' }),
    },
  }
}

async function dexBriefs(name: string, signal?: AbortSignal): Promise<DexBrief[]> {
  const clean = stripQuotes(name)
  if (!clean) return []
  const query = async (value: string) => {
    const rows = await fetchJson(`${DEX_API}/cards?name=${encodeURIComponent(value)}`, { signal, timeoutMs: 10_000 })
    return Array.isArray(rows) ? rows.filter((row: DexBrief) => row?.id && row?.name) : []
  }
  const exact = await query(clean)
  if (exact.length) return exact
  // The contains-search has zero tolerance: "Charizard HP" finds nothing.
  // Retry with the longest clean word — the species name usually survives OCR.
  const longest = clean
    .split(' ')
    .filter(queryWord)
    .sort((a, b) => b.length - a.length)[0]
  if (!longest || longest.length < 4 || longest.toLowerCase() === clean.toLowerCase()) return []
  return query(longest)
}

const plainDigits = (value: unknown) =>
  String(value ?? '')
    .replace(/\D+/g, '')
    .replace(/^0+(?=\d)/, '')

/**
 * Match a card on TCGdex by name, then pin the printing: the collector
 * number narrows the briefs, and the printed set size ("…/086") picks the
 * set once a few candidates are hydrated.
 */
async function dexMatch(
  name: string,
  number?: string | null,
  printedTotal?: string | null,
  signal?: AbortSignal,
): Promise<Card | null> {
  const briefs = await dexBriefs(name, signal)
  if (!briefs.length) return null
  const target = normalizeName(name)
  const exact = briefs.filter((brief) => normalizeName(String(brief.name)) === target)
  const starts = briefs.filter((brief) => normalizeName(String(brief.name)).startsWith(target) && !exact.includes(brief))
  // OCR junk tolerance: when nothing matches structurally, rank the briefs
  // by name score and keep the clear fits ("Charizard HP" → the Charizards).
  // Ascending on purpose: pools keep their TAIL, so best must sit last.
  const scored =
    exact.length || starts.length
      ? []
      : briefs
          .map((brief) => ({ brief, score: nameScore(name, String(brief.name)) }))
          .filter((row) => row.score >= 0.72)
          .sort((a, b) => a.score - b.score)
          .map((row) => row.brief)
  const digits = plainDigits(number)
  // The printed collector number outranks name tiers: a read of "Tauros" off
  // a Tauros ex must still land on the ex when 183/226 narrows to it — the
  // exact-name tier alone would lock in the plain card first.
  const numbered = digits ? [...exact, ...starts, ...scored].filter((brief) => plainDigits(brief.localId) === digits) : []
  const named = numbered.length ? numbered : exact.length ? exact : starts.length ? starts : scored
  if (!named.length) return null
  // Newest last in practice — hydrate the tail few and let the set size decide.
  const pool = named.slice(-6)
  const fulls = (
    await Promise.all(
      pool.map((brief) => fetchJson(`${DEX_API}/cards/${brief.id}`, { signal, timeoutMs: 10_000 }).catch(() => null)),
    )
  ).filter((raw: any) => raw?.id)
  if (!fulls.length) return null
  const total = printedTotal ? Number(printedTotal) : NaN
  const sized = Number.isFinite(total) ? fulls.filter((raw: any) => Number(raw?.set?.cardCount?.official) === total) : []
  const ranked = sized.length ? sized : fulls
  return dexToCard(ranked[ranked.length - 1])
}

export async function searchPokemon(query: string, apiKey?: string, signal?: AbortSignal): Promise<Card[]> {
  let rows: any[] = []
  let primaryError: unknown = null
  try {
    rows = await runQueries(nameQueries(query), 30, apiKey, signal)
  } catch (err) {
    if (isAbort(err)) throw err
    primaryError = err
  }
  if (rows.length) return rows.map(toCard)
  // Primary down or blank: TCGdex briefs still answer with names and images
  // (prices arrive when a card is opened/refreshed).
  const target = normalizeName(query)
  const briefs = await dexBriefs(query, signal).catch(() => [] as DexBrief[])
  if (briefs.length) {
    return briefs
      .sort(
        (a, b) =>
          Number(normalizeName(String(b.name)).startsWith(target)) - Number(normalizeName(String(a.name)).startsWith(target)),
      )
      .slice(0, 30)
      .map(dexBriefToCard)
  }
  if (primaryError) throw primaryError
  return []
}

export async function matchPokemon(
  name: string,
  setCode?: string | null,
  number?: string | null,
  apiKey?: string,
  printedTotal?: string | null,
): Promise<Card | null> {
  const queries = nameQueries(name)
  if (!queries.length) return null
  const num = number ? stripLucene(number) : ''
  const withNumber = num ? [...queries.map((q) => `${q} number:"${num}"`), ...queries] : queries
  const results = await runQueries(withNumber, 10, apiKey).catch(() => [])
  // Primary erroring or blank — the TCGdex fallback still knows the card.
  if (!results.length) return dexMatch(name, number, printedTotal).catch(() => null)
  // The printed "123/198" total identifies the set even when no code is legible.
  let pool = results
  if (printedTotal) {
    const total = Number(printedTotal)
    const sized = results.filter((raw: any) => Number(raw.set?.printedTotal) === total)
    if (sized.length) pool = sized
    else {
      // No set of this size in the primary: it predates the set (the API
      // has gone stale). TCGdex usually has it — an exact-edition hit there
      // beats the primary's wrong-set guess.
      const dex = await dexMatch(name, number, printedTotal).catch(() => null)
      if (dex) return dex
    }
  }
  if (setCode) {
    const exact = pool.find(
      (raw: any) =>
        raw.set?.ptcgoCode?.toLowerCase() === setCode.toLowerCase() ||
        raw.set?.id?.toLowerCase() === setCode.toLowerCase(),
    )
    if (exact) return toCard(exact)
  }
  // Best NAME fit wins, newest as the tiebreak — the raw list is newest-first
  // and the query is prefix-tolerant, so taking the head blindly returned
  // "Mega Charizard Y ex" for a read of "Charizard".
  const ranked = [...pool].sort(
    (a: any, b: any) => nameScore(name, String(b.name ?? '')) - nameScore(name, String(a.name ?? '')),
  )
  return toCard(ranked[0])
}

export async function pokemonById(id: string, apiKey?: string): Promise<Card | null> {
  if (id.startsWith(DEX_PREFIX)) {
    try {
      const raw = await fetchJson(`${DEX_API}/cards/${id.slice(DEX_PREFIX.length)}`, { timeoutMs: 15_000 })
      return raw?.id ? dexToCard(raw) : null
    } catch {
      return null
    }
  }
  try {
    const res = await fetchJson(`${API}/cards/${id}`, { headers: headers(apiKey), timeoutMs: 15_000 })
    return res.data ? toCard(res.data) : null
  } catch {
    return null
  }
}

/** Every printing of a card name across sets, newest set first. */
export async function pokemonPrintings(name: string, apiKey?: string, signal?: AbortSignal): Promise<Card[]> {
  const clean = stripQuotes(name)
  if (!clean) return []
  const rows = await runQueries([`name:"${clean}"`], 60, apiKey, signal).catch(() => [])
  // The phrase query also matches supersets ("Pikachu" → "Pikachu V") — keep
  // exact names only, those are the true reprints.
  const target = normalizeName(name)
  return rows.filter((raw: any) => normalizeName(String(raw.name ?? '')) === target).map(toCard)
}
