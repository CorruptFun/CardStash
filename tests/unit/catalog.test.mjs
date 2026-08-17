/**
 * The catalog mirror's pure layer: the row sanitizer a server answer must
 * pass, the Card it becomes, and the sync worker's source mappers.
 * Everything here is what stands between a mirror row and a wrong card on a
 * user's screen, so the guards get tested harder than the happy path.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'
import { scryfallToRows, dexSetToRows, ygoToRows, isPaperDexSet, parseBulkLine } from '../../scripts/sync-catalog.mjs'

const { cardFromCatalog, sanitizeCatalogHit } = await bundleImport('src/lib/catalogmatch.ts')

test('sanitizeCatalogHit: bounds every field and drops what cannot be trusted', () => {
  const good = sanitizeCatalogHit({
    game: 'mtg',
    api_id: 'abc-123',
    name: 'Lightning Bolt',
    set_code: 'MSH',
    collector_number: '0321',
    rarity: 'uncommon',
    image_url: 'https://cards.example/bolt.jpg',
  })
  assert.equal(good.game, 'mtg')
  assert.equal(good.apiId, 'abc-123')
  assert.equal(good.setCode, 'MSH')

  // The mirror serves three games; anything else is not a mirror row.
  assert.equal(sanitizeCatalogHit({ game: 'riftbound', api_id: 'x', name: 'Jinx' }), null)
  assert.equal(sanitizeCatalogHit({ game: 'mtg', name: 'No id' }), null)
  // http images become <img src> on a dozen screens — https or nothing.
  assert.equal(sanitizeCatalogHit({ game: 'mtg', api_id: 'x', name: 'B', image_url: 'http://x/y.jpg' }).imageUrl, undefined)
  assert.equal(
    sanitizeCatalogHit({ game: 'mtg', api_id: 'x', name: 'B', image_url: 'javascript:alert(1)' }).imageUrl,
    undefined,
  )
  // The server row's art_hash is RESERVED and deliberately not parsed: the
  // fingerprint format is not yet a contract (see catalogmatch.ts).
  assert.equal('artHash' in sanitizeCatalogHit({ game: 'mtg', api_id: 'x', name: 'B', art_hash: '0'.repeat(64) }), false)
  assert.equal(sanitizeCatalogHit(null), null)
})

test('cardFromCatalog: the app id contract, and deliberately no prices', () => {
  const card = cardFromCatalog({ game: 'yugioh', apiId: '89631139', name: 'Blue-Eyes White Dragon', setCode: 'LOB' })
  assert.equal(card.id, 'yugioh:89631139')
  assert.equal(card.apiId, '89631139')
  assert.equal(card.prices.best, null)
  assert.equal(card.prices.entries.length, 0)
  assert.ok(card.links.tcgplayer)
})

test('parseBulkLine: JSONL rows and array-element lines, one bad line loses itself only', () => {
  assert.deepEqual(parseBulkLine('{"a":1}'), { a: 1 })
  // The old pretty-printed array era: element lines carry trailing commas
  // and the brackets stand alone.
  assert.deepEqual(parseBulkLine('  {"a":2},'), { a: 2 })
  assert.equal(parseBulkLine('['), null)
  assert.equal(parseBulkLine(']'), null)
  assert.equal(parseBulkLine(''), null)
  // The classic cut-short final row.
  assert.equal(parseBulkLine('{"a":'), null)
  assert.equal(parseBulkLine('not json'), null)
  assert.equal(parseBulkLine('42'), null)
})

test('scryfallToRows: en paper printings with the Scryfall uuid as api_id', () => {
  const rows = scryfallToRows([
    {
      id: 'uuid-1',
      lang: 'en',
      name: 'Lightning Bolt',
      set: 'msh',
      collector_number: '321',
      rarity: 'uncommon',
      image_uris: { normal: 'https://c1.scryfall.com/bolt.jpg' },
      prices: { usd: '1.50' },
    },
    { id: 'uuid-2', lang: 'ja', name: '稲妻', set: 'msh', collector_number: '321' },
    { id: 'uuid-3', lang: 'en', digital: true, name: 'Arena Bolt', set: 'ana', collector_number: '1' },
    {
      id: 'uuid-4',
      lang: 'en',
      name: 'Two-Faced // Card',
      set: 'msh',
      collector_number: '9',
      card_faces: [{ image_uris: { normal: 'https://c1.scryfall.com/face.jpg' } }],
    },
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(
    { ...rows[0], price_usd: rows[0].price_usd },
    {
      game: 'mtg',
      api_id: 'uuid-1',
      name: 'Lightning Bolt',
      slug: 'lightning bolt',
      set_code: 'MSH',
      collector_number: '321',
      rarity: 'uncommon',
      language: 'en',
      image_url: 'https://c1.scryfall.com/bolt.jpg',
      price_usd: 1.5,
    },
  )
  assert.equal(rows[1].image_url, 'https://c1.scryfall.com/face.jpg')
})

test('dexSetToRows: dex- prefixed ids, and TCG Pocket never enters the mirror', () => {
  assert.equal(isPaperDexSet('sv04'), true)
  assert.equal(isPaperDexSet('A1'), false)
  assert.equal(isPaperDexSet('B2a'), false)
  assert.equal(isPaperDexSet('P-A'), false)

  const rows = dexSetToRows({
    id: 'sv04',
    cards: [{ id: 'sv04-123', localId: 123, name: 'Charizard ex', image: 'https://assets.tcgdex.net/en/sv/sv04/123' }],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].api_id, 'dex-sv04-123')
  assert.equal(rows[0].set_code, 'SV04')
  assert.equal(rows[0].collector_number, '123')
  assert.equal(rows[0].image_url, 'https://assets.tcgdex.net/en/sv/sv04/123/high.webp')
  assert.deepEqual(dexSetToRows({ id: 'A1', cards: [{ id: 'A1-1', localId: 1, name: 'Pocket Pikachu' }] }), [])
})

test('ygoToRows: one row per printing, the passcode shared, the code split at its dash', () => {
  const rows = ygoToRows({
    id: 89631139,
    name: 'Blue-Eyes White Dragon',
    card_images: [{ image_url: 'https://images.ygoprodeck.com/89631139.jpg' }],
    card_sets: [
      { set_code: 'LOB-001', set_rarity: 'Ultra Rare', set_price: '89.99' },
      { set_code: 'BLMR-EN085', set_rarity: 'Secret Rare', set_price: '0' },
    ],
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].api_id, '89631139')
  assert.equal(rows[0].set_code, 'LOB')
  assert.equal(rows[0].collector_number, '001')
  assert.equal(rows[0].price_usd, 89.99)
  assert.equal(rows[1].set_code, 'BLMR')
  assert.equal(rows[1].collector_number, 'EN085')
  assert.equal(rows[1].price_usd, 0)
  // No printings listed still yields the card itself, filed under ''.
  const bare = ygoToRows({ id: 1, name: 'Promo Only' })
  assert.equal(bare.length, 1)
  assert.equal(bare[0].set_code, '')
})
