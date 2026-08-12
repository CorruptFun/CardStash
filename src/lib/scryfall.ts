import { fetchJson } from './fetchJson'
import { mergePrices } from './prices'
import type { Card, PriceEntry } from './types'
import { cardmarketSearchLink, ebaySoldLink, tcgplayerSearchLink } from './util'

const API = 'https://api.scryfall.com'

function toCard(raw: any): Card {
  const entries: PriceEntry[] = []
  const prices = raw.prices ?? {}
  const push = (
    value: string | null | undefined,
    finish: PriceEntry['finish'],
    currency: PriceEntry['currency'],
    source: PriceEntry['source'],
    kind: PriceEntry['kind'],
  ) => {
    const num = value == null ? NaN : parseFloat(value)
    if (Number.isFinite(num) && num > 0) entries.push({ source, kind, finish, currency, value: num })
  }
  push(prices.usd, 'nonfoil', 'USD', 'tcgplayer', 'market')
  push(prices.usd_foil, 'foil', 'USD', 'tcgplayer', 'market')
  push(prices.usd_etched, 'etched', 'USD', 'tcgplayer', 'market')
  push(prices.eur, 'nonfoil', 'EUR', 'cardmarket', 'trend')
  push(prices.eur_foil, 'foil', 'EUR', 'cardmarket', 'trend')

  const images = raw.image_uris ?? raw.card_faces?.[0]?.image_uris
  const face = raw.card_faces?.[0]
  const oracle =
    raw.oracle_text ??
    raw.card_faces
      ?.map((f: any) => f.oracle_text)
      .filter(Boolean)
      .join('\n//\n')

  return {
    id: `mtg:${raw.id}`,
    game: 'mtg',
    apiId: raw.id,
    name: raw.name,
    setCode: raw.set?.toUpperCase(),
    setName: raw.set_name,
    number: raw.collector_number,
    rarity: raw.rarity,
    imageSmall: images?.small ?? images?.normal,
    imageLarge: images?.large ?? images?.normal,
    typeLine: raw.type_line ?? face?.type_line,
    subtext: oracle,
    manaCost: raw.mana_cost ?? face?.mana_cost,
    cmc: raw.cmc,
    colors: raw.color_identity?.length ? raw.color_identity : raw.colors,
    supertype: primaryType(raw.type_line ?? face?.type_line ?? ''),
    prices: mergePrices(entries),
    links: {
      market: raw.purchase_uris?.tcgplayer,
      tcgplayer: raw.purchase_uris?.tcgplayer ?? tcgplayerSearchLink(raw.name),
      cardmarket: raw.purchase_uris?.cardmarket ?? cardmarketSearchLink('mtg', raw.name),
      ebaySold: ebaySoldLink({ name: raw.name, setName: raw.set_name, game: 'mtg' }),
      source: raw.scryfall_uri,
    },
  }
}

function primaryType(typeLine: string): string {
  const front = typeLine.split('//')[0]
  for (const type of ['Land', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment']) {
    if (front.includes(type)) return type
  }
  return 'Other'
}

export async function searchMtg(query: string, signal?: AbortSignal): Promise<Card[]> {
  const url = `${API}/cards/search?q=${encodeURIComponent(query)}&unique=cards&order=name`
  try {
    const res = await fetchJson(url, { signal })
    return (res.data ?? []).slice(0, 30).map(toCard)
  } catch (err: any) {
    if (err.message.includes('404')) return []
    throw err
  }
}

/** Exact set+number lookup first, then fuzzy by name (optionally set-scoped). */
export async function matchMtg(name: string, setCode?: string | null, number?: string | null): Promise<Card | null> {
  try {
    if (setCode && number) {
      const res = await fetchJson(`${API}/cards/${setCode.toLowerCase()}/${encodeURIComponent(number)}`)
      return toCard(res)
    }
  } catch {
    /* fall through to fuzzy */
  }
  try {
    const params = new URLSearchParams({ fuzzy: name })
    if (setCode) params.set('set', setCode.toLowerCase())
    const res = await fetchJson(`${API}/cards/named?${params}`)
    return toCard(res)
  } catch {
    return setCode ? matchMtg(name) : null
  }
}

/** POST /cards/collection in chunks of 75; returns a map by scryfall id. */
export async function mtgCollection(ids: string[]): Promise<Map<string, Card>> {
  const found = new Map<string, Card>()
  for (let i = 0; i < ids.length; i += 75) {
    const chunk = ids.slice(i, i + 75)
    try {
      const res = await fetchJson(`${API}/cards/collection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }),
        timeoutMs: 20_000,
      })
      for (const raw of res.data ?? []) found.set(raw.id, toCard(raw))
    } catch {
      /* chunk lost — caller counts misses */
    }
  }
  return found
}

export async function mtgById(id: string): Promise<Card | null> {
  try {
    return toCard(await fetchJson(`${API}/cards/${id}`))
  } catch {
    return null
  }
}
