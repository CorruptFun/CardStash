/**
 * stripe-escrow — everything that talks to Stripe, and nothing that decides
 * whether a state change is allowed.
 *
 * THE INTERFACE IS THE TABLE, as with `square-billing`: `orders` and
 * `seller_accounts` are what the app reads, and migration 0006's functions are
 * what guard them. This file is allowed to be the only place in the repo that
 * understands Stripe. Nothing in `src/` imports a Stripe concept, and swapping
 * provider later means writing a sibling of this file.
 *
 * The two payment providers do not meet. `square-billing` sells subscriptions
 * and writes `entitlements`; this sells cards between users and writes
 * `orders`. They share no code and no table on purpose.
 *
 * WHY ONE FUNCTION WITH ROUTES. `verify_jwt` is a per-function setting, and the
 * webhook is unauthenticated by definition — Stripe has no JWT. So the function
 * is deployed with `verify_jwt = false` and verifies callers ITSELF, which is
 * the `scan-card` pattern: user routes ask GoTrue who the bearer is, and the
 * webhook route trusts nothing but a valid signature.
 *
 * Contract — POST /functions/v1/stripe-escrow/<route>
 *
 *   /onboard   auth  {}                        -> { url }        Connect onboarding
 *   /account   auth  {}                        -> { ready, payoutsEnabled }
 *   /checkout  auth  { sellerId, cardId, cardName, qty, itemCents, shippingCents }
 *                                              -> { url, orderId }
 *   /address   auth  { orderId }               -> { shipping }   SELLER only
 *   /confirm   auth  { orderId }               -> { status }     BUYER only; releases
 *   /webhook   sig   <stripe event>            -> { ok }
 *
 *   200 ok        401 not signed in / bad signature      403 not your order
 *   400 bad request      503 not configured / upstream failed
 *
 * WHY THE WEBHOOK ALWAYS 200s ONCE VERIFIED: Stripe retries any non-2xx for
 * days and eventually disables the endpoint. An event we do not act on is
 * handled correctly by ignoring it, so it gets a 200. Only a signature failure
 * is a 401, because that one is not Stripe talking.
 */

import {
  eventIntent,
  isUuid,
  splitFor,
  verifyStripeSignature,
} from './logic.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''

/**
 * Every signing secret this endpoint should accept, comma-separated.
 *
 * A Connect platform needs TWO Stripe endpoints — one scoped to "your account"
 * for the checkout and charge events, one scoped to "connected accounts" for
 * `account.updated` — and each gets its own secret. Both can point at this URL.
 * Accepting a list also covers a rotation window for free.
 */
const WEBHOOK_SECRETS = (Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const STRIPE_API = Deno.env.get('STRIPE_API_BASE') ?? 'https://api.stripe.com'

/**
 * THE OFF SWITCH THAT ACTUALLY COUNTS. Buying and selling are dark unless this
 * is explicitly `on`.
 *
 * The client has a `VITE_MARKETPLACE` flag too, but that one only hides
 * buttons, and a constant in a static bundle is one devtools tab from being
 * true (decision 2a). This is the half that stops a real card being charged:
 * with it off, no order can be opened, no Connect account created and no
 * payout released, however the request was constructed.
 *
 * WHAT STAYS LIVE WHEN IT IS OFF: the webhook and the sweep. That is deliberate
 * and is what makes this a kill switch rather than a trapdoor — turning the
 * marketplace off stops NEW business while letting business already in flight
 * settle. An order that is paid for when the switch flips must still be
 * shippable, confirmable and refundable; stranding someone's money because a
 * flag changed would be the worst possible reading of "off".
 */
const MARKETPLACE_ON = (Deno.env.get('MARKETPLACE_ENABLED') ?? '') === 'on'

/**
 * Routes that CREATE new commitments. Everything else -- reading an address,
 * marking shipped, confirming, the webhook -- keeps working so an in-flight
 * order can reach its end.
 */
const OPENS_NEW_BUSINESS = new Set(['onboard', 'checkout'])

/** Where Stripe sends people back to. Origin only — routes are hash-based. */
const APP_URL = (Deno.env.get('APP_URL') ?? 'https://cardstock.corrupt.solutions').replace(/\/+$/, '')

/**
 * Pinned, so Stripe's own dashboard upgrade cannot change response shapes under
 * a running deployment. Move it deliberately, with the changelog open.
 */
const STRIPE_VERSION = '2025-08-27.basil'

/** Only US for now: Connect onboarding, tax and postage all differ elsewhere. */
const SHIP_TO = ['US']

// ---------------------------------------------------------------- Stripe I/O

/**
 * Stripe takes form-encoded bodies with bracketed paths for nesting —
 * `line_items[0][price_data][unit_amount]=2000` — not JSON. Flattening here
 * rather than hand-writing those strings is the difference between a typo being
 * a type error and a typo being a silently ignored parameter, which with
 * `transfer_group` would mean money that cannot be traced back to its order.
 */
function form(data: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue
    const path = prefix ? `${prefix}[${key}]` : key
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item != null && typeof item === 'object') form(item as Record<string, unknown>, `${path}[${i}]`, out)
        else out.append(`${path}[${i}]`, String(item))
      })
    } else if (typeof value === 'object') {
      form(value as Record<string, unknown>, path, out)
    } else {
      out.append(path, String(value))
    }
  }
  return out
}

async function stripe(
  path: string,
  init: { method?: string; body?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<{ ok: boolean; status: number; body: any }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_KEY}`,
    'Stripe-Version': STRIPE_VERSION,
  }
  if (init.body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  // Every call that CREATES money movement carries one. A retried transfer
  // without an idempotency key pays a seller twice, and Stripe will happily do
  // it — the request is valid, it is just the second copy of one.
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey

  const res = await fetch(`${STRIPE_API}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers,
    body: init.body ? form(init.body).toString() : undefined,
  }).catch(() => null)

  if (!res) return { ok: false, status: 0, body: null }
  const body = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, body }
}

// -------------------------------------------------------------- Supabase I/O

const svc = (extra: Record<string, string> = {}) => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
})

async function rpc(fn: string, args: Record<string, unknown>): Promise<{ ok: boolean; body: any }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: svc(),
    body: JSON.stringify(args),
  }).catch(() => null)
  if (!res) return { ok: false, body: null }
  const body = await res.json().catch(() => null)
  return { ok: res.ok, body: Array.isArray(body) ? body[0] : body }
}

async function selectOne(path: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: svc() }).catch(() => null)
  if (!res?.ok) return null
  const rows = await res.json().catch(() => null)
  return Array.isArray(rows) ? (rows[0] ?? null) : null
}

async function upsert(table: string, onConflict: string, row: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: svc({ Prefer: 'resolution=merge-duplicates' }),
    body: JSON.stringify(row),
  }).catch(() => null)
  return !!res?.ok
}

/**
 * Who is calling, from their own JWT, verified by asking GoTrue rather than by
 * decoding it here — a locally-parsed token is a token nobody checked the
 * signature of. Same as `scan-card`.
 */
async function caller(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return null
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: SERVICE_KEY },
  }).catch(() => null)
  if (!who?.ok) return null
  const user = await who.json().catch(() => null)
  return isUuid(user?.id) ? String(user.id) : null
}

// ------------------------------------------------------------------- release
/**
 * Move the money. The one place it happens.
 *
 * `source_transaction` is the charge, which makes the transfer succeed
 * regardless of the platform's available balance and settle when the charge's
 * own funds do. It cannot be set after creation, so getting it here is the only
 * chance. Without it, a release attempted before Stripe has settled the payment
 * simply fails with insufficient funds — on a real order, days after the buyer
 * has already confirmed.
 *
 * The order is advanced to 'released' only AFTER Stripe confirms the transfer.
 * A row that said 'released' before the transfer existed would be a lie needing
 * hand reconciliation later.
 */
async function releaseOrder(order: any): Promise<{ ok: boolean; error?: string }> {
  if (order.status !== 'delivered') return { ok: false, error: 'not_deliverable' }

  const seller = await selectOne(
    `seller_accounts?user_id=eq.${order.seller}&select=stripe_account_id,payouts_enabled`,
  )
  if (!seller?.stripe_account_id || !seller.payouts_enabled) return { ok: false, error: 'seller_not_ready' }

  // The charge behind the payment. `latest_charge` is what a transfer's
  // source_transaction wants; the PaymentIntent id will not do.
  let chargeId = order.charge_id
  if (!chargeId && order.payment_intent_id) {
    const pi = await stripe(`/v1/payment_intents/${order.payment_intent_id}`)
    chargeId = pi.ok ? (pi.body?.latest_charge ?? null) : null
  }
  if (!chargeId) return { ok: false, error: 'no_charge' }

  const amount = order.item_cents + order.shipping_cents - order.fee_cents
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'bad_amount' }

  const transfer = await stripe('/v1/transfers', {
    body: {
      amount,
      currency: order.currency ?? 'usd',
      destination: seller.stripe_account_id,
      transfer_group: order.id,
      source_transaction: chargeId,
      metadata: { order_id: order.id },
    },
    // Keyed on the order, so a retried release is the same transfer, not a
    // second payout.
    idempotencyKey: `release:${order.id}`,
  })
  if (!transfer.ok) return { ok: false, error: `transfer_failed:${transfer.body?.error?.code ?? transfer.status}` }

  const advanced = await rpc('advance_order', {
    p_order: order.id,
    p_to: 'released',
    p_stripe: { transfer_id: transfer.body?.id, charge_id: chargeId },
  })
  if (!advanced.ok) return { ok: false, error: 'advance_failed' }
  return { ok: true }
}

// -------------------------------------------------------------------- routes

async function onboard(userId: string): Promise<Response> {
  let account = await selectOne(`seller_accounts?user_id=eq.${userId}&select=stripe_account_id`)

  if (!account?.stripe_account_id) {
    // Controller properties rather than `type: 'express'`. Same behaviour,
    // and it is the configuration Stripe documents for new platforms:
    //   losses.payments=application   we carry disputes and negative balances
    //   fees.payer=application        we pay Stripe's cut, not the seller
    //   stripe_dashboard.type=express the seller gets a light dashboard
    //   requirement_collection        defaults to `stripe`, so Stripe runs KYC
    //                                 and issues the 1099-K; we never handle
    //                                 a government ID.
    const created = await stripe('/v1/accounts', {
      body: {
        controller: {
          stripe_dashboard: { type: 'express' },
          fees: { payer: 'application' },
          losses: { payments: 'application' },
        },
        // Required for separate charges and transfers: without it a Transfer
        // to this account is refused.
        capabilities: { transfers: { requested: true } },
        country: 'US',
        metadata: { user_id: userId },
      },
      idempotencyKey: `acct:${userId}`,
    })
    if (!created.ok) return json({ error: 'stripe_account_failed', detail: created.body?.error?.message }, 503)

    // Recorded BEFORE onboarding, deliberately: the account exists at Stripe
    // from this moment, and a row written only on successful return would
    // orphan it if the user closed the tab, then create a second one next time.
    const saved = await upsert('seller_accounts', 'user_id', {
      user_id: userId,
      stripe_account_id: created.body.id,
      payouts_enabled: false,
      charges_enabled: false,
      updated_at: new Date().toISOString(),
    })
    if (!saved) return json({ error: 'write_failed' }, 503)
    account = { stripe_account_id: created.body.id }
  }

  const link = await stripe('/v1/account_links', {
    body: {
      account: account.stripe_account_id,
      type: 'account_onboarding',
      // Single-use and short-lived; `refresh_url` is where Stripe sends someone
      // whose link expired mid-flow, so it has to start a fresh one.
      refresh_url: `${APP_URL}/#/friends?onboard=retry`,
      return_url: `${APP_URL}/#/friends?onboard=done`,
    },
  })
  if (!link.ok) return json({ error: 'stripe_link_failed', detail: link.body?.error?.message }, 503)
  return json({ url: link.body.url })
}

async function checkout(userId: string, body: any): Promise<Response> {
  const sellerId = String(body?.sellerId ?? '')
  if (!isUuid(sellerId) || sellerId === userId) return json({ error: 'bad_seller' }, 400)

  const qty = Number(body?.qty ?? 1)
  const itemCents = Number(body?.itemCents)
  const shippingCents = Number(body?.shippingCents ?? 0)
  const cardId = String(body?.cardId ?? '').slice(0, 160)
  const cardName = String(body?.cardName ?? '').slice(0, 200)
  if (!cardId || !cardName) return json({ error: 'bad_card' }, 400)
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) return json({ error: 'bad_quantity' }, 400)

  // The split is computed HERE, from the seller's asking price, never taken
  // from the client. `open_order` re-checks the floor and the fee independently,
  // so a bug in this file cannot open an order the database disagrees with.
  const split = splitFor(itemCents, shippingCents)
  if (!split) return json({ error: 'below_minimum' }, 400)

  const opened = await rpc('open_order', {
    p_buyer: userId,
    p_seller: sellerId,
    p_card_id: cardId,
    p_card_name: cardName,
    p_qty: qty,
    p_item_cents: itemCents,
    p_shipping_cents: shippingCents,
    p_fee_cents: split.feeCents,
  })
  if (!opened.ok || !opened.body?.id) {
    // The SQL raises short machine codes; the client maps them to copy.
    return json({ error: opened.body?.message ?? 'open_failed' }, 400)
  }
  const orderId = opened.body.id

  const session = await stripe('/v1/checkout/sessions', {
    body: {
      mode: 'payment',
      // The address is collected by Stripe and STAYS at Stripe. We never store
      // one — the seller fetches it through /address when they need to post the
      // card. See migration 0006's header.
      shipping_address_collection: { allowed_countries: SHIP_TO },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: split.totalCents,
            product_data: { name: `${cardName}${qty > 1 ? ` x${qty}` : ''}` },
          },
        },
      ],
      payment_intent_data: {
        // Ties the eventual Transfer to this charge. Set now because it cannot
        // be added to a PaymentIntent afterwards.
        transfer_group: orderId,
        metadata: { order_id: orderId },
      },
      // On the session AND on the payment intent: webhooks for the two objects
      // carry different metadata, and `charge.refunded` reads the charge's.
      metadata: { order_id: orderId },
      success_url: `${APP_URL}/#/orders/${orderId}?paid=1`,
      cancel_url: `${APP_URL}/#/orders/${orderId}?cancelled=1`,
    },
    idempotencyKey: `checkout:${orderId}`,
  })
  if (!session.ok) return json({ error: 'stripe_checkout_failed', detail: session.body?.error?.message }, 503)

  return json({ url: session.body.url, orderId })
}

/**
 * The buyer's shipping address, for the seller, at the moment they need it.
 *
 * Fetched from Stripe on every call and never cached, so there is no address
 * column to leak, no retention policy to get wrong, and nothing for a backup or
 * an export to pick up.
 */
async function address(userId: string, body: any): Promise<Response> {
  const orderId = String(body?.orderId ?? '')
  if (!isUuid(orderId)) return json({ error: 'bad_order' }, 400)

  const order = await selectOne(`orders?id=eq.${orderId}&select=seller,status,checkout_session_id`)
  if (!order) return json({ error: 'no_such_order' }, 404)
  // The SELLER only, and only while there is something to post. A delivered or
  // released order does not need the address again, and a buyer never needs it.
  if (order.seller !== userId) return json({ error: 'not_your_order' }, 403)
  if (order.status !== 'paid' && order.status !== 'shipped') return json({ error: 'not_shippable' }, 403)
  if (!order.checkout_session_id) return json({ error: 'no_session' }, 404)

  const session = await stripe(`/v1/checkout/sessions/${order.checkout_session_id}`)
  if (!session.ok) return json({ error: 'stripe_lookup_failed' }, 503)

  const shipping = session.body?.collected_information?.shipping_details ?? session.body?.shipping_details ?? null
  if (!shipping) return json({ error: 'no_address' }, 404)
  return json({ shipping })
}

/** The buyer confirms receipt, which both records delivery and pays the seller. */
async function confirm(userId: string, body: any, req: Request): Promise<Response> {
  const orderId = String(body?.orderId ?? '')
  if (!isUuid(orderId)) return json({ error: 'bad_order' }, 400)

  // Called as the USER, so `confirm_receipt` can check auth.uid() = buyer
  // itself rather than this file being trusted to have checked.
  const asUser = await fetch(`${SUPABASE_URL}/rest/v1/rpc/confirm_receipt`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: req.headers.get('Authorization') ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_order: orderId }),
  }).catch(() => null)
  if (!asUser?.ok) {
    const err = await asUser?.json().catch(() => null)
    return json({ error: err?.message ?? 'confirm_failed' }, asUser?.status === 404 ? 404 : 403)
  }

  const order = await selectOne(`orders?id=eq.${orderId}&select=*`)
  if (!order) return json({ error: 'no_such_order' }, 404)

  const released = await releaseOrder(order)
  // Delivery is recorded either way. A transfer that fails here is retried by
  // the sweep rather than rolled back — the buyer said it arrived, and that
  // fact does not become untrue because a payout is slow.
  return json({ status: released.ok ? 'released' : 'delivered', payout: released.ok ? 'sent' : released.error })
}

async function webhook(req: Request, raw: string): Promise<Response> {
  const signature = req.headers.get('stripe-signature') ?? ''
  if (!(await verifyStripeSignature(raw, signature, WEBHOOK_SECRETS))) {
    return json({ error: 'bad signature' }, 401)
  }

  let event: unknown = null
  try {
    event = JSON.parse(raw)
  } catch {
    return json({ ok: true, ignored: 'unparseable' })
  }

  const intent = eventIntent(event)
  if (!intent) return json({ ok: true, ignored: String((event as any)?.type ?? 'unknown') })

  switch (intent.kind) {
    case 'paid': {
      const advanced = await rpc('advance_order', {
        p_order: intent.orderId,
        p_to: 'paid',
        p_stripe: { checkout_session_id: intent.sessionId, payment_intent_id: intent.paymentIntentId },
      })
      // A failed write is the one case worth a non-2xx: Stripe retries, and a
      // dropped `paid` is a buyer who was charged for an order still showing as
      // pending. `advance_order` is idempotent, so the retry is safe.
      if (!advanced.ok) return json({ error: 'write failed' }, 503)
      return json({ ok: true, order: intent.orderId, status: 'paid' })
    }

    case 'cancelled':
    case 'refunded': {
      const to = intent.kind === 'cancelled' ? 'cancelled' : 'refunded'
      const advanced = await rpc('advance_order', { p_order: intent.orderId, p_to: to })
      // An illegal transition here is not a retryable failure — it means the
      // order had already moved on. Log it by returning it, and 200 so Stripe
      // stops asking.
      return json({ ok: true, order: intent.orderId, status: advanced.ok ? to : 'unchanged' })
    }

    case 'account': {
      // Find the row by the account id WE recorded at onboarding. The event
      // also carries `metadata.user_id`, and using that instead would let
      // anyone who can create a Stripe account with the right metadata flip
      // somebody else's seller row — the same mistake `square-billing` avoids
      // by joining on `reference_id` rather than on a billing email.
      const row = await selectOne(`seller_accounts?stripe_account_id=eq.${intent.accountId}&select=user_id`)
      // An account we have no row for is not ours to act on — a platform can
      // receive events for accounts created by other means. Nothing to update,
      // so nothing failed.
      if (!row?.user_id) return json({ ok: true, ignored: 'unknown account' })

      const patched = await fetch(
        `${SUPABASE_URL}/rest/v1/seller_accounts?user_id=eq.${row.user_id}`,
        {
          method: 'PATCH',
          headers: svc(),
          body: JSON.stringify({
            payouts_enabled: intent.payoutsEnabled,
            charges_enabled: intent.chargesEnabled,
            updated_at: new Date().toISOString(),
          }),
        },
      ).catch(() => null)
      if (!patched?.ok) return json({ error: 'write failed' }, 503)
      return json({ ok: true, account: intent.accountId, ready: intent.payoutsEnabled })
    }

    case 'chargeback': {
      // Deliberately no state change — see logic.ts. Surfaced in the function
      // logs so a human sees it; the money has already left Stripe's control by
      // the time a network dispute lands.
      console.error(`CHARGEBACK order=${intent.orderId ?? 'unknown'}`)
      return json({ ok: true, chargeback: true })
    }
  }
}

// -------------------------------------------------------------------- server

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!STRIPE_KEY || !WEBHOOK_SECRETS.length) return json({ error: 'not configured' }, 503)

  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? ''

  // Read the body as TEXT once. The webhook must hash exactly the bytes Stripe
  // signed — a re-serialized object would have to reproduce key order and
  // whitespace to hash the same — so parsing cannot come first.
  const raw = await req.text()

  if (route === 'webhook') return webhook(req, raw)

  const userId = await caller(req)
  if (!userId) return json({ error: 'sign in required' }, 401)

  let body: any = {}
  if (raw) {
    try {
      body = JSON.parse(raw)
    } catch {
      return json({ error: 'bad request' }, 400)
    }
  }

  if (!MARKETPLACE_ON && OPENS_NEW_BUSINESS.has(route)) {
    return json({ error: 'marketplace_off' }, 503)
  }

  switch (route) {
    case 'onboard':
      return onboard(userId)
    case 'account': {
      const row = await selectOne(`seller_accounts?user_id=eq.${userId}&select=payouts_enabled,charges_enabled`)
      return json({ ready: row?.payouts_enabled === true, payoutsEnabled: row?.payouts_enabled === true })
    }
    case 'checkout':
      return checkout(userId, body)
    case 'address':
      return address(userId, body)
    case 'confirm':
      return confirm(userId, body, req)
    default:
      return json({ error: 'no such route' }, 404)
  }
})
