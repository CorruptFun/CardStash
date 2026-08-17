/**
 * psa-proxy — PSA cert lookup with the token finally off the client.
 *
 * `psa.ts` resolves a scanned slab's certification number through PSA's free
 * public API. Shipping that as a compiled-in `VITE_PSA_TOKEN` was documented
 * as unwise from day one: unlike the Google client id (origin-allowlisted)
 * and the publishable key (RLS), a PSA bearer token has no backstop — anyone
 * can read it out of the static bundle and spend the account's ~100 calls a
 * day. This function is the fix that module promised: point
 * `VITE_PSA_ENDPOINT` here and the token lives in `PSA_TOKEN` (a Supabase
 * secret) instead of in JavaScript handed to every visitor. It also settles
 * the other standing worry — PSA never documented CORS for browser origins;
 * this function answers with explicit CORS headers, so the lookup stops
 * depending on PSA's.
 *
 * Contract — exactly what `psa.ts` sends once its endpoint is overridden
 * (`GET {endpoint}/{cert}`, no headers at all):
 *
 *   GET /psa-proxy/{cert}   cert = bare digits, bounded (logic.ts)
 *   200  PSA's own JSON body, forwarded — the client's `normalizePsaCert`
 *        keeps doing the reading; this proxy adds no shape of its own
 *   400  cert missing or not bare digits
 *   405  not a GET
 *   429  forwarded from PSA, so the client's quota stand-down engages
 *   4xx/5xx  other PSA refusals forwarded by status — 401/403 mean OUR token
 *        is bad, which `psa.ts` already words as ours-not-theirs
 *   502  PSA unreachable, or answered 200 with a body that is not JSON
 *   503  not configured (no `PSA_TOKEN` secret) — the dormant shape every
 *        optional integration here ships in
 *
 * ## Deliberately callable without an account
 *
 * Slab scanning is part of the signed-out free path, so this is anonymous for
 * the same reasons `ebay-comps` is: a JWT gate would make resolving a cert an
 * account feature, and which cert someone scanned is not a fact worth tying
 * to a user id (decision 20's rule). It is called KEYLESS — not even the
 * publishable key — because `psa.ts`'s endpoint override is host-agnostic
 * (the same code must still reach PSA directly when no proxy is configured)
 * and a bare GET with no headers stays a CORS simple request.
 *
 * The cost of that openness is the one the bundle already paid, minus the
 * credential: anyone with the URL can spend the shared PSA quota, but nobody
 * can take the token itself any more. What bounds the damage: the cert is
 * validated to bare digits (nothing arbitrary rides upstream under our
 * bearer), answers are cached here and for months on the device, and a PSA
 * 429 is forwarded honestly so every client stands down for hours instead of
 * hammering a dead quota.
 */

import { certFound, certFromPath } from './logic.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const PSA_TOKEN = Deno.env.get('PSA_TOKEN') ?? ''

/** PSA's endpoint — the same constant `psa.ts` defaults to when no proxy is set. */
const UPSTREAM = 'https://api.psacard.com/publicapi/cert/GetByCertNumber'

/**
 * How long an answer is reused.
 *
 * A found cert is immutable — PSA does not regrade a cert number, it issues a
 * new one — so the only real bound on the long TTL is the isolate's own
 * lifetime. An EMPTY answer ages differently: certs are minted every day, so
 * "no record" is allowed to go stale within the hour rather than freezing a
 * freshly graded slab out for a month. The device cache (`psa.ts`,
 * `CERT_TTL_MS`) is about one collector re-scanning their own slab; this one
 * is about the same popular cert arriving from many collectors — either way
 * a hit spends none of the shared daily quota.
 */
const FOUND_TTL_MS = 30 * 86_400_000
const EMPTY_TTL_MS = 60 * 60_000

const cache = new Map<string, { at: number; ttl: number; body: string }>()

/** Bounded so a stream of distinct certs cannot grow the isolate forever. */
const CACHE_MAX = 1_000

function remember(cert: string, ttl: number, body: string): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(cert, { at: Date.now(), ttl, body })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405)
  if (!PSA_TOKEN) return json({ error: 'not configured' }, 503)

  const cert = certFromPath(new URL(req.url).pathname)
  if (!cert) return json({ error: 'bad cert' }, 400)

  const hit = cache.get(cert)
  if (hit && Date.now() - hit.at < hit.ttl) {
    return new Response(hit.body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // The client gives up at 10s (`psa.ts` timeoutMs) — a hung upstream must
  // not hold the isolate past the point anyone is still listening.
  const res = await fetch(`${UPSTREAM}/${cert}`, {
    headers: { Authorization: `bearer ${PSA_TOKEN}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(9_500),
  }).catch(() => null)
  if (!res) return json({ error: 'psa unreachable' }, 502)

  if (res.status === 429) {
    // Forwarded, never absorbed: the quota is one shared allowance, and the
    // client's six-hour stand-down only engages if it sees the 429.
    const retry = res.headers.get('Retry-After')
    return new Response(JSON.stringify({ error: 'psa rate limited' }), {
      status: 429,
      headers: { ...CORS, 'Content-Type': 'application/json', ...(retry ? { 'Retry-After': retry } : {}) },
    })
  }

  if (!res.ok) {
    // Status forwarded so `psa.ts`'s outcome mapping keeps working; the body
    // is ours because PSA's error pages are not a contract worth relaying.
    // Anything non-ok below 400 (a 304 cannot even carry a body) is not a
    // refusal we can pass along faithfully — call it a bad gateway.
    return json({ error: 'psa refused', status: res.status }, res.status >= 400 ? res.status : 502)
  }

  const payload = await res.json().catch(() => null)
  if (payload == null) return json({ error: 'psa answered unreadably' }, 502)

  const body = JSON.stringify(payload)
  remember(cert, certFound(payload) ? FOUND_TTL_MS : EMPTY_TTL_MS, body)
  return new Response(body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
})
