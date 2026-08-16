import { fetchJson, httpStatus, type FetchJsonOptions } from './fetchJson'
import { mergePrices } from './prices'
import type { Card, Finish, PriceEntry } from './types'
import { ebaySoldLink, sleep, tcgplayerSearchLink } from './util'

const API = 'https://api.scryfall.com'

/**
 * Scryfall asks every client for 50–100ms between requests and answers 429 —
 * with a block that outlives the burst — when one ignores that. Nothing here
 * spaced requests, and a scan session is the opposite of spaced: the fan-out
 * runs a lookup per OCR candidate, per band, per orientation, so a user
 * working through a stack of cards could earn a block and then be told a card
 * they are holding "isn't in the database". Coming back later worked, which
 * is exactly what a temporary block looks like from the outside.
 *
 * One request at a time with a minimum gap, measured from each request's
 * START: a request slower than the gap has already paid it, so on the network
 * this app actually runs on, the queue costs a scan nothing it wasn't already
 * waiting for.
 */
const MIN_REQUEST_GAP_MS = 100
let chain: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0

function scryfall<T = any>(url: string, options?: FetchJsonOptions): Promise<T> {
  const run = async (): Promise<T> => {
    const gap = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt)
    if (gap > 0) await sleep(gap)
    if (options?.signal?.aborted) throw options.signal.reason
    lastRequestAt = Date.now()
    return fetchJson<T>(url, options)
  }
  const queued = chain.then(run, run)
  // The chain itself must never carry a rejection forward, or one failed
  // lookup would reject every request queued behind it.
  chain = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

/**
 * Scryfall answers 404 for "no card matches", which is an answer, not a fault.
 * The status is the real test; the message is a fallback for errors built
 * without one. Anchored either way — the old `message.includes('404')` would
 * read a 404 out of any response body that happened to mention one.
 */
function isNotFound(err: unknown): boolean {
  const status = httpStatus(err)
  if (status != null) return status === 404
  return /^HTTP 404\b/.test(String((err as { message?: unknown } | null)?.message ?? ''))
}

/**
 * A throttled client can still meet a block earned earlier in the session, and
 * "HTTP 429: {json}" tells a user nothing they can act on.
 */
function friendlier(err: unknown): unknown {
  return httpStatus(err) === 429
    ? new Error('Scryfall is rate-limiting this device — wait a moment and search again')
    : err
}

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
    // A user typed this and is watching the screen: one retry through a 429 or
    // a 502 is worth more to them than an instant "no results" for a card they
    // are holding in their hand.
    const res = await scryfall(url, { signal, retries: 2 })
    return (res.data ?? []).slice(0, 30).map(toCard)
  } catch (err) {
    if (isNotFound(err)) return []
    throw friendlier(err)
  }
}

/**
 * Exact printed set+collector lookup — the language-independent path: every
 * MTG print worldwide carries "266/302 R … NEO・JP" in Latin, and Scryfall
 * answers set+number with the default-language card. Deliberately NO fuzzy
 * fallback: as the SOLE evidence of an identification, only the exact print
 * may answer — a fuzzy rescue here would be a wrong-card factory.
 *
 * When the read came as a vintage-style fraction, its denominator must match
 * the set's REAL printed size (fail-closed): collector numbers are dense, so
 * this is the one independent check that separates "read the line" from
 * "hallucinated a plausible line".
 */
export async function mtgBySetNumber(setCode: string, number: string, printedTotal?: string | null): Promise<Card | null> {
  try {
    const set = setCode.toLowerCase()
    if (printedTotal != null) {
      const info = await scryfall(`${API}/sets/${set}`)
      const size = Number(info?.printed_size ?? info?.card_count)
      if (!Number.isFinite(size) || size !== Number(printedTotal)) return null
    }
    const res = await scryfall(`${API}/cards/${set}/${encodeURIComponent(number.toLowerCase())}`)
    return res?.id ? toCard(res) : null
  } catch {
    return null
  }
}

/** Exact set+number lookup first, then fuzzy by name (optionally set-scoped). */
export async function matchMtg(name: string, setCode?: string | null, number?: string | null): Promise<Card | null> {
  try {
    if (setCode && number) {
      const res = await scryfall(`${API}/cards/${setCode.toLowerCase()}/${encodeURIComponent(number)}`)
      return toCard(res)
    }
  } catch {
    /* fall through to fuzzy */
  }
  try {
    const params = new URLSearchParams({ fuzzy: name })
    if (setCode) params.set('set', setCode.toLowerCase())
    const res = await scryfall(`${API}/cards/named?${params}`)
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
      const res = await scryfall(`${API}/cards/collection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }),
        timeoutMs: 20_000,
        // A dropped chunk is 75 cards silently missing their new prices, and
        // this is the endpoint a bulk refresh hammers hardest.
        retries: 1,
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
    return toCard(await scryfall(`${API}/cards/${id}`))
  } catch {
    return null
  }
}

/**
 * Raw prints list (newest first), shared by the variants picker, trait
 * matching and the scan's printing tie-break. Exported because a caller
 * holding every printing of a name can pin one WITHOUT a second lookup — and,
 * more importantly, cannot answer with a different card: the query is an
 * exact-name search, so every row here is a printing of the same card by
 * construction.
 */
export async function rawPrintings(name: string, setCode?: string | null, signal?: AbortSignal): Promise<any[]> {
  const query = [`!"${name.replace(/"/g, '')}"`, 'game:paper', setCode ? `set:${setCode.toLowerCase()}` : '']
    .filter(Boolean)
    .join(' ')
  const url = `${API}/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=released&dir=desc`
  try {
    // Also user-initiated — this is the printings picker, opened by someone who
    // already knows the scanner picked the wrong edition.
    const res = await scryfall(url, { signal, retries: 2 })
    return res.data ?? []
  } catch (err) {
    if (isNotFound(err)) return []
    throw friendlier(err)
  }
}

/** Every paper printing of a card, newest first (one page ≈ 175 printings). */
export async function mtgPrintings(name: string, signal?: AbortSignal): Promise<Card[]> {
  return (await rawPrintings(name, null, signal)).map(toCard)
}

/** What the scanner could see about the physical copy. */
export interface ScanTraits {
  treatment?: Treatment | null
  foil?: boolean | null
}

/**
 * The frame treatments the scanner can tell apart by eye. This is the shared
 * vocabulary: `treatmentOf` derives it from a Scryfall print, the cloud read
 * asks the model for it in these exact words, and `pickByTraits` matches the
 * two against each other.
 */
export type Treatment = 'regular' | 'borderless' | 'extended' | 'showcase' | 'retro'

export const TREATMENTS: readonly Treatment[] = ['regular', 'borderless', 'extended', 'showcase', 'retro']

/**
 * Coerce an untrusted string (a model's answer, relayed by our own server) to
 * the vocabulary, or to nothing. Anything unrecognised is dropped rather than
 * passed through: `pickByTraits` reads an unknown treatment as "matches no
 * print", which would quietly turn a fresh model vocabulary into a silent
 * refusal to ever re-pick.
 */
export function asTreatment(value: unknown): Treatment | undefined {
  const lower = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (TREATMENTS as readonly string[]).includes(lower) ? (lower as Treatment) : undefined
}

/** A Card built from a raw Scryfall print — for callers holding `rawPrintings`. */
export function mtgCardFromRaw(raw: any): Card {
  return toCard(raw)
}

/** The frame treatment a Scryfall print actually carries. */
export function treatmentOf(raw: any): Treatment {
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
