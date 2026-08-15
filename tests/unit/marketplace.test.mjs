/**
 * The marketplace is OFF, and the sanitizers that stand between the server and
 * anything describing money.
 *
 * The off-switch test is the important one and is written to fail loudly if
 * anyone deletes the flag. Buying was dormant before the flag existed, but only
 * because no seller could finish Stripe Connect onboarding — a state that ends
 * the moment Connect is switched on for an unrelated reason. This pins the
 * difference between "off" and "not currently reachable".
 *
 * Note what this canNOT test: the server half. `MARKETPLACE_ENABLED` on the
 * edge function is the switch that actually stops a card being charged, and it
 * is only observable by asking the deployed function. This file pins the client
 * half, which hides the UI.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'stubs', 'marketplace-host.mjs')

const {
  marketAvailable,
  marketReady,
  sanitizeOrder,
  sanitizeAddress,
  orderTotalCents,
  sellerProceedsCents,
  orderStatusLabel,
  orderNarrative,
} = await bundleImport('src/lib/marketplace.ts', {
  alias: { './authsession': STUB, './cloudconfig': STUB },
})

const row = (over = {}) => ({
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  buyer: '8ec9b440-45dd-45e6-a28c-eca0ba83982a',
  seller: 'd6168231-0c92-4242-b53f-2603953c04d5',
  status: 'paid',
  card_id: 'mtg:lotus',
  card_name: 'Black Lotus',
  qty: 1,
  item_cents: 2500,
  shipping_cents: 500,
  fee_cents: 200,
  created_at: '2026-08-15T10:23:00Z',
  ...over,
})

// ------------------------------------------------------------- the off switch

test('THE MARKETPLACE IS OFF unless a build explicitly turns it on', () => {
  // The stub reports a configured cloud and a signed-in user, so neither of
  // those is why this is false. Only the absence of VITE_MARKETPLACE is.
  assert.equal(marketAvailable(), false)
  assert.equal(marketReady(), false)
})

// -------------------------------------------------------------- order parsing

test('a well-formed order survives intact', () => {
  const order = sanitizeOrder(row())
  assert.equal(order.status, 'paid')
  assert.equal(order.cardName, 'Black Lotus')
  assert.equal(order.itemCents, 2500)
  assert.equal(order.createdAt, Date.parse('2026-08-15T10:23:00Z'))
})

test('an unknown status is not believed', () => {
  // A status the client does not know would otherwise reach a template literal
  // and render as a pill class nobody styled.
  assert.equal(sanitizeOrder(row({ status: 'refunded_lol' })).status, 'pending')
  assert.equal(sanitizeOrder(row({ status: 42 })).status, 'pending')
})

test('a nonsense amount becomes zero rather than NaN next to a Pay button', () => {
  for (const bad of ['lots', null, undefined, -500, Number.NaN, 1e12]) {
    const order = sanitizeOrder(row({ item_cents: bad }))
    assert.equal(Number.isFinite(order.itemCents), true, `${bad} must not survive`)
    assert.equal(order.itemCents >= 0, true, `${bad} must not go negative`)
  }
})

test('an order missing its identity is refused outright', () => {
  assert.equal(sanitizeOrder(row({ id: '' })), null)
  assert.equal(sanitizeOrder(row({ card_name: null })), null)
  assert.equal(sanitizeOrder(null), null)
  assert.equal(sanitizeOrder([row()]), null)
})

test('the amounts reconcile, and the fee only ever comes out of the total', () => {
  const order = sanitizeOrder(row())
  assert.equal(orderTotalCents(order), 3000)
  assert.equal(sellerProceedsCents(order), 2800)
  // A fee larger than the sale cannot produce a negative payout on screen.
  const silly = sanitizeOrder(row({ fee_cents: 999_999 }))
  assert.equal(sellerProceedsCents(silly), 0)
})

// ------------------------------------------------------------------- address

test('an address is length-capped, because it is rendered into the page', () => {
  const addr = sanitizeAddress({
    name: 'x'.repeat(500),
    address: { line1: 'y'.repeat(500), city: 'Austin', postal_code: '78701', country: 'US' },
  })
  assert.equal(addr.name.length, 100)
  assert.equal(addr.line1.length, 200)
  assert.equal(addr.city, 'Austin')
})

test('an address with nothing postal in it is not an address', () => {
  assert.equal(sanitizeAddress({ name: 'Rae' }), null)
  assert.equal(sanitizeAddress(null), null)
  assert.equal(sanitizeAddress({}), null)
})

// ----------------------------------------------------------------- narrative

test('every status has a label and a narrative for both sides', () => {
  const statuses = ['pending', 'paid', 'shipped', 'delivered', 'released', 'refunded', 'cancelled', 'disputed']
  for (const status of statuses) {
    const order = sanitizeOrder(row({ status }))
    assert.equal(typeof orderStatusLabel(status), 'string')
    assert.ok(orderStatusLabel(status).length > 0, `${status} needs a label`)
    for (const seller of [true, false]) {
      const text = orderNarrative(order, seller)
      assert.ok(typeof text === 'string' && text.length > 0, `${status}/${seller} needs a narrative`)
    }
  }
})

test('the two sides are told different things where it matters', () => {
  // "Paid" means "post it" to a seller and "wait" to a buyer. A screen that
  // says the same to both has not decided who it is for.
  for (const status of ['paid', 'shipped', 'released', 'disputed']) {
    const order = sanitizeOrder(row({ status }))
    assert.notEqual(orderNarrative(order, true), orderNarrative(order, false), `${status} must differ by side`)
  }
})
