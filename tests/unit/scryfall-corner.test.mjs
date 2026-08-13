import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

// mtgBySetNumber is the MTG language-independent path: it is the SOLE
// evidence when no name could be read, so its refusals matter as much as
// its hits.
const HERE = fileURLToPath(new URL('.', import.meta.url))
const { mtgBySetNumber } = await bundleImport('src/lib/scryfall.ts', {
  alias: { './fetchJson': join(HERE, 'stubs', 'scryfall-net.mjs') },
})

test('exact set + collector number resolves the print', async () => {
  const card = await mtgBySetNumber('NEO', '266')
  assert.ok(card)
  assert.equal(card.name, 'Boseiju, Who Endures')
  assert.equal(card.setCode, 'NEO')
})

test('a printed fraction must agree with the set’s real size', async () => {
  // "266/302" — the genuine line.
  assert.ok(await mtgBySetNumber('NEO', '266', '302'))
  // "2886/7302" — the doubled-digit misread. Fail closed rather than let a
  // dense collector-number space hand back a plausible neighbour.
  assert.equal(await mtgBySetNumber('NEO', '266', '7302'), null)
  assert.equal(await mtgBySetNumber('NEO', '175', '202'), null)
})

test('unknown set or number answers nothing — never a fuzzy rescue', async () => {
  assert.equal(await mtgBySetNumber('ZZZ', '266'), null)
  assert.equal(await mtgBySetNumber('NEO', '9999'), null)
})
