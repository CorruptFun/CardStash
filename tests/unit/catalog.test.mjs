/**
 * The catalog mirror's pure layer: the artwork fingerprint and its distance,
 * the row sanitizer a server answer must pass, the Card it becomes, the
 * art-based printing picker's guards, and the sync worker's source mappers.
 * Everything here is what stands between a mirror row and a wrong card on a
 * user's screen, so the guards get tested harder than the happy path.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'
import { scryfallToRows, dexSetToRows, ygoToRows, isPaperDexSet, parseBulkText } from '../../scripts/sync-catalog.mjs'

const { artHashFromGray, artHashDistance, ART_HASH_BITS } = await bundleImport('src/lib/vision.ts')
const {
  ART_ACCEPT_DISTANCE,
  ART_PICK_MARGIN,
  cardFromCatalog,
  pickPrintingByArt,
  sanitizeCatalogHit,
} = await bundleImport('src/lib/catalogmatch.ts')

/** A 17×16 luma grid from a per-cell function. */
const grid = (fn) => Array.from({ length: 17 * 16 }, (_, i) => fn(i % 17, (i / 17) | 0))

const zeros = '0'.repeat(64)
/** Flip `4 * chars` bits off the all-zero hash. */
const flipped = (chars) => 'f'.repeat(chars) + '0'.repeat(64 - chars)

test('artHashFromGray: 256 bits of horizontal gradient, deterministic', () => {
  assert.equal(ART_HASH_BITS, 256)
  const ramp = grid((x) => x * 10)
  const hash = artHashFromGray(ramp)
  assert.equal(hash.length, 64)
  assert.equal(hash, artHashFromGray(ramp))
  // A strictly rising row never has gray[x] > gray[x+1]: all zero bits.
  assert.equal(hash, zeros)
  // Strictly falling: every comparison true, all one bits.
  assert.equal(artHashFromGray(grid((x) => 200 - x * 10)), 'f'.repeat(64))
  // Brightness offset must not move a single bit — the reason this hash is
  // gradient-only (capture lighting differs from catalog scans wholesale).
  const scene = grid((x, y) => ((x * 31 + y * 17) % 13) * 9)
  const brighter = grid((x, y) => ((x * 31 + y * 17) % 13) * 9 + 40)
  assert.equal(artHashFromGray(scene), artHashFromGray(brighter))
})

test('artHashDistance: counts bits, and malformed answers the maximum', () => {
  assert.equal(artHashDistance(zeros, zeros), 0)
  assert.equal(artHashDistance(zeros, '1' + zeros.slice(1)), 1)
  assert.equal(artHashDistance(zeros, flipped(10)), 40)
  assert.equal(artHashDistance(zeros, 'f'.repeat(64)), 256)
  // Wrong length or non-hex is the MAXIMUM distance, not 128: a malformed
  // hash must never outrank a genuine candidate.
  assert.equal(artHashDistance(zeros, zeros.slice(1)), 256)
  assert.equal(artHashDistance('', zeros), 256)
  assert.equal(artHashDistance(zeros, 'g' + zeros.slice(1)), 256)
})

test('sanitizeCatalogHit: bounds every field and drops what cannot be trusted', () => {
  const good = sanitizeCatalogHit({
    game: 'mtg',
    api_id: 'abc-123',
    name: 'Lightning Bolt',
    set_code: 'MSH',
    collector_number: '0321',
    rarity: 'uncommon',
    image_url: 'https://cards.example/bolt.jpg',
    art_hash: zeros,
  })
  assert.equal(good.game, 'mtg')
  assert.equal(good.apiId, 'abc-123')
  assert.equal(good.setCode, 'MSH')
  assert.equal(good.artHash, zeros)

  // The mirror serves three games; anything else is not a mirror row.
  assert.equal(sanitizeCatalogHit({ game: 'riftbound', api_id: 'x', name: 'Jinx' }), null)
  assert.equal(sanitizeCatalogHit({ game: 'mtg', name: 'No id' }), null)
  // http images become <img src> on a dozen screens — https or nothing.
  assert.equal(sanitizeCatalogHit({ game: 'mtg', api_id: 'x', name: 'B', image_url: 'http://x/y.jpg' }).imageUrl, undefined)
  assert.equal(
    sanitizeCatalogHit({ game: 'mtg', api_id: 'x', name: 'B', image_url: 'javascript:alert(1)' }).imageUrl,
    undefined,
  )
  // A hash that is not exactly 64 lowercase hex chars is no hash at all.
  assert.equal(sanitizeCatalogHit({ game: 'mtg', api_id: 'x', name: 'B', art_hash: 'F'.repeat(64) }).artHash, undefined)
  assert.equal(sanitizeCatalogHit({ game: 'mtg', api_id: 'x', name: 'B', art_hash: 'abc' }).artHash, undefined)
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

test('pickPrintingByArt: only a decisive winner among the SAME card moves the pick', () => {
  const hit = (apiId, artHash, name = 'Pikachu') => ({ game: 'pokemon', apiId, name, artHash })
  const near = hit('a', flipped(10)) // distance 40
  const far = hit('b', flipped(30)) // distance 120

  const picked = pickPrintingByArt([zeros], 'Pikachu', [near, far])
  assert.equal(picked.hit.apiId, 'a')
  assert.equal(picked.distance, 40)

  // One candidate is not a choice.
  assert.equal(pickPrintingByArt([zeros], 'Pikachu', [near]), null)
  // Inside the margin, printings are indistinguishable — keep the name match's pick.
  assert.equal(pickPrintingByArt([zeros], 'Pikachu', [near, hit('c', flipped(12))]), null)
  assert.ok(ART_PICK_MARGIN > 48 - 40)
  // Past the accept threshold nothing matches, however clear the margin.
  assert.equal(pickPrintingByArt([zeros], 'Pikachu', [hit('d', flipped(21)), far]), null)
  assert.ok(21 * 4 > ART_ACCEPT_DISTANCE)
  // A different card's art may sit at distance zero and still never be
  // proposed: art chooses BETWEEN printings, never a different card.
  assert.equal(pickPrintingByArt([zeros], 'Pikachu', [hit('e', zeros, 'Raichu'), near]), null)
  // No capture hashes, no pick.
  assert.equal(pickPrintingByArt([], 'Pikachu', [near, far]), null)
  // The neighborhood is a search: a candidate's distance is its best
  // alignment's, so a junk direct crop must not bury an aligned offset.
  const searched = pickPrintingByArt(['f'.repeat(64), zeros], 'Pikachu', [near, far])
  assert.equal(searched.hit.apiId, 'a')
  assert.equal(searched.distance, 40)
})

test('parseBulkText: a JSON array or JSON Lines, and a cut-off tail loses one row, not all', () => {
  assert.deepEqual(parseBulkText('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }])
  assert.deepEqual(parseBulkText('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }])
  // A truncated final line is the download's problem, not the file's.
  assert.deepEqual(parseBulkText('{"a":1}\n{"a":2}\n{"a":'), [{ a: 1 }, { a: 2 }])
  assert.deepEqual(parseBulkText(''), [])
  assert.deepEqual(parseBulkText('not json at all'), [])
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
