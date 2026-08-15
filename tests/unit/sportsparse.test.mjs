/**
 * The sports parser, held to by test.
 *
 * This module carries a risk none of the TCG matchers do: with no catalog to
 * answer to, a bad read does not pick the wrong card — it invents one. So the
 * cases below are as much about what the parser REFUSES to claim (a stat
 * fraction is not a serial, a team is not a player, a career column is not a
 * print year) as about what it reads.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const {
  parseSportsText,
  parseYear,
  parseSerial,
  parseCardNumber,
  detectBrand,
  detectProduct,
  detectParallel,
  detectTeam,
  detectSport,
  detectPlayer,
  sportsSlug,
  sportsSetName,
  slugPart,
} = await bundleImport('src/lib/sportsparse.ts')

/* --- year ---------------------------------------------------------------- */

test('a copyright line is definitive for the print year', () => {
  assert.equal(parseYear('© 1989 The Upper Deck Company').year, 1989)
  assert.equal(parseYear('(c) 2023 Panini America, Inc.').year, 2023)
})

test('a split season is captured as both a year and a season', () => {
  const read = parseYear('2023-24 Upper Deck Series One')
  assert.equal(read.year, 2023)
  assert.equal(read.season, '2023-24')
})

test('a career stat table does not become the print year', () => {
  // A back listing seasons plus the print year takes the latest, not the first.
  assert.equal(parseYear('1984 1985 1986 1987 TOTALS © 1988 Topps').year, 1988)
})

test('nonsense years are refused outright', () => {
  assert.equal(parseYear('BATTING 0350 AB 1899 RBI 3012').year, undefined)
})

/* --- serial -------------------------------------------------------------- */

test('serial numbering is read from the card face', () => {
  assert.deepEqual(parseSerial('23/99'), { num: 23, of: 99 })
  assert.deepEqual(parseSerial('SILVER PRIZM 1 / 25'), { num: 1, of: 25 })
})

test('a stat fraction is not a serial', () => {
  assert.equal(parseSerial('ERA 2.85 IP 210.1 AVG .300'), undefined)
  // num must sit inside the run
  assert.equal(parseSerial('150/99'), undefined)
})

test('the scarcer print run wins when several fractions appear', () => {
  assert.deepEqual(parseSerial('GAMES 12/162 SERIAL 04/10'), { num: 4, of: 10 })
})

/* --- card number --------------------------------------------------------- */

test('a marked card number beats anything else on the card', () => {
  assert.equal(parseCardNumber('#147'), '147')
  assert.equal(parseCardNumber('No. 1'), '1')
})

test('insert and update prefixes survive intact', () => {
  assert.equal(parseCardNumber('BCP-25'), 'BCP-25')
  assert.equal(parseCardNumber('card US150 of the update set'), 'US150')
})

/* --- vocabularies -------------------------------------------------------- */

test('brands and product lines are recognized, longest first', () => {
  assert.equal(detectBrand('2023 PANINI PRIZM BASKETBALL'), 'Panini')
  assert.equal(detectProduct('2021 Bowman Chrome Draft'), 'Bowman Chrome')
  assert.equal(detectProduct('Donruss Optic Rated Rookie'), 'Donruss Optic')
})

test('a colour only becomes a parallel next to a treatment word', () => {
  assert.equal(detectParallel('SILVER PRIZM'), 'Silver Prizm')
  assert.equal(detectParallel('Gold Refractor /50'), 'Gold Refractor')
  // "Gold" alone is branding, not a parallel.
  assert.equal(detectParallel('Vegas Golden Knights gold jersey'), undefined)
})

test('unambiguous teams name their own sport', () => {
  assert.deepEqual(detectTeam('SEATTLE MARINERS'), { team: 'Mariners', sport: 'baseball' })
  assert.deepEqual(detectTeam('Toronto Maple Leafs'), { team: 'Maple Leafs', sport: 'hockey' })
})

test('a shared nickname stays unresolved until a city settles it', () => {
  assert.deepEqual(detectTeam('CARDINALS'), { team: 'Cardinals' })
  assert.deepEqual(detectTeam('ARIZONA CARDINALS'), { team: 'Cardinals', sport: 'football' })
  assert.deepEqual(detectTeam('ST. LOUIS CARDINALS'), { team: 'Cardinals', sport: 'baseball' })
})

test('league marks and positions outrank every softer hint', () => {
  assert.equal(detectSport('OFFICIALLY LICENSED PRODUCT OF THE NFLPA'), 'football')
  assert.equal(detectSport('SHORTSTOP'), 'baseball')
  // No evidence at all is 'other', not a guess.
  assert.equal(detectSport('a completely blank card'), 'other')
})

/* --- player -------------------------------------------------------------- */

test('the player is chosen by elimination, not by position on the card', () => {
  const lines = ['2023 PANINI PRIZM', 'SAN ANTONIO SPURS', 'Victor Wembanyama', 'ROOKIE']
  assert.equal(detectPlayer(lines, { team: 'Spurs', brand: 'Panini', product: 'Prizm' }), 'Victor Wembanyama')
})

test('licensing boilerplate is never mistaken for a name', () => {
  const lines = ['OFFICIALLY LICENSED', 'ALL RIGHTS RESERVED', 'Printed In USA', 'Ken Griffey Jr.']
  assert.equal(detectPlayer(lines, {}), 'Ken Griffey Jr.')
})

test('a shouted name comes back readable', () => {
  assert.equal(detectPlayer(['MIKE TROUT'], {}), 'Mike Trout')
})

/* --- whole cards --------------------------------------------------------- */

test('a vintage back parses into a complete identity', () => {
  const parsed = parseSportsText([
    'Ken Griffey Jr.',
    'OUTFIELD',
    'SEATTLE MARINERS',
    '#1',
    '© 1989 The Upper Deck Company',
  ])
  assert.equal(parsed.player, 'Ken Griffey Jr.')
  assert.equal(parsed.year, 1989)
  assert.equal(parsed.brand, 'Upper Deck')
  assert.equal(parsed.number, '1')
  assert.equal(parsed.team, 'Mariners')
  assert.equal(parsed.sport, 'baseball')
  assert.ok(parsed.confidence > 0.8, `expected a confident read, got ${parsed.confidence}`)
})

test('a modern parallel keeps the treatment and the print run apart', () => {
  const parsed = parseSportsText([
    '2023 PANINI PRIZM',
    'Victor Wembanyama',
    'SAN ANTONIO SPURS',
    'SILVER PRIZM',
    '#136',
    '23/99',
    'RC',
  ])
  assert.equal(parsed.parallel, 'Silver Prizm')
  assert.deepEqual(parsed.serial, { num: 23, of: 99 })
  assert.equal(parsed.number, '136')
  assert.equal(parsed.rookie, true)
  assert.equal(parsed.sport, 'basketball')
})

test('an unreadable card reports low confidence rather than inventing one', () => {
  const parsed = parseSportsText(['~~~', 'zzz'])
  assert.equal(parsed.sport, 'other')
  assert.equal(parsed.player, undefined)
  assert.ok(parsed.confidence < 0.2, `expected a weak read, got ${parsed.confidence}`)
})

/* --- identity ------------------------------------------------------------ */

test('the slug is stable and excludes the fields that must not fork the id', () => {
  const base = { sport: 'basketball', year: 2023, brand: 'Panini', product: 'Prizm', number: '136', parallel: 'Silver Prizm' }
  const slug = sportsSlug(base)
  assert.equal(slug, '2023-panini-prizm-136-silver-prizm-basketball')
  // Every copy of a /99 is the same card, and a misread player must not fork it.
  assert.equal(sportsSlug({ ...base }), slug)
})

test('a base card and its parallel are different ids', () => {
  const base = { sport: 'basketball', year: 2023, brand: 'Panini', product: 'Prizm', number: '136' }
  assert.notEqual(sportsSlug(base), sportsSlug({ ...base, parallel: 'Silver Prizm' }))
})

test('missing fields degrade to placeholders instead of collapsing together', () => {
  assert.equal(sportsSlug({ sport: 'other' }), 'undated-unknown-base-nn-base-other')
  assert.equal(slugPart('Allen & Ginter'), 'allen-and-ginter')
})

test('the set name reads the way a collector would write it', () => {
  assert.equal(sportsSetName({ year: 2023, brand: 'Panini', product: 'Prizm' }), '2023 Panini Prizm')
  assert.equal(sportsSetName({ year: 2023, season: '2023-24', brand: 'Upper Deck' }), '2023-24 Upper Deck')
})
