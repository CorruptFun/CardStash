/**
 * The Square billing webhook's decisions, held to by test.
 *
 * Square's sandbox is not reachable from every sandbox this repo is developed
 * in, and the two things most worth being sure of need no network at all: that
 * only Square can grant an entitlement, and that the grant lasts exactly as
 * long as the subscription was paid for. Both are pure functions in logic.ts
 * precisely so this file can exist.
 *
 * The signature vectors are computed with node's own HMAC rather than with the
 * function under test — a test that verifies a hash against itself proves only
 * that it is deterministic.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { bundleImport } from './bundle.mjs'

const { squareSignature, safeEqual, isUserId, subscriptionFromEvent, entitlementWindow } = await bundleImport(
  'supabase/functions/square-billing/logic.ts',
)

const KEY = 'test-signature-key'
const URL_ = 'https://example.supabase.co/functions/v1/square-billing'
const independent = (payload) => createHmac('sha256', KEY).update(payload).digest('base64')

const subEvent = (over = {}) => ({
  type: 'subscription.updated',
  data: {
    object: {
      subscription: {
        customer_id: 'CUST123',
        status: 'ACTIVE',
        charged_through_date: '2026-09-15',
        ...over,
      },
    },
  },
})

test('the signature is HMAC-SHA256 over notification URL + raw body', async () => {
  const body = JSON.stringify(subEvent())
  assert.equal(await squareSignature(URL_ + body, KEY), independent(URL_ + body))
})

test('a body altered by one byte does not verify', async () => {
  const body = JSON.stringify(subEvent())
  const good = await squareSignature(URL_ + body, KEY)
  const tampered = await squareSignature(URL_ + body.replace('ACTIVE', 'ACTIVc'), KEY)
  assert.notEqual(good, tampered)
  assert.equal(safeEqual(good, tampered), false)
})

test('the URL is part of the signed payload, so a replay at another endpoint fails', async () => {
  const body = JSON.stringify(subEvent())
  const here = await squareSignature(URL_ + body, KEY)
  const elsewhere = await squareSignature('https://evil.example/hook' + body, KEY)
  assert.equal(safeEqual(here, elsewhere), false)
})

test('a signature made with the wrong key fails', async () => {
  const body = JSON.stringify(subEvent())
  assert.equal(
    safeEqual(await squareSignature(URL_ + body, KEY), await squareSignature(URL_ + body, 'other-key')),
    false,
  )
})

test('safeEqual compares length first and matches identical strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual('', ''), true)
})

test('only subscription lifecycle events are acted on', () => {
  assert.ok(subscriptionFromEvent(subEvent()))
  assert.ok(subscriptionFromEvent({ ...subEvent(), type: 'subscription.created' }))
  // Money events are deliberately ignored: access comes from the subscription.
  assert.equal(subscriptionFromEvent({ ...subEvent(), type: 'invoice.payment_made' }), null)
  assert.equal(subscriptionFromEvent({ ...subEvent(), type: 'payment.updated' }), null)
  assert.equal(subscriptionFromEvent({}), null)
  assert.equal(subscriptionFromEvent(null), null)
})

test('an event with no customer is ignored rather than half-applied', () => {
  assert.equal(subscriptionFromEvent(subEvent({ customer_id: undefined })), null)
})

test('an ACTIVE subscription grants until charged_through_date plus grace', () => {
  const { active, expiresAt } = entitlementWindow(subscriptionFromEvent(subEvent()), 3)
  assert.equal(active, true)
  assert.equal(expiresAt, '2026-09-18T00:00:00.000Z')
})

test('grace of zero grants exactly to the paid-through instant', () => {
  const { expiresAt } = entitlementWindow(subscriptionFromEvent(subEvent()), 0)
  assert.equal(expiresAt, '2026-09-15T00:00:00.000Z')
})

for (const status of ['CANCELED', 'PAUSED', 'DEACTIVATED', 'PENDING', '']) {
  test(`a ${status || 'blank'} subscription writes an already-expired row`, () => {
    const { active, expiresAt } = entitlementWindow(subscriptionFromEvent(subEvent({ status })), 3)
    assert.equal(active, false)
    assert.equal(new Date(expiresAt).getTime() < Date.now(), true)
  })
}

test('ACTIVE with no paid-through date grants nothing', () => {
  const { active } = entitlementWindow(subscriptionFromEvent(subEvent({ charged_through_date: undefined })), 3)
  assert.equal(active, false)
})

test('an unparseable date is refused rather than becoming unlimited access', () => {
  const { active, expiresAt } = entitlementWindow(subscriptionFromEvent(subEvent({ charged_through_date: 'soon' })), 3)
  assert.equal(active, false)
  assert.notEqual(expiresAt, 'Invalid Date')
  assert.equal(Number.isFinite(new Date(expiresAt).getTime()), true)
})

test('only a real user id is accepted from reference_id', () => {
  assert.equal(isUserId('3f6a1c2e-8b4d-4f1a-9c7e-2d5b8a0f1e33'), true)
  assert.equal(isUserId(''), false)
  assert.equal(isUserId('not-a-uuid'), false)
  // The old check was /^[0-9a-f-]{36}$/i, which these both satisfy.
  assert.equal(isUserId('------------------------------------'), false)
  assert.equal(isUserId('3f6a1c2e8b4d4f1a9c7e2d5b8a0f1e33aaaa'), false)
  assert.equal(isUserId(null), false)
})
