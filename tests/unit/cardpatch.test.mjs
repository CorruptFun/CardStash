/**
 * The rules a user-supplied card has to obey.
 *
 * Everything here is pure logic out of cardpatch.ts — the sanitizers that
 * stand between an untrusted document (a backup, a link, the shared index) and
 * an <img src>, the overlay rules that decide what a patch may and may not
 * change, and the slug that IS the identity of a card no catalog lists.
 *
 * The slug tests are the load-bearing ones, for the same reason sportsSlug's
 * are: changing it renames every custom card anyone owns, so a change should
 * have to break a test rather than a user's collection.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const {
  CUSTOM_PREFIX,
  MAX_IMAGE_BYTES,
  customCard,
  customCardId,
  customPatch,
  customSlug,
  fieldsDiff,
  fieldsFromCard,
  imageHash,
  isCustomCard,
  mergePatch,
  mergePatches,
  baseFields,
  needsImage,
  patchIsEmpty,
  unmergePatch,
  sanitizeFields,
  sanitizeImage,
  sanitizePatch,
} = await bundleImport('src/lib/cardpatch.ts')

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQ'

function card(over = {}) {
  return {
    id: 'mtg:abc',
    game: 'mtg',
    apiId: 'abc',
    name: 'Llanowar Elves',
    setCode: 'DOM',
    setName: 'Dominaria',
    number: '168',
    rarity: 'common',
    prices: { best: 1, bestFoil: 2, entries: [], updatedAt: 5 },
    links: {},
    ...over,
  }
}

/* ------------------------------------------------------------- sanitizers */

test('fields are trimmed, collapsed and capped; unknown keys are dropped', () => {
  const clean = sanitizeFields({
    name: '  Black   Lotus \n',
    setCode: 'x'.repeat(200),
    subtext: 'y'.repeat(5000),
    prices: { best: 999 },
    id: 'mtg:evil',
    imageLarge: 'https://example.test/a.png',
  })
  assert.equal(clean.name, 'Black Lotus')
  assert.equal(clean.setCode.length, 40)
  assert.equal(clean.subtext.length, 1200)
  assert.equal(clean.prices, undefined)
  assert.equal(clean.id, undefined)
  // The image is NOT a field: it has its own sanitizer with its own rules, and
  // letting one through here would bypass them.
  assert.equal(clean.imageLarge, undefined)
})

test('empty strings mean "I did not say", not "blank it"', () => {
  const clean = sanitizeFields({ name: 'Sol Ring', rarity: '', number: '   ' })
  assert.equal(clean.name, 'Sol Ring')
  assert.ok(!('rarity' in clean))
  assert.ok(!('number' in clean))
})

test('a bare year widens to a date; anything unparseable is dropped', () => {
  assert.equal(sanitizeFields({ releasedAt: '1993' }).releasedAt, '1993-01-01')
  assert.equal(sanitizeFields({ releasedAt: '1993-08-05' }).releasedAt, '1993-08-05')
  assert.equal(sanitizeFields({ releasedAt: 'last summer' }).releasedAt, undefined)
  assert.equal(sanitizeFields({ releasedAt: '05/08/1993' }).releasedAt, undefined)
})

test('only inline raster data URLs survive — this feeds an <img src>', () => {
  assert.equal(sanitizeImage(PNG), PNG)
  assert.equal(sanitizeImage(WEBP), WEBP)
  assert.equal(sanitizeImage('https://example.test/card.png'), undefined)
  assert.equal(sanitizeImage('javascript:alert(1)'), undefined)
  assert.equal(sanitizeImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), undefined)
  assert.equal(sanitizeImage('data:text/html;base64,PGgxPmhpPC9oMT4='), undefined)
  assert.equal(sanitizeImage('blob:https://example.test/1234'), undefined)
  assert.equal(sanitizeImage(null), undefined)
})

test('an oversized image is refused rather than stored', () => {
  const huge = `data:image/webp;base64,${'A'.repeat(MAX_IMAGE_BYTES)}`
  assert.equal(sanitizeImage(huge), undefined)
})

test('a patch whose id disagrees with its game is malformed, not merely odd', () => {
  assert.equal(sanitizePatch({ cardId: 'pokemon:x', game: 'mtg', fields: { name: 'A' } }), null)
  assert.equal(sanitizePatch({ cardId: 'nogame', game: 'mtg', fields: { name: 'A' } }), null)
  assert.equal(sanitizePatch({ cardId: 'mtg:x', game: 'notagame', fields: { name: 'A' } }), null)
})

test('a patch with nothing in it is null, so empty and garbage look the same', () => {
  assert.equal(sanitizePatch({ cardId: 'mtg:x', game: 'mtg', fields: {} }), null)
  assert.equal(sanitizePatch(null), null)
  assert.equal(sanitizePatch({ cardId: 'mtg:x', game: 'mtg', fields: { bogus: 1 } }), null)
  assert.ok(sanitizePatch({ cardId: 'mtg:x', game: 'mtg', image: PNG }))
})

test('origin defaults to local — nothing is assumed to have come from the server', () => {
  assert.equal(sanitizePatch({ cardId: 'mtg:x', game: 'mtg', image: PNG }).origin, 'local')
  assert.equal(sanitizePatch({ cardId: 'mtg:x', game: 'mtg', image: PNG, origin: 'community' }).origin, 'community')
  assert.equal(sanitizePatch({ cardId: 'mtg:x', game: 'mtg', image: PNG, origin: 'wat' }).origin, 'local')
})

test('an image hash without an image is dropped', () => {
  const patch = sanitizePatch({ cardId: 'mtg:x', game: 'mtg', fields: { name: 'A' }, imageHash: 'deadbeef' })
  assert.equal(patch.imageHash, undefined)
})

test('patchIsEmpty is what "nothing to save" means', () => {
  assert.equal(patchIsEmpty({ fields: {} }), true)
  assert.equal(patchIsEmpty({ fields: {}, image: PNG }), false)
  assert.equal(patchIsEmpty({ fields: { name: 'A' } }), false)
})

/* ----------------------------------------------------------------- overlay */

test('a patch wins on what it says and leaves everything else alone', () => {
  const merged = mergePatch(card(), {
    cardId: 'mtg:abc',
    game: 'mtg',
    fields: { rarity: 'mythic' },
    origin: 'local',
    updatedAt: 1,
  })
  assert.equal(merged.rarity, 'mythic')
  assert.equal(merged.name, 'Llanowar Elves')
  assert.equal(merged.setName, 'Dominaria')
  assert.equal(merged.patched, true)
})

test('prices are never touched by a patch', () => {
  const base = card()
  const merged = mergePatch(base, {
    cardId: 'mtg:abc',
    game: 'mtg',
    // A hostile payload naming a price key must not reach the money maths.
    fields: sanitizeFields({ name: 'X', prices: { best: 9999 } }),
    origin: 'community',
    updatedAt: 1,
  })
  assert.deepEqual(merged.prices, base.prices)
})

test('an image patch fills both sizes, so the thumbnail matches the sheet', () => {
  const merged = mergePatch(card({ imageSmall: 'https://cat/s.png', imageLarge: 'https://cat/l.png' }), {
    cardId: 'mtg:abc',
    game: 'mtg',
    image: PNG,
    fields: {},
    origin: 'local',
    updatedAt: 1,
  })
  assert.equal(merged.imageSmall, PNG)
  assert.equal(merged.imageLarge, PNG)
})

test('mergePatches leaves unpatched cards untouched and identical', () => {
  const a = card()
  const b = card({ id: 'mtg:def', apiId: 'def' })
  const index = new Map([['mtg:def', { cardId: 'mtg:def', game: 'mtg', image: PNG, fields: {}, origin: 'local', updatedAt: 1 }]])
  const [outA, outB] = mergePatches([a, b], index)
  assert.equal(outA, a)
  assert.equal(outB.imageLarge, PNG)
  // An empty index is a pure pass-through — this runs on every search result.
  assert.equal(mergePatches([a], new Map())[0], a)
})

test('mergePatch with no patch is the identity', () => {
  const a = card()
  assert.equal(mergePatch(a, undefined), a)
})

/* -------------------------------------------------------------- the diff */

test('only the fields that actually changed are stored', () => {
  const base = card()
  const diff = fieldsDiff(base, { ...fieldsFromCard(base), rarity: 'mythic' })
  assert.deepEqual(diff, { rarity: 'mythic' })
})

test('re-typing what the card already says stores nothing', () => {
  const base = card()
  assert.deepEqual(fieldsDiff(base, fieldsFromCard(base)), {})
})

test('a field left blank is not an instruction to erase the catalog value', () => {
  const base = card()
  assert.deepEqual(fieldsDiff(base, { ...fieldsFromCard(base), setName: '' }), {})
})

/* ------------------------------------------------------------------ slugs */

test('the same card described the same way gets the same id on every device', () => {
  const a = customSlug({ name: 'Pikachu Illustrator', setCode: 'PROMO', number: '001' })
  const b = customSlug({ name: 'pikachu   illustrator', setCode: ' promo ', number: '001' })
  assert.equal(a, b)
  assert.ok(a.startsWith(CUSTOM_PREFIX))
})

test('the slug is pinned — changing it renames every custom card anyone owns', () => {
  assert.equal(
    customSlug({ name: 'Pikachu Illustrator', setCode: 'PROMO', number: '001' }),
    'custom-promo-001-pikachu-illustrator',
  )
  assert.equal(customSlug({}), 'custom-noset-nn-unnamed')
  assert.equal(customSlug({ name: 'Dracaufeu ex' }), 'custom-noset-nn-dracaufeu-ex')
  // Accents fold rather than vanishing into nothing.
  assert.equal(customSlug({ name: 'Pokémon Café' }), 'custom-noset-nn-pokemon-cafe')
})

test('two different cards in the same unlisted set do not collide', () => {
  const a = customCardId('pokemon', { setCode: 'PROMO', number: '1', name: 'A' })
  const b = customCardId('pokemon', { setCode: 'PROMO', number: '2', name: 'B' })
  assert.notEqual(a, b)
})

test('the id carries the game, like every other card id in the app', () => {
  assert.equal(customCardId('lorcana', { name: 'Elsa', number: '4' }).split(':')[0], 'lorcana')
})

/* ------------------------------------------------------- synthesized cards */

test('a custom card carries no prices, ever', () => {
  const made = customCard('mtg', { name: 'Playtest Card' }, PNG)
  assert.equal(made.prices.best, null)
  assert.equal(made.prices.bestFoil, null)
  assert.deepEqual(made.prices.entries, [])
  assert.deepEqual(made.links, {})
})

test('a custom card is recognizable as one, by id alone', () => {
  const made = customCard('mtg', { name: 'Playtest Card' })
  assert.equal(isCustomCard(made), true)
  assert.equal(isCustomCard(card()), false)
})

test('a nameless custom card still gets a name rather than an empty row', () => {
  assert.equal(customCard('mtg', {}).name, 'Untitled card')
})

test('customPatch and customCard agree on the id', () => {
  const fields = { name: 'Promo', setCode: 'P24', number: '7' }
  assert.equal(customPatch('digimon', fields).cardId, customCard('digimon', fields).id)
})

/* ------------------------------------------------------------ small stuff */

test('needsImage is true only when there is nothing at all to show', () => {
  assert.equal(needsImage({}), true)
  assert.equal(needsImage({ imageSmall: 'x' }), false)
  assert.equal(needsImage({ imageLarge: 'x' }), false)
})

test('the image hash is stable, and different bytes hash differently', () => {
  assert.equal(imageHash(PNG), imageHash(PNG))
  assert.notEqual(imageHash(PNG), imageHash(WEBP))
})

/* -------------------------------------------------------------- undoing */

test('undo restores exactly what the patch covered, offline', () => {
  const base = card()
  const diff = { rarity: 'mythic', subtext: 'Tap: add G' }
  const patch = {
    cardId: base.id,
    game: 'mtg',
    image: PNG,
    fields: diff,
    base: baseFields(base, diff),
    baseImage: 'https://cards.test/s.png',
    baseImageLarge: 'https://cards.test/l.png',
    origin: 'local',
    updatedAt: 1,
  }
  const withImages = { ...base, imageSmall: 'https://cards.test/s.png', imageLarge: 'https://cards.test/l.png' }
  const merged = mergePatch(withImages, patch)
  assert.equal(merged.rarity, 'mythic')
  assert.equal(merged.imageLarge, PNG)

  const undone = unmergePatch(merged, patch)
  assert.equal(undone.rarity, 'common')
  assert.equal(undone.imageSmall, 'https://cards.test/s.png')
  assert.equal(undone.imageLarge, 'https://cards.test/l.png')
  assert.equal(undone.patched, undefined)
  // The field the catalog never had goes back to absent, not to an empty string.
  assert.ok(!('subtext' in undone))
})

test('undoing a photo on a card that never had one leaves no picture behind', () => {
  const base = card({ imageSmall: undefined, imageLarge: undefined })
  const patch = { cardId: base.id, game: 'mtg', image: PNG, fields: {}, origin: 'local', updatedAt: 1 }
  const undone = unmergePatch(mergePatch(base, patch), patch)
  assert.equal(undone.imageSmall, undefined)
  assert.equal(undone.imageLarge, undefined)
})

test('baseFields records only the keys the edit touches', () => {
  const base = card()
  assert.deepEqual(baseFields(base, { rarity: 'mythic' }), { rarity: 'common' })
  assert.deepEqual(baseFields(base, {}), {})
})

test('a remembered catalog image must be an https URL, not any string', () => {
  const ok = sanitizePatch({ cardId: 'mtg:x', game: 'mtg', image: PNG, baseImage: 'https://cards.test/a.png' })
  assert.equal(ok.baseImage, 'https://cards.test/a.png')
  // Undo writes this straight into an <img src>, so it gets its own gate.
  for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'http://cards.test/a.png', './a.png']) {
    assert.equal(sanitizePatch({ cardId: 'mtg:x', game: 'mtg', image: PNG, baseImage: bad }).baseImage, undefined, bad)
  }
})

test('a patch carrying only a remembered original is still empty', () => {
  assert.equal(sanitizePatch({ cardId: 'mtg:x', game: 'mtg', fields: {}, base: { rarity: 'common' } }), null)
})
