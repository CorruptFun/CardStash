import { fetchJson } from './fetchJson'
import { mergePrices } from './prices'
import type { Card, Finish, PriceEntry } from './types'
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

  const finishes = Array.isArray(raw.finishes)
    ? (raw.finishes.filter((f: unknown) => f === 'nonfoil' || f === 'foil' || f === 'etched') as Finish[])
    : []

  return {
    id: `mtg:${raw.id}`,
    game: 'mtg',
    apiId: raw.id,
    name: raw.name,
    setCode: raw.set?.toUpperCase(),
    setName: raw.set_name,
    number: raw.collector_number,
    rarity: raw.rarity,
    releasedAt: typeof raw.released_at === 'string' ? raw.released_at : undefined,
    finishes: finishes.length ? finishes : undefined,
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

/** Raw prints list (newest first), shared by the variants picker and trait matching. */
async function rawPrintings(name: string, setCode?: string | null, signal?: AbortSignal): Promise<any[]> {
  const query = [`!"${name.replace(/"/g, '')}"`, 'game:paper', setCode ? `set:${setCode.toLowerCase()}` : '']
    .filter(Boolean)
    .join(' ')
  const url = `${API}/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=released&dir=desc`
  try {
    const res = await fetchJson(url, { signal })
    return res.data ?? []
  } catch (err: any) {
    if (err.message?.includes('404')) return []
    throw err
  }
}

/** Every paper printing of a card, newest first (one page ≈ 175 printings). */
export async function mtgPrintings(name: string, signal?: AbortSignal): Promise<Card[]> {
  return (await rawPrintings(name, null, signal)).map(toCard)
}

/** What the scanner could see about the physical copy. */
export interface ScanTraits {
  treatment?: string | null
  foil?: boolean | null
}

/** The frame treatment a Scryfall print actually carries. */
export function treatmentOf(raw: any): string {
  if (raw.border_color === 'borderless' || raw.full_art) return 'borderless'
  const effects: string[] = Array.isArray(raw.frame_effects) ? raw.frame_effects : []
  if (effects.includes('extendedart')) return 'extended'
  if (effects.includes('showcase')) return 'showcase'
  if (raw.frame === '1997' || raw.frame === '1993') return 'retro'
  return 'regular'
}

/**
 * Score prints against the scanned traits and return the best positive match
 * (newest wins ties), or null when nothing actually fits the traits.
 */
export function pickByTraits(raws: any[], traits: ScanTraits): any | null {
  const wanted = traits.treatment && traits.treatment !== 'regular' ? traits.treatment : null
  let best: { raw: any; score: number } | null = null
  for (const raw of raws) {
    const treatment = treatmentOf(raw)
    let score = 0
    if (wanted) {
      // The frame is the most distinctive thing the camera can see — it
      // dominates; the sheen reading only breaks ties among frames.
      score += treatment === wanted ? 4 : treatment === 'regular' ? -1 : 0
    } else if (traits.foil != null) {
      // Sheen-only signal: stay on the plain frame the camera didn't flag.
      score += treatment === 'regular' ? 1 : 0
    }
    const finishes: string[] = Array.isArray(raw.finishes) ? raw.finishes : []
    const finishFits = traits.foil === true ? finishes.includes('foil') || finishes.includes('etched') : finishes.includes('nonfoil')
    if (traits.foil != null) score += finishFits ? 1 : wanted ? -1 : -3
    if (score > (best?.score ?? 0)) best = { raw, score }
  }
  return best?.raw ?? null
}

/**
 * Re-match a card by what the camera saw of the physical copy — full-art /
 * borderless / showcase frames and foil — for when the collector number
 * wasn't legible and the fuzzy match landed on the base printing.
 */
export async function mtgMatchTraits(
  name: string,
  setCode: string | null | undefined,
  traits: ScanTraits,
  signal?: AbortSignal,
): Promise<Card | null> {
  try {
    let raws = await rawPrintings(name, setCode, signal)
    // A misread set code shouldn't kill the trait match.
    if (!raws.length && setCode) raws = await rawPrintings(name, null, signal)
    const picked = pickByTraits(raws, traits)
    return picked ? toCard(picked) : null
  } catch {
    return null
  }
}
