/**
 * The catalog mirror's transport (lib/catalog.ts) end to end in node, with
 * fetch stubbed at the boundary: the switch is respected before any request,
 * server rows pass the sanitizer on the way to Cards, the art tie-break
 * swaps only decisively and only to a different printing, a missing
 * migration (404) stands the mirror down at once, and flipping the switch
 * clears the stand-down. This is the wiring the matrix cannot show working
 * (its stubs answer empty) — known-answer data proves the plumbing, not the
 * model.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

const HERE = join(fileURLToPath(new URL('.', import.meta.url)))
const STUB = join(HERE, 'stubs', 'mirror-hosts.mjs')

const { mirrorByCode, mirrorByName, artPrintingTiebreak, mirrorPrintingsOf, mirrorLookupOn, clearMirrorStanddown } =
  await bundleImport('src/lib/catalog.ts', {
    alias: {
      './settings': STUB,
      './analytics': STUB,
      './cloudconfig': STUB,
      './authsession': STUB,
      './vision': STUB,
    },
  })

const zeros = '0'.repeat(64)
const flipped = (chars) => 'f'.repeat(chars) + '0'.repeat(64 - chars)

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
  globalThis.__mirrorCaptureHashes = [zeros]
}

test('the switch is checked before any request leaves', async () => {
  reset()
  globalThis.__mirrorSettings = { cardSourceLookup: false }
  const calls = serve(() => rows([]))
  assert.equal(mirrorLookupOn(), false)
  assert.deepEqual(await mirrorByName('mtg', 'Lightning Bolt'), [])
  assert.deepEqual(await mirrorByCode('mtg', 'MSH', '321'), [])
  assert.equal(await artPrintingTiebreak({ game: 'mtg', apiId: 'x', name: 'Bolt' }, { width: 400, height: 560 }), null)
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

test('the art tie-break swaps to the decisive printing, and only to a different one', async () => {
  reset()
  const near = { game: 'pokemon', api_id: 'dex-a', name: 'Pikachu', art_hash: flipped(10) } // distance 40
  const far = { game: 'pokemon', api_id: 'dex-b', name: 'Pikachu', art_hash: flipped(30) } // distance 120
  serve(() => rows([near, far]))
  const current = { game: 'pokemon', apiId: 'dex-b', name: 'Pikachu' }
  const swapped = await artPrintingTiebreak(current, { width: 400, height: 560 })
  assert.equal(swapped.id, 'pokemon:dex-a')
  assert.deepEqual(globalThis.__mirrorTracked, [{ t: 'catalog_art_pick', game: 'pokemon' }])

  // The winner already on screen is not a swap.
  serve(() => rows([near, far]))
  assert.equal(await artPrintingTiebreak({ ...current, apiId: 'dex-a' }, { width: 400, height: 560 }), null)
})

test('the capture neighborhood matters: any alignment may carry the match', async () => {
  reset()
  // The direct crop is hopeless (junk hash), but one offset in the search
  // neighborhood aligns — the picker must use the best alignment.
  globalThis.__mirrorCaptureHashes = ['f'.repeat(64), flipped(2)]
  const near = { game: 'pokemon', api_id: 'dex-a', name: 'Pikachu', art_hash: zeros } // best alignment: 8
  const far = { game: 'pokemon', api_id: 'dex-b', name: 'Pikachu', art_hash: flipped(32) } // best: 120
  serve(() => rows([near, far]))
  const swapped = await artPrintingTiebreak({ game: 'pokemon', apiId: 'dex-b', name: 'Pikachu' }, { width: 4, height: 6 })
  assert.equal(swapped.id, 'pokemon:dex-a')
})

test('a project without 0021 stands the mirror down after one 404', async () => {
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
