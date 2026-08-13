import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const { parseCornerInfo, sameYgoCode } = await bundleImport('src/lib/corner.ts')

test('pokemon: SV-era collector line with set code', () => {
  const read = parseCornerInfo('pokemon', 'SVI EN 123/198\n© 2023 Pokémon')
  assert.equal(read.number, '123')
  assert.equal(read.total, '198')
  assert.equal(read.setCode, 'SVI')
})

test('pokemon: secret-rare fraction with zero padding', () => {
  const read = parseCornerInfo('pokemon', 'garbage 096/086 more')
  assert.equal(read.number, '96')
  assert.equal(read.total, '86')
})

test('pokemon: promo code', () => {
  assert.equal(parseCornerInfo('pokemon', 'SWSH 250').number, 'SWSH250')
})

test('mtg: modern collector line', () => {
  const read = parseCornerInfo('mtg', '0269 M\nMH3 • EN')
  assert.equal(read.number, '269')
  assert.equal(read.setCode, 'MH3')
})

test('mtg: legacy fraction line', () => {
  const read = parseCornerInfo('mtg', '269/350 U\nM21 • EN')
  assert.equal(read.number, '269')
  assert.equal(read.setCode, 'M21')
})

test('mtg: a copyright year is not a collector number', () => {
  assert.equal(parseCornerInfo('mtg', '™ & © 2023 Wizards').number, undefined)
})

test('yugioh: set code with language infix', () => {
  const read = parseCornerInfo('yugioh', 'LOB-EN001')
  assert.equal(read.number, 'LOB-EN001')
  assert.equal(read.setCode, 'LOB')
  assert.ok(sameYgoCode('LOB-EN001', 'LOB-001'))
  assert.ok(!sameYgoCode('LOB-EN001', 'LOB-002'))
})

test('onepiece: prefixed code with OCR gaps', () => {
  const read = parseCornerInfo('onepiece', 'OP01 - 016 junk')
  assert.equal(read.number, 'OP01-016')
  assert.equal(read.setCode, 'OP01')
})

test('riftbound: bare fraction pins the collector number', () => {
  const read = parseCornerInfo('riftbound', 'noise 045/298 λ')
  assert.equal(read.number, '45')
  assert.equal(read.total, '298')
})

test('lorcana: fraction plus language-adjacent set digit', () => {
  const read = parseCornerInfo('lorcana', '23/204 · EN · 1')
  assert.equal(read.number, '23')
  assert.equal(read.setCode, '1')
})
