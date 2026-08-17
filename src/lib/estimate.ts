/**
 * A soft estimate of what a sports card goes for — built out of the numbers
 * the collector already put in, and never out of thin air.
 *
 * ## Why it is shaped this way
 *
 * Decision 17's whole point is that a sports misread INVENTS a card rather
 * than picking the wrong one, and the same asymmetry runs through pricing: an
 * invented value is one nobody can tell is invented. So "what do we think this
 * goes for?" has one honest answer available offline, and it is not a guess
 * from attributes ("rookie + auto + /25 must be worth ~$200"). Such a model
 * would produce a confident figure for a card nobody has ever priced, which is
 * exactly the thing decision 17 refuses.
 *
 * What the app genuinely knows is what THIS collector has already decided
 * their cards are worth. That is real evidence, it is specific to the corner
 * of the hobby they collect, it works offline with no key and no account, and
 * every number in it can be traced back to something they typed. So an
 * estimate here is a summary of comparables the user owns — with the
 * comparables named on screen, so the reading can be judged rather than
 * believed (decision 17b).
 *
 * ## Three rules that keep it honest
 *
 * 1. **A range, never a figure**, and rounded to a step that matches how much
 *    is actually known. `$34.17` claims a precision this cannot have; "$30–$45"
 *    claims what it has.
 * 2. **The basis is always shown.** "4 Ken Griffey Jr cards you've priced" is
 *    what makes it an estimate the user can argue with. A bare number is a
 *    valuation, and this is not one.
 * 3. **Nothing is adjusted.** Comparables are summarized, not scaled — no
 *    rookie multiplier, no parallel premium, no condition curve. Every such
 *    factor is a number we would be making up, and the moment one enters, the
 *    output stops being traceable to anything the user said.
 *
 * Like the eBay comps beside it, an estimate is never written anywhere on its
 * own: `card.prices` stays empty, portfolio totals stay user-authored, and it
 * reaches `CollectionItem.marketValue` only when the collector taps to accept.
 * That tap is also what makes this compound — an accepted estimate becomes a
 * priced row, which is corpus for the next card.
 */

import { db } from './db'
import type { Card, GradeInfo } from './types'
import { normalizeName } from './util'

/** One priced copy the user owns: evidence for pricing something like it. */
export interface PricedComparable {
  card: Card
  /** Per-copy USD. */
  value: number
  /** Where the number came from — a valuation outranks a purchase price. */
  basis: 'valued' | 'paid'
  /** Slabbed copies are a different market, so they compare among themselves. */
  graded: boolean
}

/**
 * How closely the comparables resemble the card. Ordered strongest first, and
 * never mixed: three cards of the same player in the same year say far more
 * than thirty cards from the same brand, and averaging the two together would
 * bury the good evidence in the weak.
 */
export type EstimateTier = 'player' | 'set' | 'brand'

export interface Estimate {
  low: number
  high: number
  /** The middle of the comparables — what "Use this" would apply. */
  mid: number
  count: number
  tier: EstimateTier
  basis: 'valued' | 'paid'
  /** Human sentence naming what this was worked out from. */
  from: string
}

/**
 * Fewer than this and there is nothing to summarize — the same floor the eBay
 * comps use, and for the same reason: two numbers are not a range, they are
 * two numbers.
 */
export const MIN_COMPARABLES = 3

/** Outlier band around the median, matching the comps summarizer. */
const BAND = 5

/**
 * Rounding steps, coarser as the number gets bigger.
 *
 * This is presentational honesty rather than tidiness. An estimate derived
 * from four cards is worth about this much to the nearest five dollars; a
 * cent-precise figure invites the user to trust a decimal place that is pure
 * arithmetic residue.
 */
export function roundEstimate(value: number): number {
  const step = value < 10 ? 0.5 : value < 50 ? 1 : value < 200 ? 5 : value < 1000 ? 10 : 50
  return Math.round(value / step) * step
}

/**
 * Money for an estimate: `$30`, not `$30.00`.
 *
 * `money()` in `util.ts` always prints cents, which is right for a price
 * somebody is charging and wrong here — two decimal places on a figure rounded
 * to the nearest five dollars advertise a precision the rounding just removed.
 */
export function formatEstimate(value: number): string {
  return Number.isInteger(value) ? `$${value.toLocaleString('en-US')}` : `$${value.toFixed(2)}`
}

function median(sorted: number[]): number {
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const sameYear = (a: Card, b: Card) => a.sports?.year != null && a.sports.year === b.sports?.year

/**
 * Which tier a comparable belongs to for this card, or null when it is not
 * comparable at all. Year is required by every tier: a player's 1989 cards and
 * their 1994 cards are different markets, and a brand means nothing across
 * decades.
 */
export function tierFor(card: Card, other: Card): EstimateTier | null {
  if (other.id === card.id || other.game !== 'sports' || card.game !== 'sports') return null
  if (!sameYear(card, other)) return null
  const a = card.sports
  const b = other.sports
  if (a?.player && b?.player && normalizeName(a.player) === normalizeName(b.player)) return 'player'
  if (!a?.brand || a.brand !== b?.brand) return null
  // Product is the set within a brand ("Prizm", "Chrome"). Both absent counts
  // as a match — a base-brand set with no product line is still one set.
  if ((a.product ?? '') === (b.product ?? '')) return 'set'
  return 'brand'
}

const TIER_ORDER: EstimateTier[] = ['player', 'set', 'brand']

/**
 * Describe what the estimate rests on, in the words the UI shows.
 *
 * Built here rather than in the component so it is held to by the same tests
 * as the numbers: the sentence IS the disclosure, and a wrong one is worse
 * than a wrong figure.
 */
export function describeBasis(card: Card, tier: EstimateTier, count: number, basis: 'valued' | 'paid'): string {
  const info = card.sports
  const year = info?.year != null ? String(info.year) : ''
  const set = [year, info?.brand, info?.product].filter(Boolean).join(' ')
  const what =
    tier === 'player'
      ? `${count} ${info?.player ?? 'other'} card${count === 1 ? '' : 's'}${year ? ` from ${year}` : ''}`
      : tier === 'set'
        ? `${count} card${count === 1 ? '' : 's'} from ${set || 'the same set'}`
        : `${count} ${[year, info?.brand].filter(Boolean).join(' ') || 'similar'} card${count === 1 ? '' : 's'}`
  return basis === 'valued' ? `${what} you've priced` : `${what} you've recorded paying for`
}

/**
 * Estimate from a corpus of priced copies, or null when there is nothing to
 * go on. `graded` is the card being priced: slabs compare with slabs, because
 * a PSA 10 and a raw copy are different markets (decision 18) and mixing them
 * produces a range wide enough to be useless in both directions.
 */
export function estimateValue(card: Card, corpus: PricedComparable[], graded = false): Estimate | null {
  if (card.game !== 'sports') return null
  const pool = corpus.filter((row) => row.graded === graded && row.value > 0)

  for (const tier of TIER_ORDER) {
    const inTier = pool.filter((row) => tierFor(card, row.card) === tier)
    // A valuation is what someone thinks a card is WORTH; a purchase price is
    // what they got it for, which is evidence of a different question. Prefer
    // the first outright, and only fall back when there is not enough of it.
    for (const basis of ['valued', 'paid'] as const) {
      const rows = inTier.filter((row) => row.basis === basis)
      if (rows.length < MIN_COMPARABLES) continue
      const values = rows.map((row) => row.value).sort((a, b) => a - b)
      const centre = median(values)
      const kept = values.filter((v) => v >= centre / BAND && v <= centre * BAND)
      if (kept.length < MIN_COMPARABLES) continue
      const low = roundEstimate(kept[0])
      const high = roundEstimate(kept[kept.length - 1])
      return {
        low,
        high,
        mid: roundEstimate(median(kept)),
        count: kept.length,
        tier,
        basis,
        from: describeBasis(card, tier, kept.length, basis),
      }
    }
  }
  return null
}

/* --- the corpus ----------------------------------------------------------
 * The user's own priced sports copies, read straight off the collection. No
 * new table: `CollectionItem` already carries the value, the purchase price,
 * the grade and the full `Card` to compare against — the same reason
 * `sports.ts` reads its "catalog" back out of the collection.
 */

const CORPUS_TTL_MS = 30_000
let memo: { at: number; rows: PricedComparable[] } | null = null

export async function sportsCorpus(): Promise<PricedComparable[]> {
  if (memo && Date.now() - memo.at < CORPUS_TTL_MS) return memo.rows
  const rows: PricedComparable[] = []
  const owned = await db.collection.where('game').equals('sports').toArray()
  for (const item of owned) {
    if (!item.card) continue
    const graded = Boolean(item.grade)
    // One entry per row: a copy that has both a valuation and a cost basis is
    // one observation, and the valuation is the better half of it.
    if (item.marketValue != null && item.marketValue > 0) {
      rows.push({ card: item.card, value: item.marketValue, basis: 'valued', graded })
    } else if (item.purchasePrice != null && item.purchasePrice > 0) {
      rows.push({ card: item.card, value: item.purchasePrice, basis: 'paid', graded })
    }
  }
  memo = { at: Date.now(), rows }
  return rows
}

/** Drop the memo — called after a value is saved, so the next read sees it. */
export function clearEstimateCorpus(): void {
  memo = null
}

/** The estimate for one card, corpus and all. Null when nothing compares. */
export async function estimateFor(card: Card, grade?: GradeInfo): Promise<Estimate | null> {
  if (card.game !== 'sports') return null
  return estimateValue(card, await sportsCorpus(), Boolean(grade))
}
