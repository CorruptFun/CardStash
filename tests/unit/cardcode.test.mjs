import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

/*
 * The printed batch/print code as a search query — "BLMR-EN085". The parser
 * is the guard for the whole feature: everything downstream spends a request
 * on whatever it accepts, and anything it accepts wrongly is a request spent
 * on an ordinary name search.
 */
const { parseCardCode, sameCardCode } = await bundleImport('src/lib/cardcode.ts')

test('a Yu-Gi-Oh print code parses into set, region-free number and digits', () => {
  const code = parseCardCode('BLMR-EN085')
  assert.equal(code.setCode, 'BLMR')
  assert.equal(code.number, '085')
  assert.equal(code.digits, '85')
  assert.equal(code.code, 'BLMR-EN085')
})

test('typed sloppily is still the same code', () => {
  for (const typed of ['blmr-en085', ' BLMR EN085 ', 'BLMR–EN085', 'blmr-085']) {
    const code = parseCardCode(typed)
    assert.ok(code, typed)
    assert.equal(code.setCode, 'BLMR', typed)
    assert.equal(code.digits, '85', typed)
  }
})

test('the other code games parse the same way', () => {
  assert.equal(parseCardCode('OP01-016').setCode, 'OP01')
  assert.equal(parseCardCode('BT12-041').digits, '41')
  assert.equal(parseCardCode('GD01-003').code, 'GD01-003')
})

test('a set code and a plain collector number pair up', () => {
  const code = parseCardCode('NEO 266')
  assert.equal(code.setCode, 'NEO')
  assert.equal(code.number, '266')
  assert.equal(code.printedTotal, undefined)
})

test('a variant letter survives — Magic prints 266a', () => {
  const code = parseCardCode('MH3 266a')
  assert.equal(code.number, '266A')
  assert.equal(code.digits, '266')
})

test('a printed fraction carries the set size, with or without a code', () => {
  const withCode = parseCardCode('SVI 123/198')
  assert.equal(withCode.setCode, 'SVI')
  assert.equal(withCode.digits, '123')
  assert.equal(withCode.printedTotal, '198')

  const bare = parseCardCode('045/198')
  assert.equal(bare.setCode, undefined)
  assert.equal(bare.digits, '45')
  assert.equal(bare.printedTotal, '198')
})

test('the Yu-Gi-Oh passcode is its own kind of identity', () => {
  const code = parseCardCode('89631139')
  assert.equal(code.passcode, '89631139')
  assert.equal(code.setCode, undefined)
})

test('ordinary searches are never mistaken for codes', () => {
  for (const query of [
    'Dark Magician',
    'Blue-Eyes White Dragon',
    'I:P Masquerena',
    'charizard ex',
    'Sol Ring',
    'lightning',
    // A power/toughness box or a deck count is not a collector fraction.
    '4/4',
    '2/40',
    // Nothing prints a code this long, and a query this long is prose.
    'BLMR-EN085 secret rare first edition',
  ]) {
    assert.equal(parseCardCode(query), null, query)
  }
})

test('a name that looks like a code still parses — and that is safe', () => {
  // "MEW 25" IS a real Pokémon printing (the 151 set's code is MEW), so
  // refusing it would cost more than accepting it: searchGame runs the name
  // search alongside the code lookup either way.
  assert.equal(parseCardCode('MEW 25').setCode, 'MEW')
})

test('codes compare across region and padding', () => {
  assert.ok(sameCardCode('BLMR-EN085', 'BLMR-85'))
  assert.ok(sameCardCode('OP01-016', 'op01-16'))
  assert.ok(!sameCardCode('BLMR-EN085', 'BLMR-EN086'))
  assert.ok(!sameCardCode('BLMR-EN085', undefined))
})
