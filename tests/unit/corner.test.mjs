import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const { parseCornerInfo, parsePasscode, sameYgoCode } = await bundleImport('src/lib/corner.ts')

test('pokemon: SV-era collector line with set code', () => {
  const read = parseCornerInfo('pokemon', 'SVI EN 123/198\n© 2023 Pokémon')
  assert.equal(read.number, '123')
  assert.equal(read.total, '198')
  assert.equal(read.setCode, 'SVI')
})

test('pokemon: secret-rare fraction with zero padding', () => {
  const read = parseCornerInfo('pokemon', 'garbage 096/086 more')
  assert.equal(read.number, '96')
  assert.equal(read.total, '86')
})

test('pokemon: promo code', () => {
  assert.equal(parseCornerInfo('pokemon', 'SWSH 250').number, 'SWSH250')
})

test('pokemon: fused fraction — OCR ate the slash — is marked as reconstructed', () => {
  const read = parseCornerInfo('pokemon', '© 156149 Medea')
  assert.equal(read.number, '156')
  assert.equal(read.total, '149')
  assert.equal(read.fused, true)
  const padded = parseCornerInfo('pokemon', 'junk 096086')
  assert.equal(padded.number, '96')
  assert.equal(padded.total, '86')
  const slashed = parseCornerInfo('pokemon', 'SVI EN 123/198')
  assert.equal(slashed.fused, undefined)
})

test('mtg: P/T and token lines cannot poison the collector number', () => {
  assert.equal(parseCornerInfo('mtg', '4/4\n0269 M\nMH3 - EN').number, '269')
  assert.equal(parseCornerInfo('mtg', 'CREATE A 1/1 SOLDIER\n0269 M\nMH3 - EN').number, '269')
})

test('pokemon: a year is not a fused fraction', () => {
  assert.equal(parseCornerInfo('pokemon', '©2023 Pokémon').number, undefined)
})

test('mtg: modern collector line', () => {
  const read = parseCornerInfo('mtg', '0269 M\nMH3 • EN')
  assert.equal(read.number, '269')
  assert.equal(read.setCode, 'MH3')
})

test('mtg: legacy fraction line', () => {
  const read = parseCornerInfo('mtg', '269/350 U\nM21 • EN')
  assert.equal(read.number, '269')
  assert.equal(read.setCode, 'M21')
})

test('mtg: a copyright year is not a collector number', () => {
  assert.equal(parseCornerInfo('mtg', '™ & © 2023 Wizards').number, undefined)
})

test('yugioh: set code with language infix', () => {
  const read = parseCornerInfo('yugioh', 'LOB-EN001')
  assert.equal(read.number, 'LOB-EN001')
  assert.equal(read.setCode, 'LOB')
  assert.ok(sameYgoCode('LOB-EN001', 'LOB-001'))
  assert.ok(!sameYgoCode('LOB-EN001', 'LOB-002'))
})

test('onepiece: prefixed code with OCR gaps', () => {
  const read = parseCornerInfo('onepiece', 'OP01 - 016 junk')
  assert.equal(read.number, 'OP01-016')
  assert.equal(read.setCode, 'OP01')
})

test('riftbound: bare fraction pins the collector number', () => {
  const read = parseCornerInfo('riftbound', 'noise 045/298 λ')
  assert.equal(read.number, '45')
  assert.equal(read.total, '298')
})

test('lorcana: fraction plus language-adjacent set digit', () => {
  const read = parseCornerInfo('lorcana', '23/204 · EN · 1')
  assert.equal(read.number, '23')
  assert.equal(read.setCode, '1')
})

test('pokemon: Japanese set code beside the fraction', () => {
  const read = parseCornerInfo('pokemon', 'SV4K 046/066 U')
  assert.equal(read.number, '46')
  assert.equal(read.total, '66')
  assert.equal(read.setCode, 'SV4K')
  // Lowercase tail codes survive the uppercase pass ("S12a" prints as such).
  const older = parseCornerInfo('pokemon', 'S12a 046/100 C')
  assert.equal(older.setCode, 'S12A')
})

test('pokemon: language tokens and years never read as a set code', () => {
  assert.equal(parseCornerInfo('pokemon', 'JP 046/066').setCode, undefined)
  assert.equal(parseCornerInfo('pokemon', '2023 046/066').setCode, undefined)
})

test('mtg: Japanese print corner line', () => {
  const read = parseCornerInfo('mtg', '0266 R\nNEO・JA')
  assert.equal(read.number, '266')
  assert.equal(read.setCode, 'NEO')
})

test('yugioh: passcode parses in any language print, leading zeros dropped', () => {
  assert.equal(parsePasscode('ATK/2000 DEF/1700\n46986414'), '46986414')
  assert.equal(parsePasscode('07902349 © 1996'), '7902349')
})

test('yugioh: passcode rejects non-8-digit runs', () => {
  assert.equal(parsePasscode('123456789'), null) // nine digits — not a passcode
  assert.equal(parsePasscode('1234567'), null)
  assert.equal(parsePasscode('© 1996-2023 KONAMI'), null)
})

test('pokemon: slash read as a digit reconstructs a fused fraction', () => {
  const read = parseCornerInfo('pokemon', '(g) 0207066 RR')
  assert.equal(read.number, '20')
  assert.equal(read.total, '66')
  assert.equal(read.fused, true)
})

test('mtg: fraction read carries the total; padded solo is flagged', () => {
  const frac = parseCornerInfo('mtg', '266/302 R\nNEO・JP')
  assert.equal(frac.number, '266')
  assert.equal(frac.total, '302')
  assert.equal(frac.setCode, 'NEO')
  const solo = parseCornerInfo('mtg', '0269 M\nMH3 • EN')
  assert.equal(solo.padded, true)
  const bare = parseCornerInfo('mtg', '269 M\nMH3 • EN')
  assert.equal(bare.padded, undefined)
})

/*
 * The passcode has to survive whichever pass happened to read the bottom
 * strip. It is Yu-Gi-Oh's strongest identifier — the same eight digits in
 * every language, printed in plain black ink that no foil treatment touches —
 * and the pipeline used to parse it from ONE dedicated 7%-tall rectangle. On a
 * real secret-rare photograph that rectangle returned "" while the wider band
 * read moments earlier in the same attempt returned the digits perfectly, so
 * the card went unidentified with its own id sitting in the trace.
 */
test('yugioh: passcode is carried off any bottom-strip text', () => {
  assert.equal(parseCornerInfo('yugioh', '72444406 1" Edition O22)').passcode, '72444406')
  assert.equal(parseCornerInfo('yugioh', '1 72444406 I Edition ©2020').passcode, '72444406')
  // Alongside a set code, both survive — the code picks the printing, the
  // passcode picks the card.
  const both = parseCornerInfo('yugioh', 'PHNI-EN042 72444406 1st Edition')
  assert.equal(both.passcode, '72444406')
  assert.equal(both.number, 'PHNI-EN042')
})

test('yugioh: passcode stays absent unless eight digits actually read', () => {
  // A mangled read must resolve to nothing rather than to a neighbouring id.
  assert.equal(parseCornerInfo('yugioh', 'S741 788* L-dition').passcode, undefined)
  assert.equal(parseCornerInfo('yugioh', 'ATK/2900 DEF/2500').passcode, undefined)
  assert.equal(parseCornerInfo('yugioh', '©2020 Studio Dice/SHUEISHA').passcode, undefined)
  // Nine digits is not a passcode.
  assert.equal(parseCornerInfo('yugioh', '724444064 1st Edition').passcode, undefined)
})

test('other code games do not acquire a passcode', () => {
  // Only Yu-Gi-Oh prints one; an 8-digit run on a One Piece card is something
  // else and must not be handed to an id lookup.
  assert.equal(parseCornerInfo('onepiece', 'OP01-016 12345678').passcode, undefined)
})
