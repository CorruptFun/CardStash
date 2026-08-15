/**
 * The Stripe escrow function's decisions, held to by test.
 *
 * Stripe's test mode needs an account and a tunnel, and the two things most
 * worth being sure of need neither: that only Stripe can move an order, and
 * that the money splits the way we say it does. Both are pure functions in
 * logic.ts precisely so this file can exist.
 *
 * The signature vectors are computed with node's own HMAC rather than with the
 * function under test — a test that verifies a hash against itself proves only
 * that it is deterministic.
 *
 * What is NOT tested here is which state transitions are legal: that lives in
 * migration 0006 and is proven by tests/harness/escrow-rls.mjs against real
 * SQL. See logic.ts's header for why there is deliberately no second copy.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { bundleImport } from './bundle.mjs'

const {
  stripeSignature,
  safeEqual,
  parseSignatureHeader,
  verifyStripeSignature,
  isUuid,
  feeFor,
  splitFor,
  eventIntent,
  sweepAction,
  MIN_ORDER_CENTS,
  MIN_FEE_CENTS,
  AUTO_RELEASE_DAYS,
  AUTO_REFUND_DAYS,
} = await bundleImport('supabase/functions/stripe-escrow/logic.ts')

const SECRET = 'whsec_test_secret'
const ORDER = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

/** Node's HMAC, not the function under test. */
const independent = (payload) => createHmac('sha256', SECRET).update(payload).digest('hex')

const NOW_S = 1_700_000_000
const now = () => NOW_S * 1000

const signed = (body, t = NOW_S) => `t=${t},v1=${independent(`${t}.${body}`)}`

const session = (over = {}) => ({
  type: 'checkout.session.completed',
  data: {
    object: {
      id: 'cs_test_123',
      payment_status: 'paid',
      payment_intent: 'pi_test_123',
      metadata: { order_id: ORDER },
      ...over,
    },
  },
})

// --------------------------------------------------------------- signature

test('the signature is hex HMAC-SHA256 over timestamp.body', async () => {
  const body = '{"hello":"world"}'
  assert.equal(await stripeSignature(`${NOW_S}.${body}`, SECRET), independent(`${NOW_S}.${body}`))
})

test('a body altered by one byte does not verify', async () => {
  const body = '{"amount":500}'
  const header = signed(body)
  assert.equal(await verifyStripeSignature(body, header, SECRET, now), true)
  assert.equal(await verifyStripeSignature('{"amount":501}', header, SECRET, now), false)
})

test('the timestamp is part of the signed payload, so it cannot be edited', async () => {
  const body = '{"a":1}'
  const header = signed(body)
  // Same signature, timestamp moved forward: the hash no longer matches.
  const moved = header.replace(`t=${NOW_S}`, `t=${NOW_S + 1}`)
  assert.equal(await verifyStripeSignature(body, moved, SECRET, now), false)
})

test('a signature made with the wrong secret fails', async () => {
  const body = '{"a":1}'
  const wrong = `t=${NOW_S},v1=${createHmac('sha256', 'whsec_other').update(`${NOW_S}.${body}`).digest('hex')}`
  assert.equal(await verifyStripeSignature(body, wrong, SECRET, now), false)
})

test('an old signature is refused however valid it is — otherwise it replays forever', async () => {
  const body = '{"a":1}'
  const stale = NOW_S - 3600
  assert.equal(await verifyStripeSignature(body, signed(body, stale), SECRET, now), false)
  // Just inside the window still passes.
  const fresh = NOW_S - 299
  assert.equal(await verifyStripeSignature(body, signed(body, fresh), SECRET, now), true)
})

test('a clock skewed the other way is refused too', async () => {
  const body = '{"a":1}'
  assert.equal(await verifyStripeSignature(body, signed(body, NOW_S + 3600), SECRET, now), false)
})

test('any of several v1 signatures matching is enough, so secret rotation works', async () => {
  const body = '{"a":1}'
  const mine = independent(`${NOW_S}.${body}`)
  const other = createHmac('sha256', 'whsec_being_rotated_out').update(`${NOW_S}.${body}`).digest('hex')
  assert.equal(await verifyStripeSignature(body, `t=${NOW_S},v1=${other},v1=${mine}`, SECRET, now), true)
})

test('the header parser ignores schemes it does not know', () => {
  const parsed = parseSignatureHeader(`t=${NOW_S},v0=abc,v1=def`)
  assert.equal(parsed.timestamp, NOW_S)
  assert.deepEqual(parsed.signatures, ['def'])
})

test('a missing, empty or malformed header verifies nothing', async () => {
  const body = '{"a":1}'
  for (const header of ['', 'garbage', 't=,v1=', `v1=${independent(`${NOW_S}.${body}`)}`, `t=${NOW_S}`]) {
    assert.equal(await verifyStripeSignature(body, header, SECRET, now), false, `header: ${header}`)
  }
  // An empty body or absent secret is never a pass either.
  assert.equal(await verifyStripeSignature('', signed(''), SECRET, now), false)
  assert.equal(await verifyStripeSignature(body, signed(body), '', now), false)
})

test('safeEqual compares length first and matches identical strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
})

test('only a real uuid is accepted as an order id', () => {
  assert.equal(isUuid(ORDER), true)
  assert.equal(isUuid('not-an-order'), false)
  assert.equal(isUuid(''), false)
  assert.equal(isUuid(null), false)
  // Right length and character set, wrong shape — a looser check would pass it.
  assert.equal(isUuid('3f2504e04f8911d39a0c0305e82c3301aaaa'), false)
})

// -------------------------------------------------------------------- money

test('the fee is a percentage with a floor under it', () => {
  assert.equal(feeFor(10_000), 800) // $100 -> $8
  assert.equal(feeFor(2_000), 160) // $20 -> $1.60
  // 8% of $5 is 40c, which loses to Stripe's 44.5c. The floor is the whole
  // reason a cheap sale is not a donation.
  assert.equal(feeFor(500), MIN_FEE_CENTS)
  assert.equal(feeFor(1), MIN_FEE_CENTS)
  assert.equal(feeFor(0), MIN_FEE_CENTS)
})

test('the fee is charged on the item, never on postage', () => {
  const noPostage = splitFor(2_000, 0)
  const withPostage = splitFor(2_000, 500)
  assert.equal(noPostage.feeCents, withPostage.feeCents)
  // ...and the postage passes through to the seller untouched.
  assert.equal(withPostage.sellerCents - noPostage.sellerCents, 500)
})

test('a split adds back up to what the buyer was charged', () => {
  for (const [item, shipping] of [
    [500, 0],
    [2_000, 500],
    [9_999, 349],
    [100_000, 1_500],
  ]) {
    const split = splitFor(item, shipping)
    assert.equal(split.totalCents, item + shipping)
    assert.equal(split.feeCents + split.sellerCents, split.totalCents, `${item}/${shipping} must reconcile`)
    assert.ok(split.feeCents < split.totalCents, 'the seller must always receive something')
  }
})

test('a sale below the minimum is refused rather than quietly discounted', () => {
  assert.equal(splitFor(MIN_ORDER_CENTS - 1, 0), null)
  assert.equal(splitFor(100, 0), null)
  // Postage counts towards the minimum, because Stripe's cut is on the total.
  assert.notEqual(splitFor(100, 400), null)
})

test('a non-integer or negative amount is refused, never coerced', () => {
  assert.equal(splitFor(20.5, 0), null)
  assert.equal(splitFor(-2_000, 0), null)
  assert.equal(splitFor(2_000, -500), null)
  assert.equal(splitFor(Number.NaN, 0), null)
  assert.equal(splitFor(Number.POSITIVE_INFINITY, 0), null)
  assert.equal(splitFor('2000', 0), null)
})

// ------------------------------------------------------------------- events

test('a completed checkout is the only thing that marks an order paid', () => {
  assert.deepEqual(eventIntent(session()), {
    kind: 'paid',
    orderId: ORDER,
    sessionId: 'cs_test_123',
    paymentIntentId: 'pi_test_123',
  })
})

test('an unpaid session is ignored — asynchronous methods can still fail', () => {
  assert.equal(eventIntent(session({ payment_status: 'unpaid' })), null)
  assert.equal(eventIntent(session({ payment_status: 'no_payment_required' })), null)
})

test('an event with no valid order id is ignored rather than half-applied', () => {
  assert.equal(eventIntent(session({ metadata: {} })), null)
  assert.equal(eventIntent(session({ metadata: { order_id: 'lol' } })), null)
  assert.equal(eventIntent(session({ metadata: null })), null)
})

test('expiry and refund map to their own intents', () => {
  assert.deepEqual(
    eventIntent({ type: 'checkout.session.expired', data: { object: { metadata: { order_id: ORDER } } } }),
    { kind: 'cancelled', orderId: ORDER },
  )
  assert.deepEqual(eventIntent({ type: 'charge.refunded', data: { object: { metadata: { order_id: ORDER } } } }), {
    kind: 'refunded',
    orderId: ORDER,
  })
})

test('a chargeback is reported, never turned into a state change', () => {
  const intent = eventIntent({
    type: 'charge.dispute.created',
    data: { object: { metadata: { order_id: ORDER } } },
  })
  assert.equal(intent.kind, 'chargeback')
  assert.equal(intent.orderId, ORDER)
  // It still reports when the charge cannot be tied to an order, because a
  // chargeback nobody hears about is the worst version of this event.
  assert.deepEqual(eventIntent({ type: 'charge.dispute.created', data: { object: {} } }), {
    kind: 'chargeback',
    orderId: null,
  })
})

test('a seller is ready only when payouts AND the transfers capability are live', () => {
  const account = (over = {}) => ({
    type: 'account.updated',
    data: {
      object: {
        id: 'acct_123',
        payouts_enabled: true,
        charges_enabled: true,
        capabilities: { transfers: 'active' },
        ...over,
      },
    },
  })
  assert.equal(eventIntent(account()).payoutsEnabled, true)
  // Payout-capable but transfers still pending: a Transfer would be refused,
  // so this must not read as ready.
  assert.equal(eventIntent(account({ capabilities: { transfers: 'pending' } })).payoutsEnabled, false)
  assert.equal(eventIntent(account({ capabilities: {} })).payoutsEnabled, false)
  assert.equal(eventIntent(account({ payouts_enabled: false })).payoutsEnabled, false)
})

test('an account event for something that is not an account is ignored', () => {
  assert.equal(eventIntent({ type: 'account.updated', data: { object: { id: 'cus_123' } } }), null)
})

test('events we do not act on produce nothing at all', () => {
  for (const type of ['payment_intent.created', 'charge.succeeded', 'invoice.paid', 'transfer.created', '']) {
    assert.equal(eventIntent({ type, data: { object: {} } }), null, `${type} must be ignored`)
  }
  assert.equal(eventIntent(null), null)
  assert.equal(eventIntent({}), null)
})

// ------------------------------------------------------------------- timers

test('a shipped order releases itself once the buyer has had long enough', () => {
  const shippedAt = Date.UTC(2026, 0, 1)
  const day = 86_400_000
  assert.equal(sweepAction({ status: 'shipped', shippedAt, paidAt: null }, shippedAt + day), null)
  assert.equal(
    sweepAction({ status: 'shipped', shippedAt, paidAt: null }, shippedAt + AUTO_RELEASE_DAYS * day),
    'release',
  )
})

test('an order that was paid and never shipped refunds itself', () => {
  const paidAt = Date.UTC(2026, 0, 1)
  const day = 86_400_000
  assert.equal(sweepAction({ status: 'paid', shippedAt: null, paidAt }, paidAt + day), null)
  assert.equal(sweepAction({ status: 'paid', shippedAt: null, paidAt }, paidAt + AUTO_REFUND_DAYS * day), 'refund')
})

test('a dispute freezes the clock — a freeze that expires anyway is not a freeze', () => {
  const long = Date.UTC(2026, 0, 1)
  const later = long + 365 * 86_400_000
  assert.equal(sweepAction({ status: 'disputed', shippedAt: long, paidAt: long }, later), null)
})

test('terminal states are never swept, however old', () => {
  const long = Date.UTC(2020, 0, 1)
  const later = Date.now()
  for (const status of ['released', 'refunded', 'cancelled', 'delivered', 'pending']) {
    assert.equal(sweepAction({ status, shippedAt: long, paidAt: long }, later), null, `${status} must not be swept`)
  }
})

test('a missing timestamp never counts as expired', () => {
  const now2 = Date.now()
  assert.equal(sweepAction({ status: 'shipped', shippedAt: null, paidAt: null }, now2), null)
  assert.equal(sweepAction({ status: 'paid', shippedAt: null, paidAt: null }, now2), null)
})
