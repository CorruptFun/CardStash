/**
 * What a page of eBay listings MEANS as a price. Pure, so it can be tested
 * without a network or a key — the same split `stripe-billing/logic.ts` uses,
 * and for a related reason: everything honest about this feature is decided
 * here. `index.ts` fetches; this file decides what counts as a comparable.
 *
 * The thing to keep in mind while reading it: **these are asking prices, not
 * sold prices.** eBay's sold-comp feed (Marketplace Insights) is a limited
 * release we do not have, so the open Browse API — active listings — is the
 * only free signal there is. An unsold listing is what a seller hopes for,
 * which skews high and includes cards nobody will ever buy at that number.
 *
 * Two consequences run through the code:
 *
 * 1. **Filter hard, then say the sample size.** A raw search for a common
 *    card returns lots, repacks, reprints and "you pick" listings whose price
 *    describes something other than the card in hand. They are dropped by
 *    title, then by a band around the median, and what survives is reported
 *    with its count so a three-listing answer looks like a three-listing one.
 * 2. **Never emit a single number as "the price".** The caller gets low,
 *    median and high. A collector reading a spread understands they are being
 *    shown a market; a collector reading one figure understands they are being
 *    told a value, and this data does not support that claim (decision 17a).
 */

/** Raw shape we keep off an eBay `itemSummaries[]` entry. */
export interface EbayListing {
  title: string
  price: number
  currency: string
}

export interface CompSummary {
  /** Listings that survived filtering — the sample the numbers describe. */
  count: number
  /** Listings eBay returned before filtering. `scanned - count` is the noise. */
  scanned: number
  low: number
  median: number
  high: number
}

/**
 * A query longer than this is not a card, it is a paste. eBay ignores the tail
 * anyway; the cap is here so an unauthenticated function cannot be used to
 * push arbitrary bulk through our credentials.
 */
export const MAX_QUERY_CHARS = 120

/**
 * How few comparables is too few to summarize.
 *
 * Below three, "median" is a word for "one of these two numbers" and the
 * spread is noise. An honest "not enough listings" beats a confident figure
 * drawn from a single optimistic seller — decision 4, applied to money.
 */
export const MIN_COMPARABLES = 3

/**
 * Titles that describe something other than one copy of one card.
 *
 * All of these appear constantly in a singles search and each one prices a
 * DIFFERENT object: a lot prices thirty cards, a repack prices a gamble, a
 * reprint prices a card that is not the card. Leaving them in does not add
 * noise evenly — lots and cases drag the high end up and repacks drag the low
 * end down, so the median moves in whichever direction the junk happens to
 * lean today.
 */
const NOISE = [
  /\blots?\b/,
  /\bbulk\b/,
  /\brepacks?\b/,
  /\bre-?prints?\b/,
  /\bcustom\b/,
  /\bproxy\b/,
  /\bdigital\b/,
  /\bbreaks?\b/,
  /\bcomplete set\b/,
  /\bteam set\b/,
  /\byou pick\b/,
  /\bu pick\b/,
  /\bpick your\b/,
  /\byour choice\b/,
  /\bchoose your\b/,
]

/** Does this listing title describe something that is not one single card? */
export function looksLikeNoise(title: string): boolean {
  const t = (title ?? '').toLowerCase()
  return NOISE.some((re) => re.test(t))
}

/**
 * Collapse a caller's query to something safe to hand eBay.
 *
 * Control characters and newlines go because a query is one line by
 * construction, and the length cap is the abuse ceiling above. The result is
 * also the cache key, so two spellings of the same search share one answer.
 */
export function normalizeQuery(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_CHARS)
}

function median(sorted: number[]): number {
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * How far from the median a listing may sit and still be the same card.
 *
 * A fivefold band either way is wide on purpose. Condition, grade and
 * autographs genuinely move a sports card by that much, so a tighter band
 * would quietly delete the real top of the market; what it does remove is the
 * $2,499 "MINT!! INVEST NOW!!" outlier and the $0.99 damaged copy, neither of
 * which is what the collector holding a card wants to be told it is worth.
 */
const BAND = 5

const round = (n: number) => Math.round(n * 100) / 100

/**
 * Summarize a page of listings, or null when too little survives.
 *
 * The band is applied against the median of the UNFILTERED prices and then the
 * numbers are recomputed from what is left. Trimming against the mean instead
 * would let one $10,000 listing pull the band far enough to keep itself.
 */
export function summarizeListings(listings: EbayListing[], currency = 'USD'): CompSummary | null {
  const prices = (listings ?? [])
    .filter((l) => l && l.currency === currency && Number.isFinite(l.price) && l.price > 0)
    .filter((l) => !looksLikeNoise(l.title))
    .map((l) => l.price)
    .sort((a, b) => a - b)
  if (!prices.length) return null
  const centre = median(prices)
  const kept = prices.filter((p) => p >= centre / BAND && p <= centre * BAND)
  if (kept.length < MIN_COMPARABLES) return null
  return {
    count: kept.length,
    scanned: (listings ?? []).length,
    low: round(kept[0]),
    median: round(median(kept)),
    high: round(kept[kept.length - 1]),
  }
}
