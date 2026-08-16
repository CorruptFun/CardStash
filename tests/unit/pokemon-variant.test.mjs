import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

/*
 * "It said Tauros. The card is Tauros GX, and they are not the same price."
 *
 * Pokémon suffix variants are the pipeline's most expensive confusion, and
 * the reason is that nothing about the failure looks weak. Drop the "GX" off
 * a read and what remains — "Tauros" — is a real card, matched EXACTLY, at
 * score 1.0. Every quality-scaled threshold in the matcher exists to reject
 * poor fits, and this is a perfect fit to the wrong card, so no bar can see
 * it. Only other evidence can.
 *
 * The collector line is the designed arbiter and it is also the smallest type
 * on the card; on the cell that produced this wrong card it read nothing at
 * all. But the card declares itself a second time in sentence-sized type, in
 * the rules box ("Pokémon-GX rule"), which the pipeline was already reading
 * and throwing away.
 *
 * These tests pin the parser and — the half that matters — its SILENCE. A
 * false "ex" would manufacture exactly the wrong-card class this removes, so
 * the negative cases are the load-bearing ones.
 */

const { parsePokemonVariant, pokemonNameSuffix, parsePokemonMega, pokemonNameMega } =
  await bundleImport('src/lib/corner.ts')

test('reads the suffix a card declares in its rules box', () => {
  assert.equal(parsePokemonVariant('Pokémon-GX rule: When your Pokémon-GX is Knocked Out'), 'GX')
  assert.equal(
    parsePokemonVariant('VMAX rule When your Pokémon VMAX is Knocked Out, your opponent takes 3 Prize cards.'),
    'VMAX',
  )
  assert.equal(parsePokemonVariant('VSTAR Power — once per game'), 'VSTAR')
  assert.equal(parsePokemonVariant('When your Pokémon ex is Knocked Out, your opponent takes 2 Prize cards.'), 'ex')
  assert.equal(parsePokemonVariant('When your Pokémon V is Knocked Out, your opponent takes 2 Prize cards.'), 'V')
})

test('survives the OCR noise these lines actually arrive with', () => {
  // Verbatim from harness traces of the cell that produced the wrong card.
  assert.equal(parsePokemonVariant('Hus. 5bon Graphics Pokémon-GX rule -\nPokémon-G Xx'), 'GX')
  assert.equal(
    parsePokemonVariant('lito NKENCHIRAYTO) JAX rule When your Pokémon VMAX J)\n0) 8 Zpem i is Knocked Out'),
    'VMAX',
  )
})

test('VMAX and VSTAR are never read as V', () => {
  // "Pokémon V" is a prefix of both, so rule order is load-bearing.
  assert.equal(parsePokemonVariant('When your Pokémon VMAX is Knocked Out'), 'VMAX')
  assert.equal(parsePokemonVariant('When your Pokémon VSTAR is Knocked Out'), 'VSTAR')
})

test('stays silent on a card with no variant rules box', () => {
  // The whole guard rests on this: a plain card must never be "upgraded".
  // Verbatim bottom-strip reads from the charizard-base fixture's traces.
  assert.equal(parsePokemonVariant('weakness resistance retreat\n©1999 Wizards of the Coast'), null)
  assert.equal(parsePokemonVariant('Illus. Mitsuhiro Arita  4/102'), null)
  assert.equal(parsePokemonVariant(''), null)
  assert.equal(parsePokemonVariant('Basic Pokémon put onto the Bench'), null)
})

test('a bare "ex" or "gx" elsewhere on the card is not a declaration', () => {
  // The anchor is the word Pokémon (or "rule"/"power") beside the marker —
  // loose token matching would fire on flavour text and attack names.
  assert.equal(parsePokemonVariant('Expert Belt'), null)
  assert.equal(parsePokemonVariant('exchange a card in your hand'), null)
  assert.equal(parsePokemonVariant('next turn, this attack does 60 more damage'), null)
})

/*
 * Mega (2026) is the same trap as a suffix, on a PREFIX — and it broke the
 * guard above from the inside. "Darkrai", "Darkrai ex" and "Mega Darkrai ex"
 * are three cards at three prices; a read of "Darkrai" off the third, plus a
 * rules box declaring ex, made the guard swap to "Darkrai ex" — the guard
 * built to prevent wrong cards produced one, because the right answer was not
 * in its vocabulary. Same contract, same emphasis: the negative cases are the
 * load-bearing ones, because a false Mega REFUSES a correct match.
 */

test('the Mega header declares ex by itself', () => {
  // The 2026 rule body says "your Mega Evolution ex", never "your Pokémon ex",
  // so without the header row the variant parser is silent on a Mega frame.
  assert.equal(
    parsePokemonVariant('Mega Evolution ex rule: When your Mega Evolution ex is Knocked Out, your opponent takes 3 Prize cards.'),
    'ex',
  )
})

test('reads the Mega the rules box declares', () => {
  assert.equal(
    parsePokemonMega('Mega Evolution ex rule: When your Mega Evolution ex is Knocked Out, your opponent takes 3 Prize cards.'),
    true,
  )
  // XY-era M cards print their own phrasing.
  assert.equal(
    parsePokemonMega('Mega Evolution Rule: When 1 of your Pokémon becomes a Mega Evolution Pokémon, your turn ends.'),
    true,
  )
  // OCR fuses words; flattening plus \s* must still see the phrase.
  assert.equal(parsePokemonMega('MegaEvolution ex rule When your Mega-Evolution ex is Knocked Out'), true)
})

test('a "Mega Evolution" mention outside the rule is not a declaration', () => {
  // Mega Turbo (a trainer) names the mechanic in its effect text.
  assert.equal(
    parsePokemonMega('Attach a basic Energy card from your discard pile to 1 of your Mega Evolution Pokémon.'),
    false,
  )
  // A plain ex rules box declares ex, never Mega.
  assert.equal(parsePokemonMega('When your Pokémon ex is Knocked Out, your opponent takes 2 Prize cards.'), false)
  assert.equal(parsePokemonMega(''), false)
  assert.equal(parsePokemonMega('weakness resistance retreat\n©1999 Wizards of the Coast'), false)
})

test('knows which names already carry Mega', () => {
  // Modern names lead with the word; the XY-era catalog abbreviates it.
  assert.equal(pokemonNameMega('Mega Darkrai ex'), true)
  assert.equal(pokemonNameMega('M Charizard-EX'), true)
  // Species whose NAME merely starts with the letters: never Mega.
  assert.equal(pokemonNameMega('Meganium'), false)
  assert.equal(pokemonNameMega('Darkrai'), false)
  assert.equal(pokemonNameMega('Darkrai ex'), false)
  assert.equal(pokemonNameMega('Mr. Mime'), false)
})

test('knows which names already carry a suffix', () => {
  // The guard fires only when the matched name has NO suffix, so that a name
  // band which DID read one is left alone.
  assert.equal(pokemonNameSuffix('Tauros'), null)
  assert.equal(pokemonNameSuffix('Charizard'), null)
  assert.equal(pokemonNameSuffix('Tauros GX'), 'gx')
  assert.equal(pokemonNameSuffix('Pikachu ex'), 'ex')
  assert.equal(pokemonNameSuffix('Umbreon VMAX'), 'vmax')
  assert.equal(pokemonNameSuffix("Iono's Bellibolt ex"), 'ex')
  // Not a suffix: the marker has to be the LAST word.
  assert.equal(pokemonNameSuffix('Ex-Machina Test'), null)
})
