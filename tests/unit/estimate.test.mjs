/**
 * The soft estimate, held to by test.
 *
 * The danger here is not arithmetic, it is provenance: an estimate is only
 * defensible while every dollar in it traces back to something the collector
 * typed. So these cases are mostly about what is NOT allowed to influence the
 * number — a different year, a slab against a raw copy, a purchase price
 * standing in when valuations exist, or the card being priced counting itself.
 *
 * The basis sentence is tested beside the figures on purpose. It is the
 * disclosure, not a caption: a wrong one is worse than a wrong range, because
 * it is what the user checks the range against.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const { estimateValue, tierFor, roundEstimate, describeBasis, formatEstimate, MIN_COMPARABLES } = await bundleImport(
  'src/lib/estimate.ts',
  { alias: { './db': new URL('./stubs/comps-host.mjs', import.meta.url).pathname } },
)

const card = (over = {}, sports = {}) => ({
  id: `sports:${over.number ?? 'x'}-${sports.player ?? 'p'}`,
  game: 'sports',
  apiId: 'x',
  name: sports.player ?? 'Card',
  prices: { best: null, bestFoil: null, entries: [], updatedAt: 0 },
  links: {},
  ...over,
  sports: { sport: 'baseball', year: 1989, brand: 'Upper Deck', ...sports },
})

const priced = (value, over = {}, sports = {}, basis = 'valued', graded = false) => ({
  card: card(over, sports),
  value,
  basis,
  graded,
})

const GRIFFEY = card({ number: '1' }, { player: 'Ken Griffey Jr' })

test('three priced cards of the same player make a range', () => {
  const out = estimateValue(GRIFFEY, [
    priced(20, { number: '10' }, { player: 'Ken Griffey Jr' }),
    priced(30, { number: '11' }, { player: 'Ken Griffey Jr' }),
    priced(40, { number: '12' }, { player: 'Ken Griffey Jr' }),
  ])
  assert.equal(out.tier, 'player')
  assert.equal(out.low, 20)
  assert.equal(out.mid, 30)
  assert.equal(out.high, 40)
  assert.equal(out.count, 3)
  assert.match(out.from, /3 Ken Griffey Jr cards from 1989 you've priced/)
})

test('two is not a range', () => {
  assert.equal(MIN_COMPARABLES, 3)
  assert.equal(
    estimateValue(GRIFFEY, [
      priced(20, { number: '10' }, { player: 'Ken Griffey Jr' }),
      priced(30, { number: '11' }, { player: 'Ken Griffey Jr' }),
    ]),
    null,
  )
})

test('a different year is a different market, however matched otherwise', () => {
  // Same player, same brand, same everything but the year — and a 1989 rookie
  // against a 1994 base is exactly the comparison that produces a wrong
  // number nobody can see is wrong.
  const out = estimateValue(GRIFFEY, [
    priced(20, { number: '10' }, { player: 'Ken Griffey Jr', year: 1994 }),
    priced(30, { number: '11' }, { player: 'Ken Griffey Jr', year: 1994 }),
    priced(40, { number: '12' }, { player: 'Ken Griffey Jr', year: 1994 }),
  ])
  assert.equal(out, null)
})

test('the strongest tier wins outright and is never averaged with the weaker', () => {
  // Three same-player cards around $30, twenty same-set cards around $2. The
  // player evidence is what an estimate should rest on; blending them would
  // bury it under the commons.
  const corpus = [
    priced(28, { number: '10' }, { player: 'Ken Griffey Jr' }),
    priced(30, { number: '11' }, { player: 'Ken Griffey Jr' }),
    priced(32, { number: '12' }, { player: 'Ken Griffey Jr' }),
    ...Array.from({ length: 20 }, (_, i) => priced(2, { number: `${100 + i}` }, { player: `Filler ${i}` })),
  ]
  const out = estimateValue(GRIFFEY, corpus)
  assert.equal(out.tier, 'player')
  assert.equal(out.mid, 30)
})

test('the set tier answers when the player has no history', () => {
  const out = estimateValue(GRIFFEY, [
    priced(4, { number: '20' }, { player: 'Someone Else' }),
    priced(6, { number: '21' }, { player: 'Another' }),
    priced(8, { number: '22' }, { player: 'A Third' }),
  ])
  assert.equal(out.tier, 'set')
  assert.match(out.from, /3 cards from 1989 Upper Deck you've priced/)
})

test('a slab is not a comparable for a raw card, or the other way round', () => {
  const slabs = [
    priced(200, { number: '10' }, { player: 'Ken Griffey Jr' }, 'valued', true),
    priced(300, { number: '11' }, { player: 'Ken Griffey Jr' }, 'valued', true),
    priced(400, { number: '12' }, { player: 'Ken Griffey Jr' }, 'valued', true),
  ]
  assert.equal(estimateValue(GRIFFEY, slabs, false), null)
  assert.equal(estimateValue(GRIFFEY, slabs, true).mid, 300)
})

test('valuations outrank purchase prices, and the sentence says which', () => {
  const corpus = [
    priced(30, { number: '10' }, { player: 'Ken Griffey Jr' }),
    priced(32, { number: '11' }, { player: 'Ken Griffey Jr' }),
    priced(34, { number: '12' }, { player: 'Ken Griffey Jr' }),
    priced(5, { number: '13' }, { player: 'Ken Griffey Jr' }, 'paid'),
    priced(6, { number: '14' }, { player: 'Ken Griffey Jr' }, 'paid'),
    priced(7, { number: '15' }, { player: 'Ken Griffey Jr' }, 'paid'),
  ]
  const out = estimateValue(GRIFFEY, corpus)
  assert.equal(out.basis, 'valued')
  assert.equal(out.count, 3)
  assert.match(out.from, /you've priced$/)

  const paidOnly = corpus.filter((row) => row.basis === 'paid')
  const fallback = estimateValue(GRIFFEY, paidOnly)
  assert.equal(fallback.basis, 'paid')
  assert.match(fallback.from, /you've recorded paying for$/)
})

test('the card being priced never counts as its own comparable', () => {
  const self = { card: GRIFFEY, value: 999, basis: 'valued', graded: false }
  assert.equal(tierFor(GRIFFEY, GRIFFEY), null)
  assert.equal(
    estimateValue(GRIFFEY, [
      self,
      priced(20, { number: '10' }, { player: 'Ken Griffey Jr' }),
      priced(30, { number: '11' }, { player: 'Ken Griffey Jr' }),
    ]),
    null,
  )
})

test('one wild valuation does not drag the range with it', () => {
  const out = estimateValue(GRIFFEY, [
    priced(20, { number: '10' }, { player: 'Ken Griffey Jr' }),
    priced(25, { number: '11' }, { player: 'Ken Griffey Jr' }),
    priced(30, { number: '12' }, { player: 'Ken Griffey Jr' }),
    priced(9000, { number: '13' }, { player: 'Ken Griffey Jr' }),
  ])
  assert.equal(out.high, 30)
  assert.equal(out.count, 3)
})

test('figures round to a step that matches how much is known', () => {
  // A cent-precise estimate invites trust in a decimal place that is pure
  // arithmetic residue.
  assert.equal(roundEstimate(3.27), 3.5)
  assert.equal(roundEstimate(34.17), 34)
  assert.equal(roundEstimate(133.4), 135)
  assert.equal(roundEstimate(612), 610)
  assert.equal(roundEstimate(4180), 4200)
})

test('an estimate prints without false cents', () => {
  // `money()` always shows cents, which is right for a price somebody charges
  // and wrong for a figure rounded to the nearest five dollars.
  assert.equal(formatEstimate(30), '$30')
  assert.equal(formatEstimate(3.5), '$3.50')
  assert.equal(formatEstimate(4200), '$4,200')
})

test('the basis sentence names the comparables, and pluralises', () => {
  assert.equal(
    describeBasis(GRIFFEY, 'player', 1, 'valued'),
    "1 Ken Griffey Jr card from 1989 you've priced",
  )
  assert.equal(describeBasis(GRIFFEY, 'brand', 4, 'paid'), "4 1989 Upper Deck cards you've recorded paying for")
})

test('nothing is estimated for a game that has a real price feed', () => {
  const mtg = { id: 'mtg:a', game: 'mtg', apiId: 'a', name: 'Lotus', prices: { entries: [] }, links: {} }
  assert.equal(estimateValue(mtg, [priced(1), priced(2), priced(3)]), null)
})
