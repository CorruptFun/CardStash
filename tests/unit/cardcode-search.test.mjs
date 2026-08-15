import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

/*
 * Looking a card up by the number printed on it, against stubbed networks:
 * Yu-Gi-Oh through YGOPRODeck's exact-match set-code endpoint, and the
 * TCGCSV games through the day-cached catalog already in memory.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url))
const { ygoBySetCode } = await bundleImport('src/lib/ygo.ts', {
  alias: { './fetchJson': join(HERE, 'stubs', 'ygo-net.mjs') },
})
const { parseCardCode } = await bundleImport('src/lib/cardcode.ts')
const { catalogByCode } = await bundleImport('src/lib/tcgcsv.ts', {
  alias: { './fetchJson': join(HERE, 'stubs', 'riftbound-net.mjs') },
})

test('a print code answers with THAT printing, not the card in general', async () => {
  const card = await ygoBySetCode('BLMR-EN085')
  assert.ok(card, 'expected a card')
  assert.equal(card.name, 'I:P Masquerena')
  assert.equal(card.number, 'BLMR-EN085')
  assert.equal(card.setCode, 'BLMR')
  assert.equal(card.rarity, 'Secret Rare')
  // Rarity moves Yu-Gi-Oh prices by orders of magnitude: answering a secret
  // rare's code with the reprint's headline price would be the wrong card's
  // money on the right card's face.
  assert.equal(card.prices.best, 25)
})

test('region and padding are the app’s problem, not the collector’s', async () => {
  for (const typed of ['BLMR-085', 'blmr en85', 'BLMR-EN85', 'blmr 085']) {
    const card = await ygoBySetCode(typed)
    assert.ok(card, typed)
    assert.equal(card.number, 'BLMR-EN085', typed)
  }
})

test('a code no set ever printed answers nothing rather than something close', async () => {
  assert.equal(await ygoBySetCode('BLMR-EN999'), null)
  assert.equal(await ygoBySetCode('ZZZZ-EN001'), null)
})

test('catalog games match the printed number out of the cached catalog', async () => {
  const hits = await catalogByCode('riftbound', parseCardCode('UNL 041'))
  assert.equal(hits.length, 1)
  assert.equal(hits[0].name, 'Ahri - Inquisitive')
})

test('every printing sharing the number comes back, base art first', async () => {
  // 040/219 is one card with three products; the number cannot choose
  // between them, so the query gets all three with the base printing leading.
  const hits = await catalogByCode('riftbound', parseCardCode('UNL-40'))
  assert.deepEqual(
    hits.map((c) => c.name),
    ['Ahri - Alluring', 'Ahri - Alluring (Alternate Art)', 'Ahri - Alluring (Launch Exclusive)'],
  )
})

test('a bare fraction identifies only when the set size agrees', async () => {
  assert.equal((await catalogByCode('riftbound', parseCardCode('115/219')))[0].name, 'Nilah - Joyful Ascetic')
  // Right number, wrong set size — that is a different set's card.
  assert.deepEqual(await catalogByCode('riftbound', parseCardCode('115/198')), [])
})

test('a set code that is not this set matches nothing', async () => {
  assert.deepEqual(await catalogByCode('riftbound', parseCardCode('OGN-041')), [])
})
