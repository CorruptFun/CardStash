import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

// The orientation decision for a card lying sideways on a desk: which frames
// are even probed (looksSideways), and which way up the probe reads
// (latinWordCount over the collector strip). Both are pure — the canvas work
// around them isn't, so these pin the deciding logic itself.
const { looksSideways } = await bundleImport('src/lib/vision.ts')
const { latinWordCount } = await bundleImport('src/lib/ocr.ts', {
  external: ['tesseract.js/dist/tesseract.esm.min.js'],
})

/** A 756×1056 capture (the reticle's shape) with a detection over it. */
const frame = { width: 756, height: 1056 }
/** cardW/cardH are the detected card's size in frame pixels. */
const detected = (cardW, cardH, lineRatio) => ({
  canvas: null,
  region: null,
  cardRegion: { x: 0, y: 0, w: cardW / frame.width, h: cardH / frame.height },
  angle: 0,
  applied: false,
  lineRatio,
})

test('an upright card is left alone', () => {
  // Measured centre of the upright distribution: aspect 0.72, lineRatio 2.16.
  assert.equal(looksSideways(detected(500, 694, 2.16), frame), false)
})

test('a sideways card is probed', () => {
  // Measured: sideways cells detect at aspect 0.97, lineRatio ≈ 0.95.
  assert.equal(looksSideways(detected(700, 722, 0.95), frame), true)
})

test('text layout outvotes an outline the detector read backwards', () => {
  // riftbound/champion-split-1 sideways: the detection says portrait (0.71),
  // the type says quarter-turned (0.66). The type is right.
  assert.equal(looksSideways(detected(500, 704, 0.66), frame), true)
})

test('an upright card detected as landscape is still not turned', () => {
  // Same fixture upright: detection 0.95, but its type bands along rows
  // (4.42) — turning it would send every band a quarter turn off.
  assert.equal(looksSideways(detected(700, 736, 4.42), frame), false)
})

test('no detection falls back to the frame shape', () => {
  const noRegion = { canvas: null, region: null, cardRegion: null, angle: 0, applied: false, lineRatio: 1 }
  assert.equal(looksSideways(noRegion, { width: 756, height: 1056 }), false)
  assert.equal(looksSideways(noRegion, { width: 1056, height: 756 }), true)
})

test('a failed refinement (no layout evidence) is not called sideways', () => {
  // lineRatio 1 is the "no evidence" value — it must not read as < 0.85.
  assert.equal(looksSideways({ canvas: null, region: null, cardRegion: null, angle: 0, applied: false, lineRatio: 1 }, frame), false)
})

test('latinWordCount counts words, not characters', () => {
  // The right way up: real rules/flavour text in the bottom strip.
  assert.ok(latinWordCount('Lightning Bolt deals 3 damage to any target.') >= 6)
  // The same strip 180° out — Tesseract has no upside-down mode.
  assert.equal(latinWordCount('- [ ) R a ) =\n~ . - ‘ i “we'), 0)
  assert.equal(latinWordCount(''), 0)
})

test('latinWordCount ignores digits and punctuation', () => {
  assert.equal(latinWordCount('79/217 ©2023 4 | ]'), 0)
})

test('garbage can score a stray word — the turns are COMPARED, never thresholded', () => {
  // "Wil" is three letters and counts, so this is not a yes/no test for
  // readability; the wrong way up simply scores far below the right way up,
  // which is all the ordering asks of it (measured on the matrix: the correct
  // turn ran 5–20 words against 0–4 for the same strip 180° out).
  const junk = latinWordCount('db QQ Wil')
  const text = latinWordCount("Look at 5 cards from the top of your deck; reveal up to 1 Character card")
  assert.ok(junk <= 1, `junk scored ${junk}`)
  assert.ok(text >= junk + 4, `text ${text} vs junk ${junk}`)
})
