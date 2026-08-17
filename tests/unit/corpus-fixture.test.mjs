import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { corpusFromFixture } from '../corpus/corpus.mjs'
import { compressPoliteWaits, loadMatchers, sealNetwork } from '../corpus/harness.mjs'
import { ladderFor } from '../corpus/ladder.mjs'

/*
 * The corpus sweep on twenty cards.
 *
 * The full sweep runs against 170,000 printings downloaded from three bulk
 * feeds, which makes it a fine instrument and a poor test: nothing about it
 * can be checked by reading. This is the same machinery — the same index
 * builders, the same corpus-backed API stub, the same shipped matchers — on a
 * catalog small enough to hold in your head, so a disagreement about a
 * finding can be settled here rather than in a 170k-row report.
 *
 * Everything asserted below is a claim the full sweep also makes.
 */

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../corpus/fixtures/mini-corpus.json', import.meta.url)), 'utf8'),
)

const liveAttempts = sealNetwork()
compressPoliteWaits()
corpusFromFixture(fixture)
const app = await loadMatchers()

const nameOf = (card) => card?.name ?? null
const CARDS = [
  ...fixture.mtg.map((p) => ({ game: 'mtg', name: p.name, apiId: p.apiId })),
  ...fixture.pokemon.prints.map((p) => ({ game: 'pokemon', name: p.name, apiId: p.apiId })),
  ...fixture.yugioh.map((c) => ({ game: 'yugioh', name: c.name, apiId: String(c.id) })),
]

test('the fixture is twenty cards and every game is fed', () => {
  // Assert the corpus can feed what is measured BEFORE measuring it — a game
  // with no rows reports a flawless zero (scan-harness lesson 82).
  assert.equal(CARDS.length, 20)
  assert.equal(CARDS.filter((c) => c.game === 'mtg').length, 4)
  assert.equal(CARDS.filter((c) => c.game === 'pokemon').length, 12)
  assert.equal(CARDS.filter((c) => c.game === 'yugioh').length, 4)
})

test('every card finds itself by its own printed name', async () => {
  for (const card of CARDS) {
    const found = await app.matchGame(card.game, card.name, null, null, {})
    assert.equal(
      app.normalizeName(nameOf(found) ?? ''),
      app.normalizeName(card.name),
      `${card.game} ${card.apiId}: "${card.name}" answered ${JSON.stringify(nameOf(found))}`,
    )
  }
})

test('a case-folded name still finds itself', async () => {
  // Name plates are read in caps far more often than in title case.
  for (const card of CARDS) {
    const found = await app.matchGame(card.game, card.name.toUpperCase(), null, null, {})
    assert.equal(app.normalizeName(nameOf(found) ?? ''), app.normalizeName(card.name), `${card.game} ${card.name}`)
  }
})

test('hyphenation is survivable — the Tauros-GX class is fixed', async () => {
  // A hyphen read as a space used to find nothing at all: the contains-search
  // has zero tolerance. Both separated spellings now land the GX card — and,
  // more importantly, neither lands the plain Tauros standing beside it in the
  // same set, which is what a wrong answer here would have cost.
  for (const read of ['Tauros GX', 'Tauros-GX']) {
    assert.equal(nameOf(await app.matchGame('pokemon', read, null, null, {})), 'Tauros-GX', `read "${read}"`)
  }
  // The fully-joined form is a different matter and is honest about it: with
  // the separator gone entirely there is no word left to recover from, and the
  // matcher REFUSES rather than answering the species. A refusal is a pass.
  assert.equal(await app.matchGame('pokemon', 'TaurosGX', null, null, {}), null)
})

test('a dropped suffix answers the bare card — bucketed, not fixed here', async () => {
  // THE finding this whole harness exists to size. A dropped two-letter
  // suffix is not a weak read: it is a perfect read of a different, cheaper
  // card. The pipeline's defence is the rules box (`parsePokemonVariant` in
  // corner.ts), which needs a frame — so at the matcher layer, where there is
  // no frame, this is the documented behaviour and the sweep counts it.
  const found = await app.matchGame('pokemon', 'Krookodile', null, null, {})
  assert.equal(nameOf(found), 'Krookodile')
  assert.equal(app.nameScore('Krookodile', 'Krookodile'), 1, 'a perfect score on the wrong card, when the card in hand was the ex')
  // Mega is the same trap moved to the front of the name.
  const mega = await app.matchGame('pokemon', 'Darkrai ex', null, null, {})
  assert.equal(nameOf(mega), 'Darkrai ex', 'the ex sibling must not be answered by the Mega')
})

test('a mangled "ex" still reaches the ex — the suffix survives being smudged', async () => {
  // "@x" normalises away to "krookodile x", which is one edit from
  // "krookodile ex" and two from "krookodile": the ranking gets this right.
  assert.equal(nameOf(await app.matchGame('pokemon', 'Krookodile @x', null, null, {})), 'Krookodile ex')
})

test('a mangled "V" answers a DIFFERENT sibling with a perfect score', async () => {
  // The crime class, reproduced. A single-letter suffix has no substance to
  // survive mangling: "Rayquaza \\/" normalises to exactly "rayquaza", which
  // IS a real card — so the answer is not a weak match to be thresholded away,
  // it is a flawless match to the wrong, cheaper card.
  //
  // The full sweep finds this shape in the wild (Hisuian Zoroark V → Hisuian
  // Zoroark, score 1.000) on BOTH Pokémon arms independently.
  const read = 'Rayquaza \\/'
  const found = await app.matchGame('pokemon', read, null, null, {})
  assert.equal(nameOf(found), 'Rayquaza', 'expected the bare card, which is the bug')
  assert.equal(app.nameScore(read, nameOf(found)), 1)
  assert.ok(
    app.nameScore(read, nameOf(found)) >= app.matchThresholdFor(read),
    'no threshold in identify.ts can question a 1.0',
  )
})

test('Yu-Gi-Oh codes still resolve without their region and without their padding', async () => {
  // The EN-prefix and zero-padding classes, which `codeCandidates` in ygo.ts
  // exists to cover. All four spellings of one printing must land the card.
  for (const typed of ['LOB-EN001', 'LOB-001', 'LOB-1', 'lob en1']) {
    const code = app.parseCardCode(typed)
    assert.ok(code, `parseCardCode refused "${typed}"`)
    const hits = await app.searchByCode('yugioh', code, {})
    assert.equal(hits[0]?.name, 'Blue-Eyes White Dragon', `typed "${typed}"`)
  }
})

test('an MTG code resolves whether or not the number is zero-padded', async () => {
  // searchByCode tries `code.number` AND `code.digits` for MTG, so a card
  // Scryfall numbers "78" is reachable by either spelling. This is exactly the
  // line the Pokémon branch below is missing.
  for (const typed of ['ISD 078', 'ISD 78']) {
    const hits = await app.searchByCode('mtg', app.parseCardCode(typed), {})
    assert.equal(hits[0]?.name, 'Snapcaster Mage', `typed "${typed}"`)
  }
})

test('a zero-padded Pokémon code resolves by its printed form', async () => {
  // Fixed 2026-08-17: `searchByCode` now hands Pokémon the printed form
  // (`code.number`), and `pokemonBySetNumber` tries its padded and unpadded
  // spellings — so a card printed "021" is reachable by the code on it.
  // Corpus gate for the fix: exact 14,696 → 17,611, empty 2,802 → 0,
  // wrong-card 180 → 83, wrong-printing 16 → 0, zero regressions.
  const padded = await app.searchByCode('pokemon', app.parseCardCode('ME01 021'), {})
  const unpadded = await app.searchByCode('pokemon', app.parseCardCode('ME01 21'), {})
  assert.equal(unpadded.length, 0, 'the card prints "021"; "21" is not its number either')
  assert.ok(padded.length > 0, 'the padded form is queried and the card is reachable by its printed code')
})

test('a lettered collector number keeps its letters', async () => {
  // "COL1 SL5" once collapsed to digits "5" and answered Forretress — a
  // wrong card, not a miss. The printed form now travels whole, and the
  // live catalog confirms col1-SL5 is Ho-Oh (verified 2026-08-17).
  const hits = await app.searchByCode('pokemon', app.parseCardCode('COL1 SL5'), {})
  assert.equal(hits[0]?.name, 'Ho-Oh')
  assert.notEqual(hits[0]?.name, 'Forretress')
})

test('the ladder drives the real matcher end to end', async () => {
  // The sweep's inner loop, in miniature: no rung may answer a confidently
  // different card except through a mechanism the report names.
  const surprises = []
  for (const card of CARDS) {
    for (const { rung, query } of ladderFor(card.name, card.apiId)) {
      if (query == null || rung === 'suffix-drop' || rung === 'suffix-mangle') continue
      const found = await app.matchGame(card.game, query, null, null, {})
      if (!found) continue
      if (app.normalizeName(found.name) === app.normalizeName(card.name)) continue
      if (app.nameScore(query, found.name) >= app.matchThresholdFor(query)) {
        surprises.push(`${card.game} "${card.name}" --${rung}--> "${query}" answered "${found.name}"`)
      }
    }
  }
  assert.deepEqual(surprises, [], `confident wrong cards outside the suffix rungs:\n${surprises.join('\n')}`)
})

test('the sweep touches no live network', () => {
  assert.deepEqual(liveAttempts, [], 'the corpus IS the catalog — a live call means an unstubbed path')
  assert.deepEqual(globalThis.__CARDSTOCK_STUB__?.unstubbed ?? [], [], 'an unrecognised endpoint is a silent no-op waiting to happen')
})
