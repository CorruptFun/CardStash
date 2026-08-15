import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

// "Right card, wrong version" — the failure the scan matrix cannot see,
// because it grades the NAME. pokemontcg.io is stale: it answers for
// "Trubbish" and has never indexed the 86-card set actually printed on the
// card, so the newest Trubbish it knows (Fusion Strike #168) is what a
// name-only match returns.
const HERE = fileURLToPath(new URL('.', import.meta.url))
const { matchPokemon, pokemonPrintings } = await bundleImport('src/lib/pokemon.ts', {
  alias: { './fetchJson': join(HERE, 'stubs', 'pokemon-stale.mjs') },
})

test('the printed collector line pins the edition the primary never indexed', async () => {
  const card = await matchPokemon('Trubbish', null, '56', undefined, '86')
  assert.ok(card, 'expected a card')
  assert.equal(card.name, 'Trubbish')
  assert.equal(card.setName, 'Chaos Rising')
  assert.equal(card.number, '056')
  assert.equal(card.apiId, 'dex-me04-056')
})

test('the printed set size alone is enough — the number need not read', async () => {
  const card = await matchPokemon('Trubbish', null, null, undefined, '86')
  assert.equal(card?.setName, 'Chaos Rising')
})

test('a name with no collector line still answers (the edition is a guess)', async () => {
  // Unchanged behaviour, and the reason the refine path matters: with nothing
  // printed to go on, the newest edition the catalog lists is all there is.
  const card = await matchPokemon('Trubbish')
  assert.equal(card?.number, '168')
})

test('a collector line no catalog can honour refuses rather than swapping in another edition', async () => {
  // Neither half of "77/999" matches anything either catalog holds, so every
  // remaining candidate contradicts the card in frame — and answering with
  // one anyway is exactly how "#168" gets reported for a card reading
  // "056/086". Refusing leaves the name match alone; it never claims the
  // printed line agreed with it.
  assert.equal(await matchPokemon('Trubbish', null, '77', undefined, '999'), null)
})

test('a readable number still answers when only the set size misread', async () => {
  // Strictly narrowing: the number is the harder half, and TCGdex set sizes
  // do drift from the denominator a card prints.
  const card = await matchPokemon('Trubbish', null, '56', undefined, '999')
  assert.equal(card?.name, 'Trubbish')
  assert.equal(card?.number, '056')
})

test('printings list carries the editions the stale primary is missing', async () => {
  const prints = await pokemonPrintings('Trubbish')
  const ids = prints.map((c) => c.apiId)
  // Without the TCGdex merge the sheet could not be corrected at all: the
  // copy in the user's hand was not among the options.
  assert.ok(ids.includes('dex-me04-056'), `Chaos Rising missing from ${ids.join(', ')}`)
  assert.ok(ids.includes('swsh8-168'), 'primary printings must survive')
  // Newest first — what the primary lacks IS the newest.
  assert.equal(ids[0], 'dex-me04-056')
})

test('printings list never doubles a card both catalogs know, nor lists TCG Pocket', async () => {
  const prints = await pokemonPrintings('Trubbish')
  const ids = prints.map((c) => c.apiId)
  assert.equal(ids.filter((id) => id.endsWith('sm9-56')).length, 1, `duplicate Team Up print in ${ids.join(', ')}`)
  assert.ok(!ids.some((id) => id.includes('A1-097')), 'TCG Pocket cards are not printings')
})
