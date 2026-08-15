/**
 * The Stripe billing webhook's decisions, held to by test.
 *
 * Two things are worth being certain of and neither needs a network: that only
 * Stripe can grant an entitlement, and that a grant lasts exactly as long as
 * was paid for. Both are pure functions in logic.ts so this file can exist.
 *
 * Signature vectors are computed with node's own HMAC rather than with the
 * function under test — a test that checks a hash against itself proves only
 * that it is deterministic.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { bundleImport } from './bundle.mjs'

const { stripeSignature, safeEqual, isUserId, subscriptionFromEvent, entitlementWindow, verifyStripeSignature } =
  await bundleImport('supabase/functions/stripe-billing/logic.ts')

const SECRET = 'whsec_test_secret'
const USER = '965de644-a645-4a8f-bea0-ad094da49191'
const independent = (payload) => createHmac('sha256', SECRET).update(payload).digest('hex')

const header = (body, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`

const subEvent = (over = {}, type = 'customer.subscription.updated') => ({
  type,
  data: {
    object: {
      id: 'sub_123',
      status: 'active',
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      metadata: { user_id: USER },
      ...over,
    },
  },
})

/* ------------------------------------------------------------- signatures */

test('the signature matches an independent HMAC', async () => {
  const payload = '1700000000.{"a":1}'
  assert.equal(await stripeSignature(payload, SECRET), independent(payload))
})

test('a valid signature verifies; a forged one does not', async () => {
  const body = JSON.stringify(subEvent())
  assert.equal(await verifyStripeSignature(body, header(body), SECRET), true)
  assert.equal(await verifyStripeSignature(body, header(body, 'whsec_wrong'), SECRET), false)
})

test('an old signature is refused even though it is genuine', async () => {
  const body = JSON.stringify(subEvent())
  const stale = header(body, SECRET, Math.floor(Date.now() / 1000) - 3600)
  assert.equal(await verifyStripeSignature(body, stale, SECRET), false)
})

test('several secrets are accepted — one endpoint per destination', async () => {
  const body = JSON.stringify(subEvent())
  const signed = header(body, 'whsec_second')
  assert.equal(await verifyStripeSignature(body, signed, ['whsec_first', 'whsec_second']), true)
  assert.equal(await verifyStripeSignature(body, signed, ['whsec_first']), false)
})

test('safeEqual compares by value, not by reference or length shortcut', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'ab'), false)
})

/* ------------------------------------------------------------ who is this */

test('a user id is only accepted in uuid shape', () => {
  assert.equal(isUserId(USER), true)
  assert.equal(isUserId('not-a-uuid'), false)
  assert.equal(isUserId(''), false)
  assert.equal(isUserId(null), false)
})

test('AN EMAIL IS NEVER THE JOIN KEY — an event without our metadata is ignored', () => {
  // The attack this blocks: create a Stripe customer with someone's billing
  // address and be granted their subscription. Only metadata WE wrote counts.
  const noMeta = subEvent({ metadata: {}, customer_email: 'victim@example.com' })
  assert.equal(subscriptionFromEvent(noMeta), null)
})

test('client_reference_id is accepted, since a checkout session carries that', () => {
  const session = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', payment_status: 'paid', client_reference_id: USER, subscription: 'sub_9' } },
  }
  assert.equal(subscriptionFromEvent(session)?.userId, USER)
})

/* ---------------------------------------------------------- what it means */

test('an unpaid checkout grants nothing', () => {
  const unpaid = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', payment_status: 'unpaid', client_reference_id: USER } },
  }
  assert.equal(subscriptionFromEvent(unpaid), null)
})

test('a one-off payment is not a subscription', () => {
  const once = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_status: 'paid', client_reference_id: USER } },
  }
  assert.equal(subscriptionFromEvent(once), null)
})

test('a deleted subscription reports cancelled whatever the object claims', () => {
  const deleted = subEvent({ status: 'active' }, 'customer.subscription.deleted')
  assert.equal(subscriptionFromEvent(deleted).status, 'canceled')
})

test('an unrelated event type is ignored', () => {
  assert.equal(subscriptionFromEvent({ type: 'invoice.created', data: { object: { metadata: { user_id: USER } } } }), null)
})

/* --------------------------------------------------------- the entitlement */

test('active grants until the paid period plus grace', () => {
  const end = Math.floor(Date.now() / 1000) + 30 * 86400
  const { active, expiresAt } = entitlementWindow(
    { userId: USER, status: 'active', periodEnd: end, subscriptionId: 's' },
    3,
  )
  assert.equal(active, true)
  assert.equal(Date.parse(expiresAt), end * 1000 + 3 * 86_400_000)
})

test('trialing entitles — a trial is access that was agreed to', () => {
  const end = Math.floor(Date.now() / 1000) + 7 * 86400
  assert.equal(entitlementWindow({ userId: USER, status: 'trialing', periodEnd: end, subscriptionId: 's' }, 3).active, true)
})

test('canceled, past_due and unpaid grant nothing on their own', () => {
  for (const status of ['canceled', 'past_due', 'unpaid', 'incomplete', '']) {
    const out = entitlementWindow({ userId: USER, status, periodEnd: Math.floor(Date.now() / 1000) + 86400, subscriptionId: 's' }, 3)
    assert.equal(out.active, false, `${status} must not entitle`)
    assert.equal(Date.parse(out.expiresAt), 0, `${status} must expire at the epoch`)
  }
})

test('a just-completed checkout with no period end still works immediately', () => {
  // The bridge: they have paid this second and the subscription event with the
  // real period end is moments behind. Granting nothing here would leave them
  // unentitled exactly when they go to use what they just bought.
  const now = () => 1_700_000_000_000
  const { active, expiresAt } = entitlementWindow(
    { userId: USER, status: 'active', periodEnd: 0, subscriptionId: '' },
    3,
    now,
  )
  assert.equal(active, true)
  assert.ok(Date.parse(expiresAt) > now(), 'the bridge must be in the future')
  assert.ok(Date.parse(expiresAt) <= now() + 5 * 86_400_000, 'and must be short')
})

test('an unreadable period end grants nothing — it must not fall into the bridge', () => {
  // Regression: this originally collapsed to 0, which entitlementWindow read as
  // "a checkout just completed" and answered with a day of free access for a
  // field it had failed to parse.
  const garbage = subscriptionFromEvent(subEvent({ current_period_end: 'soon' }))
  assert.equal(garbage.periodEnd, -1, 'unusable must be -1, never 0')
  const out = entitlementWindow(garbage, 3)
  assert.equal(out.active, false)
  assert.equal(Date.parse(out.expiresAt), 0)
})

test('a missing period end on a subscription event is equally refused', () => {
  const absent = subscriptionFromEvent(subEvent({ current_period_end: undefined }))
  assert.equal(entitlementWindow(absent, 3).active, false)
})
