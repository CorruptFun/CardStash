/**
 * The catalog mirror's transport (lib/catalog.ts) end to end in node, with
 * fetch stubbed at the boundary: the switch is respected before any request,
 * server rows pass the sanitizer on the way to Cards, a missing migration
 * (404) stands the mirror down at once, and flipping the switch clears the
 * stand-down. This is the wiring the matrix cannot show working (its stubs
 * answer empty) — known-answer data proves the plumbing, not the model.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

const HERE = join(fileURLToPath(new URL('.', import.meta.url)))
const STUB = join(HERE, 'stubs', 'mirror-hosts.mjs')

const { mirrorByCode, mirrorByName, mirrorPrintingsOf, mirrorLookupOn, clearMirrorStanddown } =
  await bundleImport('src/lib/catalog.ts', {
    alias: {
      './settings': STUB,
      './analytics': STUB,
      './cloudconfig': STUB,
      './authsession': STUB,
    },
  })

/** Install a fetch stub; returns the log of requests it served. */
function serve(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} })
    return handler(String(url), calls.length)
  }
  return calls
}

const rows = (list) => new Response(JSON.stringify(list), { status: 200 })

function reset() {
  clearMirrorStanddown()
  globalThis.__mirrorSettings = { cardSourceLookup: true }
  globalThis.__mirrorTracked = []
}

test('the switch is checked before any request leaves', async () => {
  reset()
  globalThis.__mirrorSettings = { cardSourceLookup: false }
  const calls = serve(() => rows([]))
  assert.equal(mirrorLookupOn(), false)
  assert.deepEqual(await mirrorByName('mtg', 'Lightning Bolt'), [])
  assert.deepEqual(await mirrorByCode('mtg', 'MSH', '321'), [])
  assert.deepEqual(await mirrorPrintingsOf('mtg', 'Bolt'), [])
  assert.equal(calls.length, 0)
})

test('rows become Cards through the sanitizer, anonymously', async () => {
  reset()
  const calls = serve(() =>
    rows([
      { game: 'mtg', api_id: 'uuid-1', name: 'Lightning Bolt', set_code: 'MSH', collector_number: '321', image_url: 'https://c/x.jpg' },
      { game: 'mtg', api_id: 'uuid-2', name: 'Sneaky Row', image_url: 'http://plain/http.jpg' },
      { game: 'riftbound', api_id: 'nope', name: 'Wrong Game' },
    ]),
  )
  const cards = await mirrorByCode('mtg', 'msh', '0321')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/catalog_by_code$/)
  // Publishable key only — no Authorization header rides a lookup.
  assert.equal(calls[0].headers.Authorization, undefined)
  assert.equal(calls[0].headers.apikey, 'pk_test')
  // The wrong-game row is dropped; the http image is stripped, not the card.
  assert.equal(cards.length, 2)
  assert.equal(cards[0].id, 'mtg:uuid-1')
  assert.equal(cards[0].imageSmall, 'https://c/x.jpg')
  assert.equal(cards[1].imageSmall, undefined)
  assert.deepEqual(globalThis.__mirrorTracked, [{ t: 'catalog_fallback', game: 'mtg', how: 'code' }])
})

test('a project without 0022 stands the mirror down after one 404', async () => {
  reset()
  const calls = serve(() => new Response('{"message":"function not found"}', { status: 404 }))
  assert.deepEqual(await mirrorByName('mtg', 'Bolt'), [])
  assert.deepEqual(await mirrorByName('mtg', 'Bolt'), [])
  assert.equal(calls.length, 1)
  assert.equal(mirrorLookupOn(), false)
  // Flipping the switch is the one signal worth more than our last failure.
  clearMirrorStanddown()
  assert.equal(mirrorLookupOn(), true)
  await mirrorByName('mtg', 'Bolt')
  assert.equal(calls.length, 2)
})

test('two straight failures stand it down; a success resets the count', async () => {
  reset()
  let healthy = false
  const calls = serve(() => (healthy ? rows([]) : new Response('oops', { status: 500 })))
  await mirrorPrintingsOf('mtg', 'Bolt')
  assert.equal(mirrorLookupOn(), true) // one failure is a tunnel, not a server
  healthy = true
  await mirrorPrintingsOf('mtg', 'Bolt')
  healthy = false
  await mirrorPrintingsOf('mtg', 'Bolt')
  assert.equal(mirrorLookupOn(), true) // the success in between reset the count
  await mirrorPrintingsOf('mtg', 'Bolt')
  assert.equal(mirrorLookupOn(), false) // two in a row is a server
  assert.equal(calls.length, 4)
})
