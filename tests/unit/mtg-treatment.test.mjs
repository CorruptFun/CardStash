import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

// The frame-treatment vocabulary is what the scan's printing tie-break trades
// in: `treatmentOf` derives it from a Scryfall print, `asTreatment` coerces
// the model's answer to it, and `pickByTraits` matches the two. All three are
// pure, and the guard they carry — a re-pick only when a print with the SEEN
// frame exists — is exactly what keeps a full-art misread from becoming a
// confident swap to some other printing.
const HERE = fileURLToPath(new URL('.', import.meta.url))
const { asTreatment, treatmentOf, pickByTraits } = await bundleImport('src/lib/scryfall.ts', {
  alias: { './fetchJson': join(HERE, 'stubs', 'scryfall-net.mjs') },
})

const REGULAR = { id: 'a', set: 'msh', collector_number: '136', border_color: 'black', finishes: ['nonfoil', 'foil'] }
const BORDERLESS = { id: 'b', set: 'msh', collector_number: '321', border_color: 'borderless', finishes: ['nonfoil', 'foil'] }
const SHOWCASE = { id: 'c', set: 'msh', collector_number: '400', border_color: 'black', frame_effects: ['showcase'], finishes: ['foil'] }

test('treatmentOf reads the frame off a print', () => {
  assert.equal(treatmentOf(REGULAR), 'regular')
  assert.equal(treatmentOf(BORDERLESS), 'borderless')
  assert.equal(treatmentOf({ ...REGULAR, full_art: true }), 'borderless')
  assert.equal(treatmentOf(SHOWCASE), 'showcase')
  assert.equal(treatmentOf({ ...REGULAR, frame_effects: ['extendedart'] }), 'extended')
  assert.equal(treatmentOf({ ...REGULAR, frame: '1997' }), 'retro')
})

test('asTreatment keeps the vocabulary and drops everything else', () => {
  assert.equal(asTreatment('Borderless'), 'borderless')
  assert.equal(asTreatment('  retro '), 'retro')
  // An unrecognised answer must become "no opinion", never a value
  // `pickByTraits` would read as "matches no print at all".
  assert.equal(asTreatment('full-art'), undefined)
  assert.equal(asTreatment(''), undefined)
  assert.equal(asTreatment(null), undefined)
  assert.equal(asTreatment(7), undefined)
})

test('a seen frame picks that printing, not the base one', () => {
  const picked = pickByTraits([REGULAR, BORDERLESS, SHOWCASE], { treatment: 'borderless', foil: true })
  assert.equal(picked.id, BORDERLESS.id)
})

test('the frame dominates the sheen — a borderless card that reads non-foil still picks borderless', () => {
  const picked = pickByTraits([REGULAR, BORDERLESS], { treatment: 'borderless', foil: false })
  assert.equal(picked.id, BORDERLESS.id)
})

test('no printing carries the seen frame, so nothing is re-picked', () => {
  // The tie-break also re-checks `treatmentOf(picked) === wanted`; this is the
  // half that must hold inside the picker itself.
  const picked = pickByTraits([REGULAR], { treatment: 'showcase', foil: true })
  assert.equal(picked, null)
})

test('"regular" is not an instruction — it leaves the local answer alone', () => {
  // The tie-break never asks with a regular treatment (that is what the fuzzy
  // match already assumed); if it ever did, the picker must not go hunting.
  assert.equal(pickByTraits([REGULAR, BORDERLESS], { treatment: 'regular' }), null)
  assert.equal(pickByTraits([REGULAR, BORDERLESS], {}), null)
})
