import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

/*
 * "I scanned a Pokémon Tauros and it gave me a Yu-Gi-Oh card."
 *
 * The auto sweep looks one OCR read up against several games at once and keeps
 * the best-scoring answer. Nothing in that comparison knows which game the
 * card in the frame belongs to — so when the card's own API fails to answer
 * (pokemontcg.io 500s routinely) and another game's catalogue happens to
 * contain the fragment, the card is handed to that game with full confidence.
 * In collect mode it is then added to the collection at the wrong game's price.
 *
 * These tests pin the mechanism and the guard that now stops it.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const netStub = join(HERE, 'stubs', 'crossgame-net.mjs')

const { bestMatchAcrossGames } = await bundleImport('src/lib/cardsearch.ts', {
  alias: { './fetchJson': netStub },
})
const { collectorLineAllows } = await bundleImport('src/lib/corner.ts')
const { COLLIDING_READ } = await import(`file://${netStub}`)

/** The bottom strip of the Tauros GX fixture, as the scanner really read it. */
const TAUROS_STRIP = 'A ——— | Bos Shon G A Poremor GX me | £> 156/149 | EA EE |'

test('the sweep hands a Pokémon card to Yu-Gi-Oh when Pokémon cannot answer', async () => {
  // This is the bug as reported, reproduced: the read is a fragment lifted off
  // a Pokémon card, Pokémon's API is down, and Yu-Gi-Oh's substring search
  // holds a card by exactly that name.
  const best = await bestMatchAcrossGames(COLLIDING_READ, ['mtg', 'pokemon', 'yugioh'])
  assert.ok(best, 'expected the sweep to return something')
  assert.equal(best.card.game, 'yugioh')
  // A perfect name score: past every threshold the pipeline applies, which is
  // why this surfaced to the user as a confident identification.
  assert.equal(best.score, 1)
})

test('the printed collector line rules that answer out', () => {
  // The card in the frame prints "156/149". No Yu-Gi-Oh card prints a set-size
  // fraction, so this answer cannot be right whatever it scored.
  assert.equal(collectorLineAllows('yugioh', TAUROS_STRIP), false)
})

test('the guard leaves a real Yu-Gi-Oh scan alone', () => {
  // Same sweep, a genuine Yu-Gi-Oh card in frame: passcode and ATK/DEF, no
  // fraction anywhere, so nothing is ruled out and the match stands.
  const ygoStrip = '[Spellcaster / Normal]\nATK/2500 DEF/2100\n46986414'
  assert.equal(collectorLineAllows('yugioh', ygoStrip), true)
})
