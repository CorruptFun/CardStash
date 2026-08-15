import { sameYgoCode } from './corner'
import { fetchJson, isAbort } from './fetchJson'
import { mergePrices } from './prices'
import type { Card, PriceEntry, Printing } from './types'
import { ebaySoldLink, nameScore, tcgplayerSearchLink } from './util'

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
  const push = (value: string | undefined, source: PriceEntry['source']) => {
    const num = value == null ? NaN : parseFloat(value)
    if (Number.isFinite(num) && num > 0)
      entries.push({ source, kind: 'market', finish: 'nonfoil', currency: 'USD', value: num })
  }
  push(priceRow?.tcgplayer_price, 'tcgplayer')
  push(priceRow?.ebay_price, 'ebay')
  push(priceRow?.amazon_price, 'amazon')
  push(priceRow?.coolstuffinc_price, 'coolstuffinc')

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

export async function matchYgo(name: string, thorough = false): Promise<Card | null> {
  try {
    const res = await fetchJson(`${API}/cardinfo.php?name=${encodeURIComponent(name)}`)
    if (res.data?.length) return toCard(res.data[0])
  } catch {
    /* fall back to fuzzy search */
  }
  // Deliberately NOT ranked by name fit. fname is a substring filter, so on a
  // PARTIAL read ("MAGICIAN", the "DARK" lost to glare) every row in the pool
  // is a wrong answer, and ranking by similarity picks the one likeliest to
  // squeak past the caller's threshold — the shortest name containing the
  // fragment. Measured: ranking turned 11 passing Dark Magician cells into
  // "Ape Magician" at 0.667, one thousandth over the bar, where the unranked
  // row scored 0.615, was duly rejected, and the next candidate ("DARK
  // MAGICIAN", 1.00) identified the card. The threshold is the guard here;
  // helping a fragment clear it is the opposite of an improvement.
  const results = await runSearch(name, 5).catch(() => [])
  if (results.length) return toCard(results[0])
  // fname is a substring filter with zero tolerance — one OCR-eaten hyphen
  // ("BLUEEYES WHITE DRAGON") finds nothing. Retry on the longest clean
  // words — plural: the longest token is regularly the garbled one
  // ("Buue-Eves Write Dragon" must recover via "Dragon") — and let name
  // similarity pick the right card from the pooled results.
  // One recovery query is affordable anywhere (it is what v0.7.0 shipped);
  // the second is only for a committed game filter — inside the auto
  // fan-out each extra serial request taxes every other game's wait.
  const words = name
    .split(/\s+/)
    .filter((word) => (word.match(/[A-Za-z]/g) ?? []).length >= 4)
    .sort((a, b) => b.length - a.length)
    .slice(0, thorough ? 2 : 1)
  if (!words.length || (words.length === 1 && words[0].toLowerCase() === name.trim().toLowerCase())) return null
  let best: { raw: any; score: number } | null = null
  for (const word of words) {
    const pool = await runSearch(word, 30).catch(() => [])
    for (const raw of pool) {
      const score = nameScore(name, String(raw.name ?? ''))
      if (!best || score > best.score) best = { raw, score }
    }
    // A confident fit ends the fan-out — the second query is for when the
    // first word was the garbled one.
    if (best && best.score >= 0.85) break
  }
  return best && best.score >= 0.62 ? toCard(best.raw) : null
}

/**
 * Every spelling of a print code worth asking the API about, best first.
 * Yu-Gi-Oh prints "BLMR-EN085" — set code, region, three padded digits — but
 * people type what they can see and what they remember: no region on an
 * Asian-English print, no padding on a hand-written list. The set-code
 * endpoint is an exact string match, so the variants are ours to supply.
 */
function codeCandidates(code: string): string[] {
  const m = code
    .toUpperCase()
    .replace(/[–—\s]+/g, '-')
    .match(/^([A-Z][A-Z0-9]{0,7})-?([A-Z]{2})?0*(\d{1,4})([A-Z]?)$/)
  if (!m) return []
  const [, set, lang, digits, variant] = m
  const padded = digits.padStart(3, '0')
  const out: string[] = []
  for (const region of [lang, lang ? undefined : 'EN', undefined]) {
    for (const num of new Set([padded, digits])) {
      const candidate = `${set}-${region ?? ''}${num}${variant}`
      if (!out.includes(candidate)) out.push(candidate)
    }
  }
  return out
}

/**
 * Look a card up by the print code on its face — "BLMR-EN085" — rather than
 * by name. It is the only identifier that names ONE printing (name, set,
 * rarity and price all follow from it), and the only one a collector can read
 * off a card whose name the OCR couldn't get: the digits are Latin on every
 * print worldwide.
 *
 * YGOPRODeck's set-code endpoint answers with the card id, which is the
 * passcode, so the full card comes back through the ordinary id path and the
 * printing that was asked for is selected out of its set list.
 */
export async function ygoBySetCode(code: string, signal?: AbortSignal): Promise<Card | null> {
  for (const candidate of codeCandidates(code)) {
    let id: unknown
    try {
      const res = await fetchJson(`${API}/cardsetsinfo.php?setcode=${encodeURIComponent(candidate)}`, { signal })
      id = res?.id
    } catch (err) {
      if (isAbort(err)) throw err
      continue // unknown code — the endpoint 400s rather than answering empty
    }
    if (id == null) continue
    const card = await ygoById(String(id))
    if (card) return printingByCode(card, candidate)
  }
  return null
}

/**
 * The card as the asked-for printing: rarity and set price move Yu-Gi-Oh
 * values by orders of magnitude, so answering a code with the card's FIRST
 * printing would put a common's price on a secret rare.
 */
function printingByCode(card: Card, code: string): Card {
  return ygoPrintingVariants(card).find((variant) => sameYgoCode(variant.number, code)) ?? card
}

export async function ygoById(id: string): Promise<Card | null> {
  try {
    const res = await fetchJson(`${API}/cardinfo.php?id=${encodeURIComponent(id)}`)
    return res.data?.length ? toCard(res.data[0]) : null
  } catch {
    return null
  }
}

/**
 * One selectable Card per printing. YGOPRODeck keys everything on a single
 * card id, so variants share the id but carry their own set/rarity — and the
 * printing's set price replaces the generic headline (rarity moves YGO prices
 * by orders of magnitude).
 */
export function ygoPrintingVariants(card: Card): Card[] {
  const printings = card.printings ?? []
  if (!printings.length) return [card]
  return printings.map((printing) => {
    const entries =
      printing.price != null && printing.price > 0
        ? [
            { source: 'tcgplayer', kind: 'market', finish: 'nonfoil', currency: 'USD', value: printing.price } as PriceEntry,
            ...card.prices.entries.filter((e) => !(e.source === 'tcgplayer' && e.kind === 'market' && e.finish === 'nonfoil')),
          ]
        : card.prices.entries
    return {
      ...card,
      setCode: printing.setCode?.split('-')[0],
      setName: printing.setName,
      number: printing.setCode,
      rarity: printing.rarity,
      prices: mergePrices(entries, card.prices.updatedAt),
    }
  })
}
