/**
 * stripe-escrow-sweep — the timers that stop an escrow from lasting forever.
 *
 * Two failures this exists for, both of which are silence rather than error:
 *
 *   * A buyer receives their card and never taps confirm. Without a timer the
 *     seller's money sits in our balance permanently. Auto-release 7 days after
 *     the seller marked it shipped.
 *   * A seller takes the money and never posts. Auto-refund 14 days after
 *     payment if it was never marked shipped.
 *
 * `disputed` is excluded from both, in `sweepAction()`. Raising a dispute
 * freezes the clock, and a freeze that quietly expires anyway is not a freeze.
 *
 * IDEMPOTENT AND TIMESTAMP-DRIVEN, because pg_cron does not retry a skipped
 * tick and will happily fire two at once. Nothing here asks "did this run
 * today"; every decision is a function of the row's own `shipped_at` /
 * `paid_at` and the clock, so running it twice in a second, or not at all for a
 * day, both converge on the same answer. `advance_order()` returning a no-op
 * for a state it is already in is the other half of that.
 *
 * Invoked by Supabase Cron over pg_net. It is NOT public: `verify_jwt` is off
 * for this function (a cron caller has no user JWT), so it checks a shared
 * secret itself. Without that, anyone who guessed the URL could force every
 * pending payout in the system to release early.
 *
 * Contract:
 *   POST  x-sweep-key: <SWEEP_SECRET>   -> 200 { released, refunded, failed }
 *   401 bad key      503 not configured
 */

import { AUTO_REFUND_DAYS, AUTO_RELEASE_DAYS, safeEqual, sweepAction } from '../stripe-escrow/logic.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const SWEEP_SECRET = Deno.env.get('SWEEP_SECRET') ?? ''
const STRIPE_API = Deno.env.get('STRIPE_API_BASE') ?? 'https://api.stripe.com'
const STRIPE_VERSION = '2025-08-27.basil'

/**
 * How many orders one tick will touch. A sweep that tried to clear a backlog of
 * thousands in one invocation would hit the function timeout half way through
 * and leave the rest for a tick that never knows it was interrupted — whereas a
 * bounded run simply picks the rest up next time, because nothing here depends
 * on having seen every row.
 */
const BATCH = 100

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const svc = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
})

async function rpc(fn: string, args: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: svc(),
    body: JSON.stringify(args),
  }).catch(() => null)
  return !!res?.ok
}

async function stripe(path: string, body: Record<string, string>, idempotencyKey: string) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      'Stripe-Version': STRIPE_VERSION,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey,
    },
    body: new URLSearchParams(body).toString(),
  }).catch(() => null)
  if (!res) return { ok: false, body: null as any }
  return { ok: res.ok, body: await res.json().catch(() => null) }
}

const ms = (t: string | null) => (t ? Date.parse(t) || null : null)

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!STRIPE_KEY || !SWEEP_SECRET) return json({ error: 'not configured' }, 503)

  const given = req.headers.get('x-sweep-key') ?? ''
  if (!given || !safeEqual(given, SWEEP_SECRET)) return json({ error: 'bad key' }, 401)

  // Only the two states a timer can act on, and only rows old enough to
  // possibly qualify. The precise decision is still sweepAction()'s -- this
  // just avoids dragging the whole table across the wire.
  const releaseBefore = new Date(Date.now() - AUTO_RELEASE_DAYS * 86_400_000).toISOString()
  const refundBefore = new Date(Date.now() - AUTO_REFUND_DAYS * 86_400_000).toISOString()
  const query =
    `orders?select=*&limit=${BATCH}&or=(` +
    `and(status.eq.shipped,shipped_at.lte.${releaseBefore}),` +
    `and(status.eq.paid,paid_at.lte.${refundBefore})` +
    `)`

  const listed = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, { headers: svc() }).catch(() => null)
  if (!listed?.ok) return json({ error: 'read failed' }, 503)
  const orders: any[] = (await listed.json().catch(() => null)) ?? []

  const now = Date.now()
  let released = 0
  let refunded = 0
  const failed: string[] = []

  for (const order of orders) {
    const action = sweepAction(
      { status: order.status, shippedAt: ms(order.shipped_at), paidAt: ms(order.paid_at) },
      now,
    )
    if (!action) continue

    if (action === 'release') {
      // The seller must still be payable. If Stripe has since restricted the
      // account, transferring would strand the money in a balance that cannot
      // pay out -- leave it for a human and keep the order where it is.
      const sellerRes = await fetch(
        `${SUPABASE_URL}/rest/v1/seller_accounts?user_id=eq.${order.seller}&select=stripe_account_id,payouts_enabled`,
        { headers: svc() },
      ).catch(() => null)
      const seller = sellerRes?.ok ? (await sellerRes.json().catch(() => []))[0] : null
      if (!seller?.stripe_account_id || !seller.payouts_enabled) {
        failed.push(`${order.id}:seller_not_ready`)
        continue
      }

      let chargeId = order.charge_id
      if (!chargeId && order.payment_intent_id) {
        const pi = await fetch(`${STRIPE_API}/v1/payment_intents/${order.payment_intent_id}`, {
          headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Stripe-Version': STRIPE_VERSION },
        }).catch(() => null)
        const piBody = pi?.ok ? await pi.json().catch(() => null) : null
        chargeId = piBody?.latest_charge ?? null
      }
      if (!chargeId) {
        failed.push(`${order.id}:no_charge`)
        continue
      }

      const amount = order.item_cents + order.shipping_cents - order.fee_cents
      if (!Number.isInteger(amount) || amount <= 0) {
        failed.push(`${order.id}:bad_amount`)
        continue
      }

      // Auto-release goes through `delivered` first, so the row never jumps a
      // state and the graph in advance_order() stays the only description of
      // what is legal. Delivery is what the timer is asserting, after all.
      if (!(await rpc('advance_order', { p_order: order.id, p_to: 'delivered' }))) {
        failed.push(`${order.id}:advance_delivered`)
        continue
      }

      const transfer = await stripe(
        '/v1/transfers',
        {
          amount: String(amount),
          currency: order.currency ?? 'usd',
          destination: seller.stripe_account_id,
          transfer_group: order.id,
          source_transaction: chargeId,
          'metadata[order_id]': order.id,
        },
        // The SAME key the /confirm route uses, so a buyer confirming at the
        // moment the sweep fires cannot pay the seller twice.
        `release:${order.id}`,
      )
      if (!transfer.ok) {
        failed.push(`${order.id}:transfer`)
        continue
      }

      if (
        await rpc('advance_order', {
          p_order: order.id,
          p_to: 'released',
          p_stripe: { transfer_id: transfer.body?.id, charge_id: chargeId },
        })
      ) {
        released++
      } else {
        // The money moved and the row did not. Loud, because it needs a human
        // and no retry will fix it -- the idempotency key means the next
        // attempt returns the same transfer rather than making a second one.
        console.error(`RELEASED BUT NOT RECORDED order=${order.id} transfer=${transfer.body?.id}`)
        failed.push(`${order.id}:advance_released`)
      }
      continue
    }

    // refund -- paid, never shipped
    if (!order.payment_intent_id) {
      failed.push(`${order.id}:no_payment_intent`)
      continue
    }
    const refund = await stripe(
      '/v1/refunds',
      { payment_intent: order.payment_intent_id, 'metadata[order_id]': order.id },
      `refund:${order.id}`,
    )
    if (!refund.ok) {
      failed.push(`${order.id}:refund`)
      continue
    }
    // The `charge.refunded` webhook will also advance this. Doing it here too
    // is deliberate belt and braces: advance_order() is idempotent, and an
    // order the buyer can see as refunded the moment we ask for it beats one
    // that looks stuck until a webhook lands.
    if (await rpc('advance_order', { p_order: order.id, p_to: 'refunded' })) refunded++
    else failed.push(`${order.id}:advance_refunded`)
  }

  if (failed.length) console.error(`sweep failures: ${failed.join(', ')}`)
  return json({ ok: true, scanned: orders.length, released, refunded, failed: failed.length })
})
