/**
 * The PSA response normalizer, held to by test.
 *
 * This layer exists because the live response shape could not be verified
 * from a build environment — PSA's field casing differs between their docs and
 * their endpoints. So it reads keys case-insensitively and tolerates missing
 * halves, and these cases pin that tolerance: the point is that a renamed or
 * absent field degrades to a blank rather than to a wrong card.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'stubs', 'psa-host.mjs')

const { normalizePsaCert, psaSport, psaToParsed } = await bundleImport('src/lib/psa.ts', {
  alias: { './db': STUB },
})

test('the documented PascalCase shape reads cleanly', () => {
  const cert = normalizePsaCert(
    {
      PSACert: {
        CertNumber: '09472817',
        Year: '1989',
        Brand: 'UPPER DECK',
        Subject: 'KEN GRIFFEY JR.',
        CardNumber: '1',
        Variety: 'RC',
        Category: 'Baseball Cards',
        CardGrade: '10',
        GradeDescription: 'GEM MT',
        TotalPopulation: 8000,
      },
      // extra keys must not confuse it
    },
    '09472817',
  )
  assert.equal(cert.year, 1989)
  assert.equal(cert.subject, 'KEN GRIFFEY JR.')
  assert.equal(cert.cardNumber, '1')
  assert.equal(cert.grade, 10)
  assert.equal(cert.totalPopulation, 8000)
})

test('camelCase and an unwrapped body read identically', () => {
  const cert = normalizePsaCert({ certNumber: '1', year: 2023, subject: 'Victor Wembanyama', cardGrade: 9 }, '1')
  assert.equal(cert.subject, 'Victor Wembanyama')
  assert.equal(cert.year, 2023)
})

test('a grade spelled only in words is still recovered', () => {
  // The numeric field is missing; "GEM MT 10" still carries the number.
  const cert = normalizePsaCert({ PSACert: { Subject: 'X', GradeDescription: 'GEM MT 10' } }, '5')
  assert.equal(cert.grade, 10)
})

test('junk in is a blank record, never a fabricated one', () => {
  assert.equal(normalizePsaCert(null, '1'), null)
  assert.equal(normalizePsaCert('nope', '1'), null)
  const empty = normalizePsaCert({}, '1')
  assert.equal(empty.subject, undefined)
  assert.equal(empty.grade, undefined)
})

test('PSA categories map onto our sports', () => {
  assert.equal(psaSport('Baseball Cards'), 'baseball')
  assert.equal(psaSport('Basketball Cards'), 'basketball')
  assert.equal(psaSport('Non-Sports Cards'), 'other')
  assert.equal(psaSport(undefined), 'other')
})

test('a cert becomes the same parsed shape an OCR read produces', () => {
  const parsed = psaToParsed({
    cert: '09472817',
    year: 1989,
    brand: 'UPPER DECK',
    subject: 'Ken Griffey Jr.',
    cardNumber: '1',
    variety: 'RC',
    category: 'Baseball Cards',
  })
  assert.equal(parsed.brand, 'Upper Deck')
  assert.equal(parsed.player, 'Ken Griffey Jr.')
  assert.equal(parsed.sport, 'baseball')
  assert.equal(parsed.rookie, true)
  // A cert lookup is authoritative, not a guess.
  assert.equal(parsed.confidence, 1)
})
