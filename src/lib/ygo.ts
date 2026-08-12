import { fetchJson, isAbort } from './fetchJson'
import { mergePrices } from './prices'
import type { Card, PriceEntry, Printing } from './types'
import { cardmarketSearchLink, ebaySoldLink, tcgplayerSearchLink } from './util'

const API = 'https://db.ygoprodeck.com/api/v7'

function supertypeOf(type: string): string {
  if (type.includes('Spell')) return 'Spell'
  if (type.includes('Trap')) return 'Trap'
  if (
    type.includes('Fusion') ||
    type.includes('Synchro') ||
    type.includes('XYZ') ||
    type.includes('Xyz') ||
    type.includes('Link') ||
    type.includes('Pendulum')
  )
    return 'Extra Monster'
  return 'Monster'
}

function toCard(raw: any): Card {
  const entries: PriceEntry[] = []
  const priceRow = raw.card_prices?.[0]
  const push = (value: string | undefined, source: PriceEntry['source'], currency: PriceEntry['currency'] = 'USD') => {
    const num = value == null ? NaN : parseFloat(value)
    if (Number.isFinite(num) && num > 0)
      entries.push({ source, kind: 'market', finish: 'nonfoil', currency, value: num })
  }
  push(priceRow?.tcgplayer_price, 'tcgplayer')
  push(priceRow?.ebay_price, 'ebay')
  push(priceRow?.amazon_price, 'amazon')
  push(priceRow?.coolstuffinc_price, 'coolstuffinc')
  push(priceRow?.cardmarket_price, 'cardmarket', 'EUR')

  const printings: Printing[] = (raw.card_sets ?? []).map((set: any) => ({
    setName: set.set_name,
    setCode: set.set_code,
    rarity: set.set_rarity,
    price: (set.set_price && parseFloat(set.set_price)) || undefined,
  }))

  const statLine = [
    raw.attribute,
    raw.race,
    raw.level != null ? `Lv.${raw.level}` : null,
    raw.atk != null ? `ATK ${raw.atk}` : null,
    raw.def != null ? `DEF ${raw.def}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const firstPrinting = printings[0]

  return {
    id: `yugioh:${raw.id}`,
    game: 'yugioh',
    apiId: String(raw.id),
    name: raw.name,
    setCode: firstPrinting?.setCode?.split('-')[0],
    setName: firstPrinting?.setName,
    number: firstPrinting?.setCode,
    rarity: firstPrinting?.rarity,
    imageSmall: raw.card_images?.[0]?.image_url_small,
    imageLarge: raw.card_images?.[0]?.image_url,
    typeLine: [raw.type, statLine].filter(Boolean).join(' — '),
    subtext: raw.desc,
    supertype: supertypeOf(raw.type),
    printings,
    prices: mergePrices(entries),
    links: {
      tcgplayer: tcgplayerSearchLink(raw.name),
      cardmarket: cardmarketSearchLink('yugioh', raw.name),
      ebaySold: ebaySoldLink({ name: raw.name, game: 'yugioh' }),
      source: `https://ygoprodeck.com/card/?search=${encodeURIComponent(raw.name)}`,
    },
  }
}

function searchUrls(query: string, limit: number): string[] {
  const encoded = encodeURIComponent(query)
  return [`${API}/cardinfo.php?fname=${encoded}&num=${limit}&offset=0`, `${API}/cardinfo.php?fname=${encoded}`]
}

function isBadRequest(err: any): boolean {
  return /HTTP (400|404)/.test(err?.message ?? '')
}

function isNoMatch(err: any): boolean {
  return /no card matching|not found/i.test(err?.message ?? '')
}

async function runSearch(query: string, limit: number, signal?: AbortSignal): Promise<any[]> {
  const urls = searchUrls(query, limit)
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetchJson(urls[i], { signal })
      return (res.data ?? []).slice(0, limit)
    } catch (err) {
      if (isAbort(err)) throw err
      if (isNoMatch(err)) return []
      if (i === urls.length - 1) {
        if (isBadRequest(err)) return []
        throw err
      }
    }
  }
  return []
}

export async function searchYgo(query: string, signal?: AbortSignal): Promise<Card[]> {
  return (await runSearch(query, 30, signal)).map(toCard)
}

export async function matchYgo(name: string): Promise<Card | null> {
  try {
    const res = await fetchJson(`${API}/cardinfo.php?name=${encodeURIComponent(name)}`)
    if (res.data?.length) return toCard(res.data[0])
  } catch {
    /* fall back to fuzzy search */
  }
  const results = await runSearch(name, 5).catch(() => [])
  return results.length ? toCard(results[0]) : null
}

export async function ygoById(id: string): Promise<Card | null> {
  try {
    const res = await fetchJson(`${API}/cardinfo.php?id=${encodeURIComponent(id)}`)
    return res.data?.length ? toCard(res.data[0]) : null
  } catch {
    return null
  }
}
