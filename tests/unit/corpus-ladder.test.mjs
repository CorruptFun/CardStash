import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RUNGS, RUNG_NAMES, hashSeed, ladderFor, seededRandom, splitSuffix } from '../corpus/ladder.mjs'

/*
 * The corpus sweep grades the matcher; these grade the sweep's own input side.
 *
 * A corruption ladder that is not reproducible produces findings nobody can
 * re-derive, and a ladder that silently "applies" to names it cannot corrupt
 * inflates every denominator in the report. Both are cheap to assert and
 * expensive to discover in a disagreement about a result.
 */

const rung = (name) => RUNGS.find((r) => r.name === name)
const apply = (rungName, cardName, apiId = 'seed') =>
  ladderFor(cardName, apiId).find((row) => row.rung === rungName)?.query ?? null

test('the same card always produces the same ladder', () => {
  const a = ladderFor('Krookodile ex', 'dex-swsh7-105')
  const b = ladderFor('Krookodile ex', 'dex-swsh7-105')
  assert.deepEqual(a, b)
  // Reproducible from the id alone is the whole contract: a finding in the
  // report can be re-derived without the report.
  assert.equal(a.length, RUNG_NAMES.length)
})

test('different cards draw independently', () => {
  // Not a strict guarantee for any one pair, but over a handful of ids the
  // glyph rung must not be producing one answer for everything.
  const queries = new Set(
    ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].map((id) => apply('glyph-l-i-1', 'Illustrious Wanderer', id)),
  )
  assert.ok(queries.size > 1, `expected varied glyph draws, got ${[...queries]}`)
})

test('a rung that cannot apply says so instead of passing silently', () => {
  // No diacritic, no hyphen, no variant suffix: three rungs that must be
  // scored as "not applicable", never as a corruption that happened to match.
  assert.equal(apply('diacritic-strip', 'Lightning Bolt'), null)
  assert.equal(apply('suffix-drop', 'Lightning Bolt'), null)
  assert.equal(apply('suffix-mangle', 'Lightning Bolt'), null)
  // An already-uppercase name cannot be case-folded into anything new.
  assert.equal(apply('case-fold', 'LOB-001'), null)
})

test('identity is the printed name, unchanged', () => {
  for (const name of ['Krookodile ex', 'Lim-Dûl\'s Vault', 'Blue-Eyes White Dragon']) {
    assert.equal(apply('identity', name), name)
  }
})

test('suffix-drop is the Krookodile shape and nothing else', () => {
  assert.equal(apply('suffix-drop', 'Krookodile ex'), 'Krookodile')
  assert.equal(apply('suffix-drop', 'Charizard VMAX'), 'Charizard')
  assert.equal(apply('suffix-drop', 'Mega Darkrai ex'), 'Mega Darkrai')
  // "Tauros-GX" prints the suffix on the same word — a hyphen is not a space,
  // and the drop rung must not invent one.
  assert.equal(apply('suffix-drop', 'Tauros-GX'), null)
})

test('splitSuffix only recognises the variant vocabulary', () => {
  assert.deepEqual(splitSuffix('Krookodile ex'), { base: 'Krookodile', suffix: 'ex' })
  assert.deepEqual(splitSuffix('Gyarados GX'), { base: 'Gyarados', suffix: 'GX' })
  assert.equal(splitSuffix('Dark Magician'), null, 'a real word is not a suffix')
  assert.equal(splitSuffix('Ho-Oh'), null, 'a single hyphenated word has no trailing token')
})

test('suffix-mangle keeps the base and destroys only the suffix', () => {
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    const query = apply('suffix-mangle', 'Krookodile ex', id)
    assert.ok(query.startsWith('Krookodile '), query)
    assert.notEqual(query, 'Krookodile ex')
    assert.notEqual(query, 'Krookodile', 'mangling is not dropping — that is its own rung')
  }
})

test('diacritic-strip flattens accents and the ligatures NFD leaves alone', () => {
  assert.equal(apply('diacritic-strip', 'Lim-Dûl\'s Vault'), "Lim-Dul's Vault")
  assert.equal(apply('diacritic-strip', 'Flabébé'), 'Flabebe')
  assert.equal(apply('diacritic-strip', 'Æther Vial'), 'AEther Vial')
})

test('separator-swap only ever moves separators', () => {
  const strip = (s) => s.replace(/[-–—·\s]/g, '')
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const query = apply('separator-swap', 'Blue-Eyes White Dragon', id)
    assert.ok(query, 'a hyphenated multi-word name is always separable')
    assert.equal(strip(query), strip('Blue-Eyes White Dragon'))
    assert.notEqual(query, 'Blue-Eyes White Dragon')
  }
})

test('glyph rungs change exactly one character', () => {
  const distance = (a, b) => {
    if (a.length !== b.length) return -1
    let n = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
    return n
  }
  for (const id of ['a', 'b', 'c']) {
    assert.equal(distance(apply('glyph-l-i-1', 'Illustrious Wanderer', id), 'Illustrious Wanderer'), 1)
    assert.equal(distance(apply('glyph-o-0', 'Boseiju, Who Endures', id), 'Boseiju, Who Endures'), 1)
  }
})

test('glyph-shape leaves the read pronounceable rather than junk', () => {
  // The "Pokemon" → "Petar" class: one word altered, the rest untouched.
  const query = apply('glyph-shape', 'Lightning Bolt', 'x')
  assert.notEqual(query, 'Lightning Bolt')
  const changed = query.split(' ').filter((w, i) => w !== 'Lightning Bolt'.split(' ')[i])
  assert.equal(changed.length, 1, `expected one altered word, got ${query}`)
})

test('the seed is stable and non-zero for any id', () => {
  assert.equal(hashSeed('dex-swsh7-105'), hashSeed('dex-swsh7-105'))
  assert.notEqual(hashSeed('a'), hashSeed('b'))
  assert.ok(hashSeed('') > 0, 'a zero seed would freeze xorshift')
  const draws = (seed) => {
    const rand = seededRandom(seed)
    return [rand(), rand(), rand()]
  }
  const first = draws(hashSeed('x'))
  assert.ok(first.every((d) => d >= 0 && d < 1))
  assert.deepEqual(first, draws(hashSeed('x')), 'the same seed must replay the same stream')
  assert.notDeepEqual(first, draws(hashSeed('y')))
})

test('every rung is reachable and named once', () => {
  assert.equal(new Set(RUNG_NAMES).size, RUNG_NAMES.length)
  for (const name of RUNG_NAMES) assert.ok(rung(name), name)
})
