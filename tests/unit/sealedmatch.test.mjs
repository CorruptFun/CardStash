import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const { cleanGroupName, sealedEvidence, sealedSetCode, sealedSetScore } = await bundleImport('src/lib/sealedmatch.ts')

const SET_MATCH_THRESHOLD = 0.72 // sealed.ts's bar — scores are asserted against it

test('code prefixes are stripped for name matching, capitalized words are not', () => {
  assert.equal(cleanGroupName('SV08: Surging Sparks'), 'Surging Sparks')
  assert.equal(cleanGroupName('SV2a: Pokemon Card 151'), 'Pokemon Card 151')
  assert.equal(cleanGroupName('MH3 - Modern Horizons 3'), 'Modern Horizons 3')
  // "Theros" is the set name's first word, not a code — stripping it would
  // break MTG box matching.
  assert.equal(cleanGroupName('Theros: Beyond Death'), 'Theros: Beyond Death')
})

test('set codes need a letter AND a digit — names and plain numbers never qualify', () => {
  assert.equal(sealedSetCode({ name: 'SV4K: Ancient Roar' }), 'sv4k')
  assert.equal(sealedSetCode({ name: 'Ancient Roar', abbreviation: 'SV4K' }), 'sv4k')
  assert.equal(sealedSetCode({ name: 'S12a: VSTAR Universe' }), 's12a')
  // "MEW" is also a Pokémon name; "151" is also just a number on packaging.
  assert.equal(sealedSetCode({ name: '151', abbreviation: 'MEW' }), null)
  assert.equal(sealedSetCode({ name: 'SV: 151', abbreviation: '151' }), null)
  assert.equal(sealedSetCode({ name: 'Theros: Beyond Death' }), null)
})

test('Japanese pack: printed set code alone clears the match bar', () => {
  // What eng-only OCR realistically gets off a JP "Ancient Roar" pack: the
  // brand word, the code badge, and kanji junk.
  const evidence = sealedEvidence(['Pokémon', 'AAT 2 R', '(sv4K', '5 BU'])
  const jp = { name: 'SV4K: Ancient Roar', abbreviation: 'SV4K' }
  const score = sealedSetScore(jp, evidence)
  assert.ok(score >= SET_MATCH_THRESHOLD, `code-only score ${score} should clear ${SET_MATCH_THRESHOLD}`)
  // And the code must not light up sibling sets.
  assert.ok(sealedSetScore({ name: 'SV4M: Future Flash', abbreviation: 'SV4M' }, evidence) < SET_MATCH_THRESHOLD)
})

test('a readable English set name still outranks a code hit', () => {
  const evidence = sealedEvidence(['POKEMON TCG', 'Surging Sparks', '36 Booster Packs', 'SV08'])
  const named = sealedSetScore({ name: 'SV08: Surging Sparks' }, evidence)
  const codeOnly = sealedSetScore({ name: 'SV4K: Ancient Roar', abbreviation: 'SV4K' }, evidence)
  assert.ok(named > 0.85, `containment score ${named}`)
  assert.ok(named > codeOnly)
})

test('codes match as whole tokens only — substrings and fragments do not', () => {
  const jp = { name: 'SV4K: Ancient Roar', abbreviation: 'SV4K' }
  // "sv4" fragment (partial read) and glued junk must not count.
  assert.ok(sealedSetScore(jp, sealedEvidence(['Pokémon', 'sv4'])) < SET_MATCH_THRESHOLD)
  assert.ok(sealedSetScore(jp, sealedEvidence(['xsv4kz'])) < SET_MATCH_THRESHOLD)
  // Punctuation-adjacent reads do count — the badge prints tight.
  assert.ok(sealedSetScore(jp, sealedEvidence(['[sv4K]'])) >= SET_MATCH_THRESHOLD)
})

test('fuzzy per-line matching is unchanged for ordinary packaging', () => {
  const evidence = sealedEvidence(['Prismatic Evolutians', 'Booster'])
  const right = sealedSetScore({ name: 'SV: Prismatic Evolutions' }, evidence)
  assert.ok(right >= SET_MATCH_THRESHOLD, `fuzzy score ${right}`)
})
