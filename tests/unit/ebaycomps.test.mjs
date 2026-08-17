/**
 * What counts as a comparable, held to by test.
 *
 * These are asking prices off active eBay listings, and the whole difference
 * between a useful number and a misleading one is in the filtering — so the
 * cases here are mostly about what gets THROWN AWAY. A lot of thirty cards, a
 * repack, and one seller asking $9,999 for a common are all things that make a
 * median wrong in a way the collector reading it cannot see.
 *
 * `asSummary` is tested beside them because it is the door on our own server's
 * answer: our function, but eBay's numbers, and decision 7 says anything off a
 * wire is checked rather than cast.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const { summarizeListings, looksLikeNoise, normalizeQuery, MAX_QUERY_CHARS, MIN_COMPARABLES } = await bundleImport(
  'supabase/functions/ebay-comps/logic.ts',
)

const { asSummary, compsQuery } = await bundleImport('src/lib/ebaycomps.ts', {
  alias: { './db': new URL('./stubs/comps-host.mjs', import.meta.url).pathname },
})

const listing = (price, title = 'Ken Griffey Jr 1989 Upper Deck #1') => ({ title, price, currency: 'USD' })

test('a clean page yields low, median and high', () => {
  const out = summarizeListings([listing(10), listing(20), listing(30), listing(40), listing(50)])
  assert.deepEqual(out, { count: 5, scanned: 5, low: 10, median: 30, high: 50 })
})

test('lots, repacks, reprints and "you pick" listings are not this card', () => {
  for (const title of [
    'Ken Griffey Jr LOT of 30 cards',
    'Baseball card repack — hits guaranteed',
    'Griffey rookie REPRINT #1',
    'Custom Griffey art card',
    'You pick your card — 1989 Upper Deck',
    'Complete set 1989 Upper Deck',
  ]) {
    assert.equal(looksLikeNoise(title), true, title)
  }
  assert.equal(looksLikeNoise('1989 Upper Deck Ken Griffey Jr #1 PSA 9'), false)
})

test('one absurd asking price does not move the median', () => {
  // The band is computed against the median of everything, so the outlier
  // cannot drag the window far enough to keep itself.
  const withOutlier = summarizeListings([listing(20), listing(25), listing(30), listing(35), listing(9999)])
  assert.equal(withOutlier.high, 35)
  assert.equal(withOutlier.median, 27.5)
  // ...and it is still counted as scanned, so the UI can say what was seen.
  assert.equal(withOutlier.scanned, 5)
  assert.equal(withOutlier.count, 4)
})

test('too few surviving listings is null, not a confident guess', () => {
  assert.equal(summarizeListings([listing(20), listing(25)]), null)
  assert.equal(summarizeListings([]), null)
  // Three real listings plus junk: the junk does not make up the numbers.
  assert.equal(summarizeListings([listing(20), listing(30, 'lot of 50 cards'), listing(40, 'reprint')]), null)
  assert.equal(MIN_COMPARABLES, 3)
})

test('non-USD listings are dropped rather than mixed in', () => {
  // Decision 5 is USD only, and a €-priced listing summing into a dollar
  // median is exactly the bug `prices.ts` filters for elsewhere.
  const mixed = [listing(10), listing(20), listing(30), { title: 'Griffey', price: 25, currency: 'EUR' }]
  assert.equal(summarizeListings(mixed).count, 3)
})

test('a query is one line, capped, and free of control characters', () => {
  assert.equal(normalizeQuery('  1989   Upper\tDeck\nGriffey  '), '1989 Upper Deck Griffey')
  assert.equal(normalizeQuery('x'.repeat(400)).length, MAX_QUERY_CHARS)
  assert.equal(normalizeQuery(null), '')
  assert.equal(normalizeQuery({ q: 'nice try' }), '')
  // Punctuation a card number needs must survive — this is not a sanitizer.
  assert.equal(normalizeQuery('Topps #1 /99'), 'Topps #1 /99')
})

test('the server answer is coerced to the contract, not trusted', () => {
  const good = asSummary({ count: 12, scanned: 40, low: 5, median: 10, high: 30, currency: 'USD', kind: 'asking' })
  assert.deepEqual(good, { count: 12, scanned: 40, low: 5, median: 10, high: 30, currency: 'USD', kind: 'asking' })
  assert.equal(asSummary(null), null)
  assert.equal(asSummary({ count: 5, low: 'ten', median: 10, high: 30 }), null)
  assert.equal(asSummary({ count: 5, low: 1, median: NaN, high: 30 }), null)
  // Out of order means something upstream is wrong; a portfolio should not
  // inherit it as a plausible-looking number.
  assert.equal(asSummary({ count: 5, low: 50, median: 10, high: 30 }), null)
  assert.equal(asSummary({ count: 0, low: 1, median: 2, high: 3 }), null)
})

test('a bare player name is not enough to price', () => {
  // "Ken Griffey Jr" spans thirty years of cards from $1 to $10,000. A median
  // over that describes nothing, so no request is made at all.
  const bare = {
    id: 'sports:x',
    game: 'sports',
    apiId: 'x',
    name: 'Ken Griffey Jr',
    prices: { best: null, bestFoil: null, entries: [], updatedAt: 0 },
    links: {},
    sports: { sport: 'baseball', year: 1989, brand: 'Upper Deck', player: 'Ken Griffey Jr' },
  }
  assert.equal(compsQuery(bare), null)
  const numbered = { ...bare, number: '1' }
  assert.equal(compsQuery(numbered), '1989 Upper Deck Ken Griffey Jr #1')
  assert.equal(
    compsQuery(numbered, { company: 'PSA', grade: 10 }),
    '1989 Upper Deck Ken Griffey Jr #1 PSA 10',
  )
})

test('only sports cards are priced this way', () => {
  // Every other game has a real catalog price; running an asking-price median
  // beside it would invite the two being compared as if they meant the same.
  const mtg = {
    id: 'mtg:abc',
    game: 'mtg',
    apiId: 'abc',
    name: 'Black Lotus',
    number: '233',
    prices: { best: 1, bestFoil: null, entries: [], updatedAt: 0 },
    links: {},
  }
  assert.equal(compsQuery(mtg), null)
})
