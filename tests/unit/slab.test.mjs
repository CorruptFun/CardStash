/**
 * The slab label parser, held to by test.
 *
 * The stakes here are asymmetric. Missing a slab costs a scan; inventing one
 * puts a grade on a raw card, which misprices it by an order of magnitude and
 * would travel into a trade. So most of these cases are about refusal.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const { parseSlabLabel, looksLikeSlab, detectGrade, detectGradeCompany, detectCert, gradeLabel, gradeShort } =
  await bundleImport('src/lib/slab.ts')

test('a PSA label yields company, grade and cert', () => {
  const read = parseSlabLabel(['PSA', '1989 UPPER DECK #1', 'KEN GRIFFEY JR. RC', 'GEM MT 10', '09472817'])
  assert.equal(read.grade.company, 'PSA')
  assert.equal(read.grade.grade, 10)
  assert.equal(read.grade.cert, '09472817')
})

test('no company word means no slab, however grade-like the rest reads', () => {
  // `GradeInfo.company` is not optional and must not be guessed — inferring
  // it from cert length would put a made-up grading company on a real card.
  // Every slab prints its brand, so requiring it costs nothing real.
  assert.equal(parseSlabLabel(['1989 UPPER DECK #1', 'GEM MT 10', '09472817']), null)
})

test('the company is read from any of its printed forms', () => {
  assert.equal(detectGradeCompany('PROFESSIONAL SPORTS AUTHENTICATOR'), 'PSA')
  assert.equal(detectGradeCompany('BECKETT GRADING SERVICES'), 'BGS')
  assert.equal(detectGradeCompany('SGC 96'), 'SGC')
  assert.equal(detectGradeCompany('a plain trading card'), undefined)
})

test('a grade description alone recovers the number', () => {
  assert.deepEqual(detectGrade('NM-MT'), { grade: 8, label: 'NM-MT' })
  assert.deepEqual(detectGrade('GEM MT'), { grade: 10, label: 'GEM MT' })
})

test('longer grade words are not shadowed by their suffixes', () => {
  assert.equal(detectGrade('GEM MT 10').label, 'GEM MT')
  assert.equal(detectGrade('NM-MT 8').label, 'NM-MT')
})

test('a company beside a bare number is a grade', () => {
  assert.equal(detectGrade('BGS 9.5').grade, 9.5)
  assert.equal(detectGrade('PSA 10').grade, 10)
})

test('cert numbers take only their own shape', () => {
  assert.equal(detectCert('09472817'), '09472817')
  // A year or a card number is not a cert.
  assert.equal(detectCert('1989 #1'), undefined)
  assert.equal(detectCert('23/99'), undefined)
})

test('a raw card is never mistaken for a slab', () => {
  assert.equal(parseSlabLabel(['Ken Griffey Jr.', 'SEATTLE MARINERS', '#1', '© 1989']), null)
  assert.equal(looksLikeSlab(['2023 PANINI PRIZM', 'SILVER PRIZM', '23/99']), false)
})

test('a company with no grade at all is refused', () => {
  // A shop sleeve or a logo, not a graded card.
  assert.equal(parseSlabLabel(['PSA', 'CARD SHOP']), null)
})

test('an AUTHENTIC slab is a slab even with no number', () => {
  const read = parseSlabLabel(['PSA', 'AUTHENTIC', '12345678'])
  assert.equal(read.grade.grade, 0)
  assert.equal(read.grade.label, 'AUTHENTIC')
})

test('qualifiers survive, because a graded 8(OC) is not an 8', () => {
  const read = parseSlabLabel(['PSA', 'NM-MT 8', 'OC', '11223344'])
  assert.equal(read.grade.qualifier, 'OC')
})

test('confidence rises with the evidence actually present', () => {
  const full = parseSlabLabel(['PSA', 'GEM MT 10', '09472817'])
  const noCert = parseSlabLabel(['PSA', 'GEM MT 10'])
  assert.ok(full.confidence > noCert.confidence)
})

test('a grade is written the way collectors write it', () => {
  assert.equal(gradeShort({ company: 'PSA', grade: 10 }), 'PSA 10')
  assert.equal(gradeShort({ company: 'PSA', grade: 0 }), 'PSA AUTH')
  assert.equal(gradeLabel({ company: 'PSA', grade: 8, label: 'NM-MT', qualifier: 'OC' }), 'PSA 8(OC) NM-MT')
})
