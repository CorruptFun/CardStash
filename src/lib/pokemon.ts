import { fetchJson, isAbort } from './fetchJson'
import { mergePrices } from './prices'
import type { Card, Finish, PriceEntry } from './types'
import { ebaySoldLink, normalizeName, tcgplayerSearchLink } from './util'

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

/** Exact-name query first, then a per-word prefix query. */
function nameQueries(name: string): string[] {
  const clean = stripQuotes(name)
  if (!clean) return []
  const queries = [`name:"${clean}"`]
  const words = clean.split(' ').map(stripLucene).filter(Boolean)
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

export async function searchPokemon(query: string, apiKey?: string, signal?: AbortSignal): Promise<Card[]> {
  return (await runQueries(nameQueries(query), 30, apiKey, signal)).map(toCard)
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
  if (!results.length) return null
  // The printed "123/198" total identifies the set even when no code is legible.
  let pool = results
  if (printedTotal) {
    const total = Number(printedTotal)
    const sized = results.filter((raw: any) => Number(raw.set?.printedTotal) === total)
    if (sized.length) pool = sized
  }
  if (setCode) {
    const exact = pool.find(
      (raw: any) =>
        raw.set?.ptcgoCode?.toLowerCase() === setCode.toLowerCase() ||
        raw.set?.id?.toLowerCase() === setCode.toLowerCase(),
    )
    if (exact) return toCard(exact)
  }
  return toCard(pool[0])
}

export async function pokemonById(id: string, apiKey?: string): Promise<Card | null> {
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
