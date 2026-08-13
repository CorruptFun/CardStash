import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

// pokemon.ts against a stubbed network: dead pokemontcg.io primary, tiny
// multi-language TCGdex with the real ja size collision (sv4K/sv4M both 66).
const HERE = fileURLToPath(new URL('.', import.meta.url))
const { matchPokemon, pokemonByCollector, pokemonById } = await bundleImport('src/lib/pokemon.ts', {
  alias: { './fetchJson': join(HERE, 'stubs', 'tcgdex-net.mjs') },
})

test('ja collector line with printed set code pins the Japanese card', async () => {
  const card = await pokemonByCollector('046', '66', undefined, 'SV4K')
  assert.ok(card, 'expected a card')
  assert.equal(card.name, 'トドロクツキex')
  assert.equal(card.setCode, 'SV4K')
  assert.equal(card.apiId, 'dex-ja:sv4K-046')
})

test('size collision without a set code refuses to guess', async () => {
  // 046/066 exists in BOTH sv4K and sv4M — a confident pick would be a
  // coin-flip wearing a certainty costume.
  assert.equal(await pokemonByCollector('046', '66'), null)
})

test('unique size without a code still answers', async () => {
  // Only sv4K carries 045.
  const card = await pokemonByCollector('045', '66')
  assert.ok(card)
  assert.equal(card.apiId, 'dex-ja:sv4K-045')
})

test('localized (German) name resolves to the EN card via the shared id', async () => {
  const card = await matchPokemon('Glurak', null, null, undefined, null, true)
  assert.ok(card, 'expected a card')
  assert.equal(card.name, 'Charizard')
  assert.equal(card.apiId, 'dex-base1-4')
})

test('junk reads never reach the language sweep', async () => {
  assert.equal(await matchPokemon('4) 2 x1', null, null, undefined, null, true), null)
})

test('language-routed dex ids refresh from their own catalog', async () => {
  const card = await pokemonById('dex-ja:sv4K-046')
  assert.ok(card)
  assert.equal(card.name, 'トドロクツキex')
  assert.equal(card.apiId, 'dex-ja:sv4K-046')
  const en = await pokemonById('dex-base1-4')
  assert.ok(en)
  assert.equal(en.name, 'Charizard')
})

test('fused fraction identifies only with full set-code corroboration', async () => {
  // Code + size + membership agree → the JP card answers.
  const hit = await pokemonByCollector('046', '66', undefined, 'SV4K', true)
  assert.ok(hit)
  assert.equal(hit.apiId, 'dex-ja:sv4K-046')
  // No code → refuse; wrong size for the coded set → refuse.
  assert.equal(await pokemonByCollector('046', '66', undefined, undefined, true), null)
  assert.equal(await pokemonByCollector('046', '99', undefined, 'SV4K', true), null)
})

test('the language sweep stays OFF unless the caller committed to Pokémon', async () => {
  // In auto mode four games fan out per OCR candidate; five extra language
  // queries there spend the attempt's shared lookup budget before a later,
  // cleaner read is ever queried (measured on the matrix as a lost MTG cell).
  const { requested } = await import('./stubs/tcgdex-net.mjs')
  requested.length = 0
  assert.equal(await matchPokemon('Glurak'), null)
  assert.ok(
    !requested.some((u) => /\/v2\/(de|fr|es|it|pt)\//.test(u)),
    `no localized queries expected, got: ${requested.filter((u) => /\/v2\/[a-z]{2}\//.test(u)).join(', ')}`,
  )
})
