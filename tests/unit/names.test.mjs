import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

// ocr.ts lazy-imports the Tesseract runtime; keep it external so bundling
// the pure name-candidate logic doesn't drag the OCR engine into node.
const { nameCandidates } = await bundleImport('src/lib/ocr.ts', {
  external: ['tesseract.js/dist/tesseract.esm.min.js'],
})
const { nameScore, similarity, normalizeName } = await bundleImport('src/lib/util.ts')

test('split names join ahead of their halves', () => {
  const out = nameCandidates(['JINX', 'Loose Cannon', 'Some long rules text that is ignored here'])
  assert.equal(out[0], 'JINX Loose Cannon')
  assert.ok(out.includes('JINX'))
})

test('leading evolution labels are also offered stripped', () => {
  const out = nameCandidates(['BASIC Tauros'])
  assert.ok(out.includes('Tauros'))
})

test('long first words are not stripped', () => {
  const out = nameCandidates(['Lightning Bolt'])
  assert.ok(!out.includes('Bolt'))
})

test('epithet-tolerant scoring: a lead-segment read still clears the bar', () => {
  assert.ok(nameScore('JINX', 'Jinx, Loose Cannon') > 0.9)
  assert.ok(nameScore('Elsa', 'Elsa - Snow Queen') > 0.9)
  assert.ok(nameScore('Jinx Loose Cannon', 'Jinx, Loose Cannon') > 0.93)
})

test('full-name reads outrank partial ones', () => {
  const full = nameScore('Jinx Loose Cannon', 'Jinx, Loose Cannon')
  const partial = nameScore('Jinx', 'Jinx, Loose Cannon')
  assert.ok(full > partial)
})

test('similarity is accent-insensitive; punctuation normalizes to a space', () => {
  // "Kin'emon" → "kin emon": one edit from "kinemon" — close, not identical.
  assert.ok(similarity("Kin'emon", 'Kinemon') > 0.85)
  assert.equal(normalizeName('Pokémon'), 'pokemon')
  assert.equal(similarity('Ambessa - Respected and Feared', 'Ambessa — Respected and Feared'), 1)
})
