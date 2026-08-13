import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const { collectorLineAllows } = await bundleImport('src/lib/corner.ts')
const { nameCandidates } = await bundleImport('src/lib/ocr.ts', {
  external: ['tesseract.js/dist/tesseract.esm.min.js'],
})

/*
 * The auto sweep matches a read across several games at once and keeps the
 * best-scoring answer, so a game that fails to answer cedes its card to
 * whatever else fuzzy-matched the OCR. These are the two guards that stop a
 * Pokémon card coming back as a Yu-Gi-Oh one: the printed collector line
 * (which shape-wise cannot belong to a code game), and the floor on what is
 * worth looking up at all.
 */

test('a printed set-size fraction rules out the code games', () => {
  // Real strip reads off the scan matrix's Pokémon fixtures.
  for (const strip of [
    'A ——— | Bos Shon G A Poremor GX me | £> 156/149 | EA EE |',
    'SVI EN 123/198\n© 2023 Pokémon',
    'VEN + 120/166 « EN / Kudos Productions',
    '266/302 =>',
  ]) {
    assert.equal(collectorLineAllows('yugioh', strip), false, strip)
    assert.equal(collectorLineAllows('onepiece', strip), false, strip)
    assert.equal(collectorLineAllows('digimon', strip), false, strip)
    // The fraction games themselves are never ruled out by it.
    assert.equal(collectorLineAllows('pokemon', strip), true, strip)
    assert.equal(collectorLineAllows('mtg', strip), true, strip)
    assert.equal(collectorLineAllows('riftbound', strip), true, strip)
  }
})

test('genuine Yu-Gi-Oh printing is never ruled out', () => {
  // Passcode, set-dash code and the ATK/DEF pair: no digit-slash-digit
  // anywhere, which is why the fraction rule cannot misfire on them.
  for (const strip of [
    '89631139',
    'LOB-EN001',
    'ATK/2500 DEF/2000',
    'ATK/ 1200 DEF/ 800',
    '[Dragon/Normal] ATK/3000 DEF/2500\n89631139',
  ]) {
    assert.equal(collectorLineAllows('yugioh', strip), true, strip)
  }
})

test('a strip that read nothing rules out nothing', () => {
  for (const strip of ['', '   ', 'Ee ~ | ~~', '4/4', '1/2']) {
    assert.equal(collectorLineAllows('yugioh', strip), true, strip)
    assert.equal(collectorLineAllows('pokemon', strip), true, strip)
  }
})

test('candidates too short to be a card name are never offered', () => {
  // trimTrailingJunk used to shed everything but a two-letter head; those
  // fragments cost a lookup against every game and can hit a real name
  // exactly in a big catalogue.
  const out = nameCandidates(['gr ee', 'or ae', 'a, TW'])
  for (const candidate of out) {
    assert.ok(
      (candidate.match(/[A-Za-z]/g) ?? []).length >= 3,
      `too short to be a card name: ${JSON.stringify(candidate)}`,
    )
  }
})

test('three-letter names still survive the floor', () => {
  // "Mew" and "Muk" are real cards people scan — the floor sits below them.
  const out = nameCandidates(['Mew', 'Muk ex'])
  assert.ok(out.includes('Mew'), JSON.stringify(out))
  assert.ok(
    out.some((c) => c.toLowerCase().startsWith('muk')),
    JSON.stringify(out),
  )
})
