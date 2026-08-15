/**
 * The compression contract, and the one rule that protects a photo from a
 * merge.
 *
 * `encodeCardImage` needs a canvas, so the encoder itself is measured against
 * real card photographs by the harness rather than here. What IS pure — and
 * what silently costs a user their pictures if it drifts — is the arithmetic:
 * how a size is reported, and which patches a size-bounded backup carries.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const { weightOfChars, imageWeight, TARGET_IMAGE_BYTES, IMAGE_MAX_EDGE } = await bundleImport('src/lib/cardimage.ts', {
  // The encoder pulls in the scan pipeline's decoder for its EXIF handling;
  // none of that is reachable from the pure helpers under test.
  alias: { './camera': new URL('./stubs/camera-none.mjs', import.meta.url).pathname },
})

const { MAX_IMAGE_BYTES } = await bundleImport('src/lib/cardpatch.ts')

test('the budget is a target well under the hard cap, or the ladder is pointless', () => {
  // If these ever meet, "step down until you reach the target" degenerates
  // back into "accept the first thing that fits", which is the bug this ladder
  // exists to fix — every picture landing just under the ceiling.
  assert.ok(TARGET_IMAGE_BYTES < MAX_IMAGE_BYTES, 'target must sit below the hard cap')
  assert.ok(TARGET_IMAGE_BYTES * 2 <= MAX_IMAGE_BYTES, 'target should leave real headroom, not a token gap')
})

test('the stored edge stays above the largest render, with headroom', () => {
  // Nothing in the app paints a card wider than ~200 CSS px; 3x DPR is 600.
  assert.ok(IMAGE_MAX_EDGE >= 600)
  // And below the point where we are just storing camera noise.
  assert.ok(IMAGE_MAX_EDGE <= 900)
})

test('size is reported as the image, not the base64 that wraps it', () => {
  // 4 chars of base64 carry 3 bytes. A user comparing this against their photo
  // library should see the picture's size, not a third more.
  assert.equal(weightOfChars(4 * 1024), '3 KB')
  assert.equal(weightOfChars(0), '0 KB')
  assert.equal(weightOfChars(4 * 1024 * 1024), '3.0 MB')
  assert.equal(imageWeight(`data:image/webp;base64,${'A'.repeat(4 * 1024 - 23)}`), '3 KB')
})

/* ------------------------------------- what a size-bounded backup carries */

const { patchesWithinBudget } = await bundleImport('src/lib/db.ts', {
  alias: { dexie: new URL('./stubs/dexie-none.mjs', import.meta.url).pathname },
})

const patch = (id, at, imageChars) => ({
  cardId: `mtg:${id}`,
  game: 'mtg',
  fields: { name: id },
  image: imageChars ? `data:image/webp;base64,${'A'.repeat(imageChars)}` : undefined,
  origin: 'local',
  updatedAt: at,
})

/** One image's real cost, prefix included — budgets are in stored characters. */
const COST = patch('probe', 1, 100).image.length

test('the newest pictures are the ones that fit', () => {
  const rows = [patch('old', 1, 100), patch('mid', 2, 100), patch('new', 3, 100)]
  const { kept, omitted } = patchesWithinBudget(rows, COST * 2 + 1)
  assert.deepEqual(
    kept.map((r) => r.cardId),
    ['mtg:new', 'mtg:mid'],
  )
  assert.equal(omitted, 1)
})

test('a patch over budget is dropped WHOLE, never gutted of its image', () => {
  // This is the data-loss rule. mergeBackups is a union, so an omitted row
  // costs nothing — the other device keeps its own copy. A row that arrived
  // image-less could win on updatedAt and delete a photo that existed nowhere
  // else. Every kept row must still carry its picture.
  const rows = [patch('a', 3, 100), patch('b', 2, 100)]
  const { kept } = patchesWithinBudget(rows, COST)
  assert.equal(kept.length, 1)
  for (const row of kept) assert.ok(row.image, 'a kept patch must keep its image')
})

test('text-only patches are free and always travel', () => {
  // They cost bytes nobody notices, and a budget too small for any picture
  // must still carry the text — otherwise a tight budget would silently stop
  // syncing the half that weighs nothing.
  const rows = [patch('photo', 3, 500), patch('text-a', 2, 0), patch('text-b', 1, 0)]
  const { kept, omitted } = patchesWithinBudget(rows, 10)
  assert.deepEqual(kept.map((r) => r.cardId).sort(), ['mtg:text-a', 'mtg:text-b'])
  assert.equal(omitted, 1)
})

test('a budget nothing exceeds keeps everything, in one piece', () => {
  const rows = [patch('a', 1, 100), patch('b', 2, 100)]
  const { kept, omitted } = patchesWithinBudget(rows, COST * 10)
  assert.equal(kept.length, 2)
  assert.equal(omitted, 0)
})

test('budgeting never mutates the caller\'s rows', () => {
  const rows = [patch('a', 1, 100)]
  const before = JSON.stringify(rows)
  patchesWithinBudget(rows, 0)
  assert.equal(JSON.stringify(rows), before)
})
