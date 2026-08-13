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

const DEX_BASE = 'https://api.tcgdex.net/v2'
const DEX_API = `${DEX_BASE}/en`
/** apiId prefix marking a TCGdex-sourced card, so refreshes route back to it. */
const DEX_PREFIX = 'dex-'

/**
 * Languages the collector-line sweep consults, in evidence order. `en` covers
 * every Western print — DE/FR/ES/IT/PT cards share the English sets'
 * numbering — while Japanese sets are their own catalog with their own codes
 * and sizes (Korean and Chinese too; extend here once TCGdex data for them
 * proves out).
 */
const DEX_COLLECTOR_LANGS = ['en', 'ja'] as const
/** Latin-script languages whose localized card names eng OCR can read. */
const DEX_NAME_LANGS = ['de', 'fr', 'es', 'it', 'pt'] as const

/** `dex-<id>` is an en card (legacy shape); other languages are `dex-<lang>:<id>`. */
function dexApiId(lang: string, id: string): string {
  return lang === 'en' ? `${DEX_PREFIX}${id}` : `${DEX_PREFIX}${lang}:${id}`
}

function parseDexApiId(apiId: string): { lang: string; id: string } | null {
  if (!apiId.startsWith(DEX_PREFIX)) return null
  const rest = apiId.slice(DEX_PREFIX.length)
  const m = rest.match(/^([a-z]{2}(?:-[a-z]{2})?):(.+)$/)
  return m ? { lang: m[1], id: m[2] } : { lang: 'en', id: rest }
}

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

function dexToCard(raw: any, lang = 'en'): Card {
  const variants = raw?.variants ?? {}
  const finishes: Finish[] = []
  if (variants.normal) finishes.push('nonfoil')
  if (variants.holo) finishes.push('holo')
  if (variants.reverse) finishes.push('reverse')
  if (variants.firstEdition) finishes.push('firstEd')
  const name = String(raw?.name ?? 'Unknown card')
  const apiId = dexApiId(lang, String(raw.id))
  return {
    id: `pokemon:${apiId}`,
    game: 'pokemon',
    apiId,
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

async function dexBriefs(name: string, signal?: AbortSignal, lang = 'en'): Promise<DexBrief[]> {
  const clean = stripQuotes(name)
  if (!clean) return []
  const query = async (value: string) => {
    const rows = await fetchJson(`${DEX_BASE}/${lang}/cards?name=${encodeURIComponent(value)}`, { signal, timeoutMs: 10_000 })
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
 * The name-tier ranking shared by every TCGdex language: exact names, then
 * startsWith, then junk-tolerant scored fits; a matching printed collector
 * number outranks all name tiers. Pools keep their TAIL (newest last).
 */
function rankBriefs(name: string, briefs: DexBrief[], number?: string | null): DexBrief[] {
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
  return numbered.length ? numbered : exact.length ? exact : starts.length ? starts : scored
}

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
  const named = rankBriefs(name, briefs, number)
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

/**
 * A non-English (Latin-script) card name — "Glurak", "Dracaufeu" — matched
 * through TCGdex's localized catalogs. Western prints share card ids across
 * languages, so a localized hit is re-fetched as the EN card (the priced,
 * displayable one); the localized card itself only answers when EN lacks it.
 */
async function dexMatchLocalized(name: string, number?: string | null, signal?: AbortSignal): Promise<Card | null> {
  // Only a plausibly-alphabetic read is worth fanning out over languages.
  const words = stripQuotes(name).split(' ').filter(queryWord)
  if (!words.length) return null
  for (const lang of DEX_NAME_LANGS) {
    const briefs = await dexBriefs(name, signal, lang).catch(() => [] as DexBrief[])
    if (!briefs.length) continue
    const named = rankBriefs(name, briefs, number)
    const brief = named[named.length - 1]
    if (!brief) continue
    const en = await fetchJson(`${DEX_API}/cards/${brief.id}`, { signal, timeoutMs: 10_000 }).catch(() => null)
    if (en?.id) return dexToCard(en)
    const local = await fetchJson(`${DEX_BASE}/${lang}/cards/${brief.id}`, { signal, timeoutMs: 10_000 }).catch(() => null)
    if (local?.id) return dexToCard(local, lang)
  }
  return null
}

interface DexSetBrief {
  id?: string
  name?: string
  cardCount?: { official?: number; total?: number }
  releaseDate?: string
}

/** Per-language TCGdex set index, one fetch per session; failures retry. */
const dexSetsListMemory = new Map<string, Promise<DexSetBrief[]>>()

function dexSetsList(lang: string, signal?: AbortSignal): Promise<DexSetBrief[]> {
  let load = dexSetsListMemory.get(lang)
  if (!load) {
    load = fetchJson(`${DEX_BASE}/${lang}/sets`, { signal, timeoutMs: 10_000 }).then((rows) =>
      Array.isArray(rows) ? (rows as DexSetBrief[]) : [],
    )
    load.catch(() => dexSetsListMemory.delete(lang))
    dexSetsListMemory.set(lang, load)
  }
  return load
}

/** How many candidate sets a collector sweep may hydrate, across languages. */
const DEX_COLLECTOR_SET_BUDGET = 4

/**
 * Collector-line lookup across TCGdex's language catalogs — how a Japanese
 * card ("046/066" + "SV4K") identifies with no readable name. The printed set
 * code pins the set outright; without it, the printed size must single out
 * ONE set across all languages — Japanese pairs sets of identical size
 * (sv4K/sv4M are both 66), and guessing between them would be a confident
 * wrong card, the worst failure class.
 */
async function dexByCollector(
  number: string,
  printedTotal: string,
  setCodeHint?: string | null,
  opts: { hintOnly?: boolean; signal?: AbortSignal } = {},
): Promise<Card | null> {
  const signal = opts.signal
  const digits = plainDigits(number)
  const total = Number(printedTotal)
  if (!digits || !Number.isFinite(total)) return null
  const hint = setCodeHint?.trim().toLowerCase() || null

  const cardIn = async (lang: string, setId: string): Promise<Card | null> => {
    const set = await fetchJson(`${DEX_BASE}/${lang}/sets/${encodeURIComponent(setId)}`, { signal, timeoutMs: 8_000 }).catch(
      () => null,
    )
    const brief = (Array.isArray(set?.cards) ? (set.cards as DexBrief[]) : []).find(
      (card) => plainDigits(card.localId) === digits,
    )
    if (!brief?.id) return null
    const full = await fetchJson(`${DEX_BASE}/${lang}/cards/${brief.id}`, { signal, timeoutMs: 8_000 }).catch(() => null)
    return full?.id ? dexToCard(full, lang) : null
  }

  const lists: [string, DexSetBrief[]][] = []
  for (const lang of DEX_COLLECTOR_LANGS) {
    lists.push([lang, await dexSetsList(lang, signal).catch(() => [] as DexSetBrief[])])
  }
  // The printed set code is decisive when it names a real set. In hintOnly
  // mode (a RECONSTRUCTED fraction backing it) the named set's official size
  // must ALSO agree — three independent reads (code, size, membership) have
  // to line up before a slashless digit run may identify anything.
  if (hint) {
    for (const [lang, list] of lists) {
      const hinted = list.find((set) => String(set.id ?? '').toLowerCase() === hint)
      if (!hinted?.id) continue
      if (opts.hintOnly && Number(hinted.cardCount?.official) !== total) continue
      const card = await cardIn(lang, hinted.id)
      if (card) return card
    }
  }
  if (opts.hintOnly) return null
  // Without a code, the printed size must single out ONE set — judged over
  // the COMPLETE candidate list. More candidates than the hydration budget
  // means uniqueness can't be verified, and a partial check that happened to
  // find one match would be a guess wearing a certainty costume.
  const candidates = lists.flatMap(([lang, list]) =>
    list.filter((set) => Number(set.cardCount?.official) === total && set.id).map((set) => ({ lang, id: String(set.id) })),
  )
  if (!candidates.length || candidates.length > DEX_COLLECTOR_SET_BUDGET) return null
  const matches: Card[] = []
  for (const candidate of candidates) {
    const card = await cardIn(candidate.lang, candidate.id)
    if (card) matches.push(card)
    if (matches.length > 1) return null // ambiguous — refuse to guess
  }
  return matches.length === 1 ? matches[0] : null
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
  // A read no English catalog knows may be a localized (DE/FR/ES/IT/PT)
  // name; those resolve through TCGdex's language catalogs to the EN card.
  if (!results.length) {
    const en = await dexMatch(name, number, printedTotal).catch(() => null)
    if (en) return en
    return dexMatchLocalized(name, number).catch(() => null)
  }
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
  const best = ranked[0]
  const bestScore = nameScore(name, String(best?.name ?? ''))
  if (bestScore < 0.98) {
    // The primary's newest-first page can simply not contain the old exact
    // card ("Charizard" → sixty modern ex/VMAX variants). TCGdex indexes
    // everything — take its answer when it fits the read better.
    const dex = await dexMatch(name, number, printedTotal).catch(() => null)
    if (dex && nameScore(name, dex.name) > bestScore) return dex
  }
  return toCard(best)
}

/**
 * Identify by the collector line ALONE — the last resort when no name could
 * be read (foil glare, ornate faces, or a non-Latin print) but "215/203"
 * survived: number + the printed set size pin the card, and the printed set
 * code (when read) settles size collisions. English prints answer from the
 * primary; everything else — Japanese sets above all — from the TCGdex
 * language sweep.
 */
export async function pokemonByCollector(
  number: string,
  printedTotal: string,
  apiKey?: string,
  setCode?: string | null,
  fused = false,
): Promise<Card | null> {
  const num = stripLucene(number)
  const total = Number(printedTotal)
  if (!num || !Number.isFinite(total)) return null
  const rows = await runQueries([`number:"${num}" set.printedTotal:${total}`], 10, apiKey).catch(() => [])
  if (fused) {
    // A reconstructed fraction (the slash never read) is too weak to answer
    // alone: it identifies only when the printed set code independently
    // names the set — via the primary's exact set match, or the TCGdex
    // hint-only path where code, size and membership must all agree.
    if (!setCode) return null
    const exact = rows.find(
      (raw: any) =>
        raw.set?.ptcgoCode?.toLowerCase() === setCode.toLowerCase() ||
        raw.set?.id?.toLowerCase() === setCode.toLowerCase(),
    )
    if (exact) return toCard(exact)
    return dexByCollector(num, printedTotal, setCode, { hintOnly: true })
  }
  if (rows.length) {
    if (setCode) {
      const exact = rows.find(
        (raw: any) =>
          raw.set?.ptcgoCode?.toLowerCase() === setCode.toLowerCase() ||
          raw.set?.id?.toLowerCase() === setCode.toLowerCase(),
      )
      if (exact) return toCard(exact)
      // The printed code names a set the primary doesn't know (Japanese
      // sets, brand-new sets) — believe the code over a size-collision guess.
      const dex = await dexByCollector(num, printedTotal, setCode)
      if (dex) return dex
    }
    return toCard(rows[0])
  }
  return dexByCollector(num, printedTotal, setCode)
}

export async function pokemonById(id: string, apiKey?: string): Promise<Card | null> {
  const dex = parseDexApiId(id)
  if (dex) {
    try {
      const raw = await fetchJson(`${DEX_BASE}/${dex.lang}/cards/${dex.id}`, { timeoutMs: 15_000 })
      return raw?.id ? dexToCard(raw, dex.lang) : null
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
