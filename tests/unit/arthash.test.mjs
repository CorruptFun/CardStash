import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

/*
 * The art-hash re-pick's DECISION layer. The hashes themselves are measured
 * in the harness (lesson 77's spike and the matrix); what belongs here is
 * the part that can go wrong without any pixels: which arts get compared,
 * and when a win is decisive enough to move an answer. A false swap here is
 * a manufactured wrong printing at full confidence, so — as with every
 * guard in this pipeline — the refusals are the load-bearing cases.
 */

const { artGroups, artGroupKeyOf, decideByArt } = await bundleImport('src/lib/arthash.ts')

const raw = (id, illustration, extra = {}) => ({
  id,
  illustration_id: illustration,
  image_uris: { small: `https://cards.scryfall.io/small/front/x/y/${id}.jpg` },
  ...extra,
})

test('printings sharing an illustration collapse into one art', () => {
  const groups = artGroups([raw('a', 'art-1'), raw('b', 'art-1'), raw('c', 'art-2')])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((g) => g.key), ['art-1', 'art-2'])
  // Newest-first input: the group keeps its newest print.
  assert.equal(groups[0].raw.id, 'a')
})

test('a print with no illustration id stands alone under its own id', () => {
  const groups = artGroups([raw('a', undefined), raw('b', undefined)])
  assert.deepEqual(groups.map((g) => g.key), ['a', 'b'])
})

test('digital printings never join the comparison', () => {
  const groups = artGroups([raw('a', 'art-1', { digital: true }), raw('b', 'art-2')])
  assert.deepEqual(groups.map((g) => g.key), ['art-2'])
})

test('the cap keeps newest arts but never drops the incumbent', () => {
  const raws = Array.from({ length: 20 }, (_, i) => raw(`p${i}`, `art-${i}`))
  const capped = artGroups(raws, 'p19')
  assert.equal(capped.length, 16)
  // p19 is the OLDEST (newest-first input) and would fall off the cap —
  // the incumbent must survive it, or "did a different art win?" cannot be
  // asked honestly.
  assert.ok(capped.some((g) => g.key === 'art-19'))
})

test('artGroupKeyOf resolves a print to its art', () => {
  const raws = [raw('a', 'art-1'), raw('b', 'art-1')]
  assert.equal(artGroupKeyOf(raws, 'b'), 'art-1')
  assert.equal(artGroupKeyOf(raws, 'zzz'), null)
})

test('a decisive different-art win swaps', () => {
  const verdict = decideByArt(
    [{ key: 'incumbent', d: 47 }, { key: 'challenger', d: 14 }],
    'incumbent',
  )
  assert.equal(verdict?.key, 'challenger')
  assert.equal(verdict?.margin, 33)
})

test('the incumbent winning is a refusal, not a swap to second place', () => {
  assert.equal(
    decideByArt([{ key: 'incumbent', d: 14 }, { key: 'challenger', d: 47 }], 'incumbent'),
    null,
  )
})

test('a thin margin refuses — the spike measured 22 vs 36 as the tightest true pair', () => {
  assert.equal(
    decideByArt([{ key: 'challenger', d: 30 }, { key: 'incumbent', d: 35 }], 'incumbent'),
    null,
  )
})

test('a "winner" too far from everything is no winner', () => {
  // Both arts distant: the capture matches neither (glare, wrong crop) —
  // moving the answer on that evidence would be a coin toss.
  assert.equal(
    decideByArt([{ key: 'challenger', d: 60 }, { key: 'incumbent', d: 90 }], 'incumbent'),
    null,
  )
})

test('one scored art, or no incumbent key, cannot decide anything', () => {
  assert.equal(decideByArt([{ key: 'only', d: 5 }], 'other'), null)
  assert.equal(decideByArt([{ key: 'a', d: 5 }, { key: 'b', d: 50 }], null), null)
})
