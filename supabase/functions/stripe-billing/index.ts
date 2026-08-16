/**
 * stripe-billing — the subscription, on Stripe. Replaces `square-billing`.
 *
 * THE INTERFACE IS STILL THE TABLE. `scan-card` and `build-deck` ask
 * `consume_scan_credit()` / `consume_build_credit()` whether the caller may go
 * ahead; those read `entitlements` and know nothing about Stripe, Square,
 * invoices or money. So this file is a SIBLING of `square-billing/index.ts`,
 * not a rewrite of anything, and swapping provider changed no code in `src/`
 * at all. That separation was designed for exactly this day and it paid.
 *
 * Two routes, and the split matters:
 *
 *   POST /checkout   auth  {}            -> { url }   start or manage a sub
 *   POST /webhook    signed by Stripe    -> 200       lifecycle events
 *
 * `/checkout` is the ONLY place a `user_id` is attached to a Stripe object. It
 * writes `metadata.user_id` (and `client_reference_id`) from the VERIFIED
 * session, so the webhook can join on something we set rather than on a billing
 * email — an attacker-chosen field, and the mistake CLAUDE.md already warns
 * about for Square.
 *
 * WHAT IT GRANTS. One subscription buys both paid features: `cloud-scan` and
 * `ai-builder`. They are separate rows because `entitlements` is keyed
 * (user_id, feature) and metered separately, but they rise and fall together.
 * Adding a third paid feature means adding it to FEATURES and nothing else.
 *
 * 200 ON EVENTS WE IGNORE, like the Square version: Stripe retries non-2xx for
 * days and disables an endpoint that keeps failing. Ignoring an event we do not
 * care about IS handling it correctly. Only a bad signature is a 401.
 *
 * Dormant without `STRIPE_SECRET_KEY` / `STRIPE_BILLING_WEBHOOK_SECRET`,
 * exactly as `stripe-escrow` and `square-billing` are without theirs.
 */

import { entitlementWindow, isUserId, subscriptionFromEvent, verifyStripeSignature } from './logic.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

/**
 * Days of slack past the paid period before a subscriber stops being one. A
 * renewal webhook can land late and a card can be retried for a day; being
 * stingy here means a paying user whose scanner quietly stops, which is far
 * worse than a few free days. Lapsing IS the cancellation mechanism (0005) —
 * nothing writes a "cancelled" state, the row just stops being in the future.
 */
const GRACE_DAYS = Number(Deno.env.get('STRIPE_GRACE_DAYS') ?? '3')

/** Everything one subscription buys. Matches PaidFeature in src/lib/entitlement.ts. */
const FEATURES = ['cloud-scan', 'ai-builder'] as const

const PRICE_ID = Deno.env.get('STRIPE_PRICE_ID') ?? ''
/** $6.99 once, lifetime. Empty = the offer is off and referred users buy yearly. */
const FOUNDING_PRICE_ID = Deno.env.get('STRIPE_FOUNDING_PRICE_ID') ?? ''
/** $9.99/year for someone referred after the hundred seats went. Falls back to
 *  the standard price when unset, so a half-configured deployment overcharges
 *  nobody by accident — it simply fails to discount. */
const REFERRED_PRICE_ID = Deno.env.get('STRIPE_REFERRED_PRICE_ID') ?? ''
const RETURN_URL = Deno.env.get('STRIPE_BILLING_RETURN_URL') ?? 'https://cardstock.corrupt.solutions/'

async function stripe(path: string, key: string, form: Record<string, string>): Promise<Response | null> {
  return fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  }).catch(() => null)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY')
  // Comma-separated, like stripe-escrow: one signing secret per endpoint, and a
  // single-secret verifier silently 401s every delivery from the other.
  const WEBHOOK_SECRETS = (Deno.env.get('STRIPE_BILLING_WEBHOOK_SECRET') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!STRIPE_KEY) return json({ error: 'not configured' }, 503)

  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? ''

  // ------------------------------------------------------------- /checkout
  if (route === 'checkout') {
    if (!PRICE_ID) return json({ error: 'not configured' }, 503)
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return json({ error: 'sign in required' }, 401)
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: SERVICE_KEY },
    }).catch(() => null)
    if (!who?.ok) return json({ error: 'sign in required' }, 401)
    const user = await who.json()
    if (!isUserId(user?.id)) return json({ error: 'sign in required' }, 401)

    // Already subscribed? Send them to the portal to manage it rather than
    // selling the same thing twice.
    const existing = await fetch(
      `${SUPABASE_URL}/rest/v1/entitlements?user_id=eq.${user.id}&feature=eq.cloud-scan&select=expires_at,source`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    ).catch(() => null)
    const rows = existing?.ok ? await existing.json().catch(() => []) : []
    const live = Array.isArray(rows) && rows[0]?.expires_at && Date.parse(rows[0].expires_at) > Date.now()

    if (live && rows[0]?.source === 'stripe') {
      const customers = await fetch(
        `https://api.stripe.com/v1/customers/search?query=${encodeURIComponent(`metadata['user_id']:'${user.id}'`)}`,
        { headers: { Authorization: `Bearer ${STRIPE_KEY}` } },
      ).catch(() => null)
      const found = customers?.ok ? await customers.json().catch(() => null) : null
      const customerId = found?.data?.[0]?.id
      if (customerId) {
        const portal = await stripe('billing_portal/sessions', STRIPE_KEY, {
          customer: customerId,
          return_url: RETURN_URL,
        })
        const session = portal?.ok ? await portal.json().catch(() => null) : null
        if (session?.url) return json({ url: session.url, managing: true })
      }
    }

    // WHICH OF THE THREE PRICES. The SQL decides — it reads `auth.uid()`, so a
    // client cannot ask for a tier it has not earned, and the same functions
    // back the copy in Settings so the quote and the till agree.
    const tierRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/referral_tier`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: auth, 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => null)
    const tier = tierRes?.ok ? String(await tierRes.json().catch(() => 'standard')) : 'standard'

    // A seat is RESERVED here and only claimed when the money lands; an
    // abandoned checkout releases it when the reservation lapses (0014).
    let seat = 0
    if (tier === 'founding' && FOUNDING_PRICE_ID) {
      const reserve = await fetch(`${SUPABASE_URL}/rest/v1/rpc/reserve_founding_seat`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: auth, 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => null)
      if (reserve?.ok) seat = Number(await reserve.json().catch(() => 0)) || 0
    }

    // The recurring price this person gets. `referred` falls back to standard
    // when unconfigured — a missing discount is recoverable, a wrong charge is not.
    const recurringPrice = tier === 'referred' && REFERRED_PRICE_ID ? REFERRED_PRICE_ID : PRICE_ID
    const soldTier = tier === 'referred' && REFERRED_PRICE_ID ? 'referred' : 'standard'

    if (seat > 0) {
      const founding = await stripe('checkout/sessions', STRIPE_KEY, {
        // A one-off charge, NOT a subscription: this buys access outright.
        mode: 'payment',
        'line_items[0][price]': FOUNDING_PRICE_ID,
        'line_items[0][quantity]': '1',
        success_url: `${RETURN_URL}#/settings?subscribed=1`,
        cancel_url: `${RETURN_URL}#/settings`,
        client_reference_id: user.id,
        'metadata[user_id]': user.id,
        'metadata[founding_seat]': String(seat),
        ...(user.email ? { customer_email: String(user.email) } : {}),
      })
      if (!founding?.ok) return json({ error: 'could not start checkout' }, 502)
      const session = await founding.json().catch(() => null)
      if (typeof session?.url !== 'string') return json({ error: 'could not start checkout' }, 502)
      return json({ url: session.url, founding: true, seat })
    }

    const checkout = await stripe('checkout/sessions', STRIPE_KEY, {
      mode: 'subscription',
      'line_items[0][price]': recurringPrice,
      'line_items[0][quantity]': '1',
      success_url: `${RETURN_URL}#/settings?subscribed=1`,
      cancel_url: `${RETURN_URL}#/settings`,
      // THE JOIN KEY, set by us and by nothing else. Both fields, because a
      // checkout session exposes `client_reference_id` while the subscription
      // it creates carries `metadata` — the webhook reads whichever it gets.
      client_reference_id: user.id,
      'metadata[user_id]': user.id,
      // The tier travels with the subscription so the webhook can credit the
      // referrer without re-deriving which price was actually sold.
      'metadata[tier]': soldTier,
      'subscription_data[metadata][user_id]': user.id,
      'subscription_data[metadata][tier]': soldTier,
      ...(user.email ? { customer_email: String(user.email) } : {}),
    })
    if (!checkout?.ok) return json({ error: 'could not start checkout' }, 502)
    const session = await checkout.json().catch(() => null)
    if (typeof session?.url !== 'string') return json({ error: 'could not start checkout' }, 502)
    return json({ url: session.url })
  }

  // -------------------------------------------------------------- /webhook
  if (route === 'webhook') {
    if (!WEBHOOK_SECRETS.length) return json({ error: 'not configured' }, 503)
    // Read as TEXT and verify BEFORE parsing: verifying a re-serialized object
    // cannot work, and parsing first runs the parser on unverified input.
    const raw = await req.text()
    const signature = req.headers.get('stripe-signature') ?? ''
    if (!(await verifyStripeSignature(raw, signature, WEBHOOK_SECRETS))) {
      return json({ error: 'bad signature' }, 401)
    }

    let event: unknown = null
    try {
      event = JSON.parse(raw)
    } catch {
      return json({ error: 'bad json' }, 400)
    }

    const sub = subscriptionFromEvent(event)
    // Not an event we act on. 200 — see the header.
    if (!sub) return json({ ok: true, ignored: true })

    // A founding purchase is not a window at all: `expires_at = NULL` means no
    // expiry (0005), and the seat is claimed so an abandoned-then-completed
    // checkout cannot leave a paid customer without one.
    if (sub.founding) {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_founding_seat`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_user: sub.userId }),
      }).catch(() => null)

      const now = new Date().toISOString()
      const grant = await fetch(`${SUPABASE_URL}/rest/v1/entitlements?on_conflict=user_id,feature`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify(
          FEATURES.map((feature) => ({
            user_id: sub.userId,
            feature,
            expires_at: null,
            source: 'stripe-founding',
            updated_at: now,
          })),
        ),
      }).catch(() => null)
      if (!grant?.ok) return json({ error: 'write failed' }, 503)
      return json({ ok: true, founding: true, features: FEATURES })
    }

    const { active, expiresAt } = entitlementWindow(sub, GRACE_DAYS)

    // NEVER SHORTEN AN EXISTING GRANT. Stripe delivers out of order, so a late
    // `past_due` can arrive after the renewal that already paid for the next
    // month. Taking the LATER of the two means a straggler can only ever be a
    // no-op, and cancellation still works because nothing pushes the date and
    // it simply lapses.
    const current = await fetch(
      `${SUPABASE_URL}/rest/v1/entitlements?user_id=eq.${sub.userId}&feature=eq.cloud-scan&select=expires_at`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    ).catch(() => null)
    const held = current?.ok ? await current.json().catch(() => []) : []
    const heldUntil = Array.isArray(held) && held[0]?.expires_at ? Date.parse(held[0].expires_at) : 0
    const wanted = Date.parse(expiresAt)
    const finalExpiry = new Date(Math.max(heldUntil || 0, active ? wanted : 0) || wanted).toISOString()

    // CREDIT THE REFERRER, once, and only for a RECURRING subscription. A
    // founding purchase earns nothing — a one-off lifetime fee has no ongoing
    // revenue behind it to share, and paying a bounty out of it would be paying
    // from a pot that has to last decades. The SQL enforces the once-ever and
    // the cap; calling it more than one time is harmless.
    if (sub.tier === 'referred' || sub.tier === 'standard') {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_referral_reward`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_referred: sub.userId, p_tier: sub.tier }),
      }).catch(() => null)
    }

    const now = new Date().toISOString()
    const write = await fetch(`${SUPABASE_URL}/rest/v1/entitlements?on_conflict=user_id,feature`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(
        FEATURES.map((feature) => ({
          user_id: sub.userId,
          feature,
          expires_at: finalExpiry,
          source: 'stripe',
          updated_at: now,
        })),
      ),
    }).catch(() => null)
    // The one case worth failing: Stripe retries, and a dropped renewal is a
    // paying user locked out of what they paid for.
    if (!write?.ok) return json({ error: 'write failed' }, 503)

    return json({ ok: true, active, expires_at: finalExpiry, features: FEATURES })
  }

  return json({ error: 'no such route' }, 404)
})
