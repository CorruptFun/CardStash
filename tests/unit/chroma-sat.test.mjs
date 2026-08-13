import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

/*
 * "Foil on the NAME, not under it."
 *
 * The chroma pair (min/max) was added because luma fuses neutral ink with a
 * saturated background. Yu-Gi-Oh Ultra and Secret Rares invert that layout:
 * the name itself is printed in metal and the bar under it is comparatively
 * neutral — coloured text on plain ground.
 *
 * What makes that case hard is not the colour, it is the RANGE. Metal is not
 * a colour; it is what a stroke sweeps through as the card tilts, from a dark
 * shadow through its base tone to a blown-out highlight. That range straddles
 * the bar's own level, so within a single glyph some strokes read darker than
 * the bar and others lighter — and a projection whose contrast changes SIGN
 * across the text cannot be rescued by any stretch or threshold downstream.
 *
 * Saturation does not have that problem, because a metal's colourfulness
 * barely moves while its brightness swings. These tests pin both halves of
 * that claim: the sign-flip that kills the level projections, and the fact
 * that 'chroma-sat' comes out the other side with the glyphs actually
 * separated from the bar.
 */

const { normalizeContrast } = await bundleImport('src/lib/ocr.ts')

/** The Yu-Gi-Oh name bar, and the two metals a real card prints on it. */
const BAR = [222, 205, 170]
const GOLD = { shadow: [92, 66, 14], base: [201, 163, 52], highlight: [255, 241, 186] }
const SILVER = { shadow: [72, 74, 82], base: [178, 180, 186], highlight: [252, 252, 255] }

const project = {
  luma: (c) => (c[0] * 77 + c[1] * 150 + c[2] * 29) / 256,
  'chroma-max': (c) => Math.max(...c),
  'chroma-min': (c) => Math.min(...c),
  'chroma-sat': (c) => Math.max(...c) - Math.min(...c),
}

test('every level projection changes sign across a metal\'s specular range', () => {
  for (const metal of [GOLD, SILVER]) {
    for (const name of ['luma', 'chroma-max', 'chroma-min']) {
      const f = project[name]
      const signs = ['shadow', 'base', 'highlight'].map((k) => Math.sign(f(metal[k]) - f(BAR)))
      assert.ok(
        new Set(signs).size > 1,
        `${name} was expected to flip sign across the range, got ${signs.join(',')}`,
      )
    }
  }
})

test('saturation keeps ONE polarity for both metals — opposite ones', () => {
  const sat = project['chroma-sat']
  const bar = sat(BAR)
  const goldSigns = ['shadow', 'base', 'highlight'].map((k) => Math.sign(sat(GOLD[k]) - bar))
  const silverSigns = ['shadow', 'base', 'highlight'].map((k) => Math.sign(sat(SILVER[k]) - bar))
  assert.deepEqual(new Set(goldSigns), new Set([1]), 'gold stays MORE colourful than the bar at every stop')
  assert.deepEqual(new Set(silverSigns), new Set([-1]), 'silver stays LESS colourful than the bar at every stop')
})

/**
 * A name band: the bar, with glyph strokes swept through the metal's range so
 * the specular variation is present exactly as it is on a real card.
 */
function nameBand(metal) {
  const width = 96
  const height = 24
  const data = new Uint8ClampedArray(width * height * 4)
  const stops = ['shadow', 'base', 'highlight']
  const isGlyph = (x, y) => y >= 8 && y < 16 && x % 12 >= 2 && x % 12 < 7
  for (let y = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p++) {
      const colour = isGlyph(x, y) ? metal[stops[Math.floor(x / 12) % 3]] : BAR
      data[p * 4] = colour[0]
      data[p * 4 + 1] = colour[1]
      data[p * 4 + 2] = colour[2]
      data[p * 4 + 3] = 255
    }
  }
  return { data, width, height, isGlyph }
}

/** Mean output level of glyph pixels vs bar pixels, after normalization. */
function separation(metal, variant) {
  const band = nameBand(metal)
  normalizeContrast(band, variant)
  let glyph = 0, glyphN = 0, bar = 0, barN = 0
  for (let y = 0, p = 0; y < band.height; y++) {
    for (let x = 0; x < band.width; x++, p++) {
      const v = band.data[p * 4]
      if (band.isGlyph(x, y)) { glyph += v; glyphN++ } else { bar += v; barN++ }
    }
  }
  return { gap: Math.abs(glyph / glyphN - bar / barN), glyph: glyph / glyphN, bar: bar / barN }
}

test('chroma-sat separates metallic glyphs from the bar; luma does not', () => {
  for (const [label, metal] of [['gold', GOLD], ['silver', SILVER]]) {
    const sat = separation(metal, 'chroma-sat')
    const luma = separation(metal, 'normal')
    assert.ok(
      sat.gap > luma.gap,
      `${label}: chroma-sat gap ${sat.gap.toFixed(1)} should beat luma's ${luma.gap.toFixed(1)}`,
    )
    assert.ok(sat.gap > 60, `${label}: chroma-sat should separate strongly, got ${sat.gap.toFixed(1)}`)
  }
})

test('chroma-sat hands Tesseract dark glyphs on a light ground, both metals', () => {
  // The skew test picks the polarity: text is always the minority population,
  // so it pulls the mean off the median in its own direction. Gold (more
  // colourful than the bar) must be inverted, silver (less) must not be —
  // and both have to come out the same way round, because that is the only
  // orientation Tesseract reads well.
  for (const [label, metal] of [['gold', GOLD], ['silver', SILVER]]) {
    const { glyph, bar } = separation(metal, 'chroma-sat')
    assert.ok(glyph < bar, `${label}: glyphs (${glyph.toFixed(0)}) should end DARKER than the bar (${bar.toFixed(0)})`)
  }
})
