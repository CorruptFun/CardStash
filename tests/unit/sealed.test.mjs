import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

// identifySealedText end-to-end against a stubbed two-set catalog — the JP
// "Ancient Roar" scenario a real pack scan produces (kanji reads as junk,
// only the brand word and the printed set code survive OCR).
const HERE = fileURLToPath(new URL('.', import.meta.url))
const { identifySealedText } = await bundleImport('src/lib/sealed.ts', {
  alias: { './tcgcsv': join(HERE, 'stubs', 'tcgcsv-sealed.mjs') },
})

test('Japanese pack: set code + junk lines resolve to the JP booster pack', async () => {
  const match = await identifySealedText(['Pokémon', 'AAT 2 R', '(sv4K', '5 BU'], ['pokemon'])
  assert.ok(match, 'expected a sealed match')
  assert.equal(match.game, 'pokemon')
  assert.equal(match.group.name, 'SV4K: Ancient Roar')
  // Nothing on a JP pack front says "booster", so the lone-pack default must
  // pick the pack over the box.
  assert.equal(match.card.name, 'Scarlet & Violet: Ancient Roar Booster Pack (Japanese)')
  assert.ok(match.score >= 0.72)
})

test('English box: set name + box wording still picks the English box', async () => {
  const match = await identifySealedText(['POKEMON TCG', 'SURGING SPARKS', '36 Booster Packs'], ['pokemon'])
  assert.ok(match)
  assert.equal(match.group.name, 'SV08: Surging Sparks')
  assert.equal(match.card.name, 'Scarlet & Violet: Surging Sparks Booster Box')
})

test('unreadable junk alone matches nothing', async () => {
  const match = await identifySealedText(['AAT 2 R', '5 BU', 'xx yy'], ['pokemon'])
  assert.equal(match, null)
})
