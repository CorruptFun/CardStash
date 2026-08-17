/**
 * The subscription, seen from the client — and the ONE thing seeing it may do.
 *
 * `subscriptionState()` is presentation: it reads `entitlements` and chooses
 * which words to show. Its single permitted side effect is the point of this
 * file — the first ACTIVE entitlement this device ever sees switches the
 * cloud rescue on (`noteEntitlementSeen`), exactly once, stamped in
 * `rescueAutoOnAt`. The test that matters most is the quiet one: a rescue
 * turned off after that flip stays off through every later answer, because an
 * entitlement check never overrules a person.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'
import { SETTINGS_DEFAULTS } from './stubs/referral-host.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'stubs', 'referral-host.mjs')

const { noteEntitlementSeen, subscriptionState } = await bundleImport('src/lib/billing.ts', {
  alias: { './authsession': STUB, './cloudconfig': STUB, './settings': STUB },
})

/** Fresh settings + a signed-in account before every test. */
function reset(over = {}) {
  globalThis.__settings = { ...SETTINGS_DEFAULTS, ...over }
  globalThis.__signedIn = true
  return globalThis.__settings
}

/** Record every request and answer it with `replies` in order. */
function fakeFetch(...replies) {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), ...init })
    const reply = replies.shift() ?? { ok: true, body: null }
    if (reply instanceof Error) throw reply
    return {
      ok: reply.ok !== false,
      status: reply.ok === false ? 500 : 200,
      json: async () => reply.body,
    }
  }
  return sent
}

const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString()
const LIVE = { active: true, expiresAt: Date.now() + 86_400_000, source: 'stripe' }

// ----------------------------------------------------------------- the flip

test('the first active entitlement switches the rescue on, and stamps the marker', () => {
  reset()
  noteEntitlementSeen(LIVE)
  assert.equal(globalThis.__settings.cloudScanRescue, true)
  assert.ok(globalThis.__settings.rescueAutoOnAt > 0, 'the one-shot marker must record the flip')
})

test('an inactive answer flips nothing — a free account is untouched', () => {
  reset()
  noteEntitlementSeen({ active: false, expiresAt: 0, source: '' })
  assert.equal(globalThis.__settings.cloudScanRescue, false)
  assert.equal(globalThis.__settings.rescueAutoOnAt, 0)
})

test('every grant shape throws the same switch: yearly, founding, comped', () => {
  // All three are the same entitlement row; the founding one-off must not be
  // a second code path that forgets the flip.
  for (const source of ['stripe', 'stripe-founding', 'manual']) {
    reset()
    noteEntitlementSeen({ active: true, expiresAt: 0, source })
    assert.equal(globalThis.__settings.cloudScanRescue, true, `${source} must switch the rescue on`)
  }
})

// ------------------------------------------------------- once, and only once

test('a rescue turned off after the flip STAYS off through every later answer', () => {
  reset()
  noteEntitlementSeen(LIVE)
  globalThis.__settings.cloudScanRescue = false // the person answers
  noteEntitlementSeen(LIVE) // a renewal…
  noteEntitlementSeen({ ...LIVE, source: 'stripe-founding' }) // …or any other grant
  assert.equal(globalThis.__settings.cloudScanRescue, false, 'entitlement never overrules a person')
})

test('a device that already flipped never flips again, and the marker is never rewritten', () => {
  reset({ rescueAutoOnAt: 123 })
  noteEntitlementSeen(LIVE)
  assert.equal(globalThis.__settings.cloudScanRescue, false)
  assert.equal(globalThis.__settings.rescueAutoOnAt, 123, 'written once, kept for ever')
})

test('a rescue already on by hand is left alone; the marker still stamps', () => {
  // The purchase asked for something already granted — recording that the
  // auto-on moment is spent is what protects a LATER manual off.
  reset({ cloudScanRescue: true })
  noteEntitlementSeen(LIVE)
  assert.equal(globalThis.__settings.cloudScanRescue, true)
  assert.ok(globalThis.__settings.rescueAutoOnAt > 0)
})

// ------------------------------------------------- the funnel is the fetch

test('subscriptionState funnels an active row through the flip', async () => {
  reset()
  fakeFetch({ body: [{ expires_at: inDays(30), source: 'stripe' }] })
  const state = await subscriptionState()
  assert.equal(state.active, true)
  assert.equal(globalThis.__settings.cloudScanRescue, true)
  assert.ok(globalThis.__settings.rescueAutoOnAt > 0)
})

test('a comped grant with no end (null expiry) is active, and flips too', async () => {
  reset()
  fakeFetch({ body: [{ expires_at: null, source: 'manual' }] })
  const state = await subscriptionState()
  assert.equal(state.active, true)
  assert.equal(globalThis.__settings.cloudScanRescue, true)
})

test('an expired row flips nothing', async () => {
  reset()
  fakeFetch({ body: [{ expires_at: inDays(-1), source: 'stripe' }] })
  const state = await subscriptionState()
  assert.equal(state.active, false)
  assert.equal(globalThis.__settings.cloudScanRescue, false)
})

test('no row, a server error, offline, signed out: nothing flips and nothing leaks', async () => {
  reset()
  fakeFetch({ body: [] })
  await subscriptionState()
  assert.equal(globalThis.__settings.cloudScanRescue, false, 'never granted')

  reset()
  fakeFetch({ ok: false })
  await subscriptionState()
  assert.equal(globalThis.__settings.cloudScanRescue, false, 'a 500 is not a subscription')

  reset()
  fakeFetch(new Error('offline'))
  await subscriptionState()
  assert.equal(globalThis.__settings.cloudScanRescue, false, 'offline is not an answer')

  reset()
  globalThis.__signedIn = false
  const sent = fakeFetch()
  await subscriptionState()
  assert.equal(sent.length, 0, 'signed out asks nothing')
  assert.equal(globalThis.__settings.cloudScanRescue, false)
})
