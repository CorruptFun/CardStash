/**
 * ebay-comps — the one price signal sports cards can have for free.
 *
 * Decision 17 said sports carries no price feed, and the reason was never
 * squeamishness: every sports price product (SportsCardsPro, CardHedge,
 * Beckett, PriceCharting) is paid, and eBay's own sold-comp feed — the Buy
 * **Marketplace Insights** API — is a limited release that is not open to new
 * applications. What IS open is the Browse API: ACTIVE listings, an
 * application token, and a few thousand calls a day. Decision 17a is the
 * amendment that follows: a card can carry a comp, the comp is an asking
 * price, and it is a suggestion the collector accepts rather than a value the
 * app asserts.
 *
 * This function exists because that call cannot be made from the app:
 *
 *   * eBay's REST APIs send no CORS headers, so a browser cannot call them at
 *     all — every eBay-in-the-browser integration is a proxy wearing a hat.
 *   * The client-credentials grant needs a client SECRET. Unlike the PSA token
 *     (`psa.ts` — since moved server-side too, into `psa-proxy`), which was
 *     merely unwise to ship, a secret in a static bundle is an account handed
 *     over. It has to live server-side or not exist.
 *
 * Contract (matches CompSummary in src/lib/ebaycomps.ts):
 *   POST { q: "1989 upper deck ken griffey jr #1" }
 *   200  { count, scanned, low, median, high, currency, kind: "asking" }
 *   204  searched fine, too few comparables to summarize honestly
 *   400  empty query        429 eBay rate limit — stand down, do not retry
 *   503  not configured / eBay refused our credentials
 *
 * ## Deliberately callable without an account
 *
 * `verify_jwt` is off for this function and the client calls it with the
 * publishable key alone, exactly as `cardsource.ts` does its lookups and for
 * the same two reasons: the free path is signed out, so gating a price behind
 * an account would make the app's most basic question an account feature; and
 * what card someone is pricing is not a fact worth tying to a user id
 * (decision 20's rule, applied here).
 *
 * The cost of that openness is stated rather than hidden: anyone who reads the
 * bundle can spend our eBay quota. Three things bound the damage — the request
 * carries no money and no user data, the query is capped and normalised
 * (`MAX_QUERY_CHARS`), and results are cached both here and on the device. The
 * worst case is that lookups go quiet for a day, which the client already
 * treats as a normal outcome because it must: eBay is allowed to be down.
 */

import { MAX_QUERY_CHARS, normalizeQuery, summarizeListings } from './logic.ts'
import type { EbayListing } from './logic.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const EBAY_ID = Deno.env.get('EBAY_CLIENT_ID') ?? ''
const EBAY_SECRET = Deno.env.get('EBAY_CLIENT_SECRET') ?? ''

/**
 * eBay's US site. Comps are USD-only because the app is (decision 5) — a
 * marketplace change here would need `prices.ts`'s currency filtering to grow
 * a second answer, not just this constant.
 */
const MARKETPLACE = Deno.env.get('EBAY_MARKETPLACE') ?? 'EBAY_US'
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token'
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search'

/**
 * "Sports Trading Card Singles". Scoping the search to it is what keeps a
 * player-name query from returning jerseys, posters and signed baseballs —
 * the title filters in `logic.ts` cannot tell those apart from a card.
 */
const CATEGORY = Deno.env.get('EBAY_CATEGORY') ?? '261328'

/** Enough listings to have a middle; small enough to stay one cheap call. */
const PAGE = 100

/**
 * How long an answer is reused.
 *
 * Sports prices move on news cycles, not on minutes, and the quota is shared
 * by every user of the app — so an hour of staleness buys a great deal of
 * headroom. The device caches for longer still (`ebaycomps.ts`); this one is
 * about the popular card twenty people look up on the same afternoon.
 */
const CACHE_TTL_MS = 60 * 60_000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

/* --- the application token ------------------------------------------------
 * Client-credentials tokens last two hours. Minting one per request would
 * double our call count and eBay rate-limits the token endpoint separately, so
 * it is held in the isolate and refreshed a minute early. An isolate recycling
 * costs one extra mint, which is the right price for keeping no storage.
 */

let token: { value: string; expires: number } | null = null

async function appToken(): Promise<string | null> {
  if (token && Date.now() < token.expires) return token.value
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${EBAY_ID}:${EBAY_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  }).catch(() => null)
  if (!res?.ok) return null
  const body = await res.json().catch(() => null)
  if (!body?.access_token) return null
  const ttl = Number(body.expires_in ?? 7200) * 1000
  token = {
    value: body.access_token,
    expires: Date.now() + Math.max(60_000, ttl - 60_000),
  }
  return token.value
}

/* --- the answer cache ---------------------------------------------------- */

const cache = new Map<string, { at: number; body: unknown; status: number }>()

/** Bounded so a stream of distinct queries cannot grow the isolate forever. */
const CACHE_MAX = 500

function remember(key: string, status: number, body: unknown): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(key, { at: Date.now(), body, status })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!EBAY_ID || !EBAY_SECRET) return json({ error: 'not configured' }, 503)

  const payload = await req.json().catch(() => null)
  const q = normalizeQuery(payload?.q)
  if (!q) return json({ error: 'empty query' }, 400)

  const key = `${MARKETPLACE}|${q.toLowerCase()}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.status === 204 ? new Response(null, { status: 204, headers: CORS }) : json(hit.body, hit.status)
  }

  const bearer = await appToken()
  if (!bearer) return json({ error: 'ebay auth failed' }, 503)

  const url =
    `${SEARCH_URL}?q=${encodeURIComponent(q.slice(0, MAX_QUERY_CHARS))}` +
    `&limit=${PAGE}&category_ids=${encodeURIComponent(CATEGORY)}` +
    // Auctions mid-flight are not an asking price — a $0.99 opening bid with
    // three days left says nothing about the card. Fixed-price listings are
    // the only ones whose number a seller actually stands behind.
    `&filter=${encodeURIComponent('buyingOptions:{FIXED_PRICE}')}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
      Accept: 'application/json',
    },
  }).catch(() => null)

  if (res?.status === 429) return json({ error: 'ebay rate limited' }, 429)
  if (!res?.ok) {
    // A 401 here means the token went stale early — drop it so the next
    // caller mints a fresh one instead of inheriting the same failure.
    if (res?.status === 401) token = null
    return json({ error: 'ebay unavailable' }, 503)
  }

  const body = await res.json().catch(() => null)
  const listings: EbayListing[] = (body?.itemSummaries ?? [])
    .map((item: Record<string, any>) => ({
      title: String(item?.title ?? ''),
      price: Number(item?.price?.value ?? NaN),
      currency: String(item?.price?.currency ?? ''),
    }))
    .filter((l: EbayListing) => Number.isFinite(l.price))

  const summary = summarizeListings(listings)
  if (!summary) {
    remember(key, 204, null)
    return new Response(null, { status: 204, headers: CORS })
  }
  // `kind` is part of the contract, not decoration: it is what the UI puts in
  // front of the number so nobody reads an asking price as a sale.
  const answer = { ...summary, currency: 'USD', kind: 'asking' as const }
  remember(key, 200, answer)
  return json(answer)
})
