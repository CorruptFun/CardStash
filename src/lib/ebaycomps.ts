/**
 * Sports comps: what eBay is asking for this card right now.
 *
 * Decision 17 left sports with no price feed, and the eBay sold-comps LINK
 * (`sportsCompLink`) as the whole answer — a button that took the collector to
 * a search they then read themselves. That was honest and it worked, but it
 * meant the one category the app cannot price is also the one where every
 * value in the portfolio had to be typed in by hand.
 *
 * Decision 17a is the amendment. eBay's sold-comp API is a limited release we
 * do not have, so this fetches ACTIVE listings through our own
 * `supabase/functions/ebay-comps` (eBay sends no CORS headers and the grant
 * needs a client secret, so the proxy is not optional) and returns a low /
 * median / high spread. Three rules hold it to decision 17's standard, and
 * they are the whole reason this is not "sports has prices now":
 *
 * 1. **It never touches `card.prices`.** A comp is a suggestion for one
 *    collector's `CollectionItem.marketValue`, applied only when they tap to
 *    accept it. Writing it onto the `Card` would put an asking price into
 *    portfolio totals, price history and every shared binder — silently, for
 *    cards the user never looked at.
 * 2. **Nothing is fetched until asked.** No prefetch on sheet open, no bulk
 *    refresh, no background sweep. Which cards someone is pricing today is
 *    exactly the kind of thing an offline-first app should not be streaming
 *    out by default, and a tap is unambiguous consent (compare the automatic
 *    `cardSourceLookup`, which needed a settings switch precisely because it
 *    is NOT user-initiated).
 * 3. **The words stay true.** `kind: 'asking'` rides the answer to the UI, and
 *    the spread is shown with its sample size. "Median of 14 active listings"
 *    is a fact; "worth $34" is not one, and this data cannot support it.
 *
 * Dormant with no project configured, like every cloud feature here: with
 * `CLOUD_AVAILABLE` false nothing in this file makes a request and the sheet
 * shows the eBay link alone, exactly as it did before.
 */

import { CLOUD_AVAILABLE, SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'
import { kvGet, kvPut, db } from './db'
import { sportsCompTerms } from './sports'
import type { Card, GradeInfo } from './types'

export interface CompSummary {
  /** Listings the numbers describe, after lots/repacks/outliers are dropped. */
  count: number
  /** What eBay returned before filtering. */
  scanned: number
  low: number
  median: number
  high: number
  currency: 'USD'
  /**
   * Always `asking` today. It is a field rather than an assumption because the
   * day we can get sold data, every caller that renders this must be forced to
   * notice that the meaning changed.
   */
  kind: 'asking'
}

export type CompOutcome =
  | { ok: true; summary: CompSummary; cached: boolean }
  | {
      ok: false
      reason: 'unavailable' | 'too-few' | 'rate-limited' | 'unreachable'
      message: string
    }

/**
 * How long a comp is reused on the device.
 *
 * A day. Card prices are not tick data, the answer is a spread rather than a
 * figure, and re-asking on every sheet open would spend a shared quota on a
 * number that has not moved. The server caches for an hour on top of this, so
 * a popular card costs eBay one call an hour across all users.
 */
const COMP_TTL_MS = 24 * 3_600_000

/**
 * A "not enough listings" answer is cached too, and for longer than feels
 * obvious. A card with three listings today has three tomorrow; without this,
 * every visit to an obscure card pays a round trip to be told the same thing.
 */
const EMPTY_TTL_MS = 3 * 24 * 3_600_000

/** A rate limit is one shared allowance — see the same reasoning in `psa.ts`. */
const QUOTA_COOLDOWN_MS = 6 * 3_600_000
const QUOTA_KEY = 'ebay-comps-block'
const CACHE_PREFIX = 'ebay-comps-'

const REQUEST_TIMEOUT_MS = 12_000

/** Can this build price a sports card at all? */
export const COMPS_AVAILABLE = CLOUD_AVAILABLE

interface CachedComp {
  summary: CompSummary | null
}

const cacheKey = (query: string) => `${CACHE_PREFIX}${query.toLowerCase()}`

/**
 * The eBay query for a card, or null when there is not enough to search with.
 *
 * Built from the same terms as the sold-comps link so the number the app shows
 * and the page the user opens to check it are answers to the SAME question. A
 * bare player name is refused: "Ken Griffey Jr" spans thirty years of cards
 * whose prices differ by three orders of magnitude, and a median over that is
 * not wrong so much as meaningless.
 */
export function compsQuery(card: Card, grade?: GradeInfo): string | null {
  if (card.game !== 'sports') return null
  const query = sportsCompTerms(card, grade)
  const info = card.sports
  const narrow = Boolean(card.number) || Boolean(info?.parallel) || Boolean(info?.serial) || Boolean(info?.product)
  if (!query || !narrow) return null
  return query
}

/**
 * Ask what this card is listed at. Every failure is a normal outcome with a
 * sentence the UI can show — this is a bonus on top of a link that already
 * worked, so nothing here is allowed to look like a broken app.
 */
export async function fetchComps(card: Card, grade?: GradeInfo, signal?: AbortSignal): Promise<CompOutcome> {
  const query = compsQuery(card, grade)
  if (!COMPS_AVAILABLE || !query) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Price check needs the year, set and card number',
    }
  }

  const key = cacheKey(query)
  const cached = await kvGet<CachedComp>(key, COMP_TTL_MS).catch(() => null)
  if (cached) {
    return cached.summary
      ? { ok: true, summary: cached.summary, cached: true }
      : {
          ok: false,
          reason: 'too-few',
          message: 'Too few listings to price this one',
        }
  }
  // The negative answer has its own, longer window, so it is read again with
  // that age allowance before spending a request.
  const stale = await kvGet<CachedComp>(key, EMPTY_TTL_MS).catch(() => null)
  if (stale && !stale.summary) {
    return {
      ok: false,
      reason: 'too-few',
      message: 'Too few listings to price this one',
    }
  }

  const blocked = await kvGet<boolean>(QUOTA_KEY, QUOTA_COOLDOWN_MS).catch(() => null)
  if (blocked)
    return {
      ok: false,
      reason: 'rate-limited',
      message: 'Price checks are at their limit — try later',
    }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const forward = () => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ebay-comps`, {
      method: 'POST',
      // The publishable key and NOT the session token, even when there is one:
      // see rule 2 in the module comment and decision 20.
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ q: query }),
      signal: controller.signal,
    })
    if (res.status === 204) {
      await kvPut(key, { summary: null } satisfies CachedComp).catch(() => {})
      return {
        ok: false,
        reason: 'too-few',
        message: 'Too few listings to price this one',
      }
    }
    if (res.status === 429) {
      await kvPut(QUOTA_KEY, true).catch(() => {})
      return {
        ok: false,
        reason: 'rate-limited',
        message: 'Price checks are at their limit — try later',
      }
    }
    if (!res.ok)
      return {
        ok: false,
        reason: 'unreachable',
        message: 'Couldn’t reach the price check',
      }
    const summary = asSummary(await res.json().catch(() => null))
    if (!summary)
      return {
        ok: false,
        reason: 'too-few',
        message: 'Too few listings to price this one',
      }
    await kvPut(key, { summary } satisfies CachedComp).catch(() => {})
    return { ok: true, summary, cached: false }
  } catch {
    return {
      ok: false,
      reason: 'unreachable',
      message: 'Couldn’t reach the price check',
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/**
 * Coerce the server's answer to the contract rather than casting it.
 *
 * It is our own function, but the numbers inside it came from eBay, and the
 * app's rule for anything that arrived over a wire is that it is checked at
 * the door (decision 7). A NaN reaching `marketValue` would corrupt a
 * portfolio total in a way no later screen could explain.
 */
export function asSummary(raw: unknown): CompSummary | null {
  const body = raw as Record<string, unknown> | null
  if (!body) return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null)
  const low = num(body.low)
  const median = num(body.median)
  const high = num(body.high)
  const count = typeof body.count === 'number' && body.count > 0 ? Math.floor(body.count) : 0
  if (low == null || median == null || high == null || !count) return null
  if (low > median || median > high) return null
  const scanned = typeof body.scanned === 'number' && body.scanned >= count ? Math.floor(body.scanned) : count
  return { count, scanned, low, median, high, currency: 'USD', kind: 'asking' }
}

/** Forget cached comps — used by the "clear caches" path in Settings. */
export async function clearCompsCache(): Promise<void> {
  const keys = await db.cache.toCollection().primaryKeys()
  const ours = keys.filter((key): key is string => typeof key === 'string' && key.startsWith(CACHE_PREFIX))
  if (ours.length) await db.cache.bulkDelete(ours)
  await db.cache.delete(QUOTA_KEY)
}
