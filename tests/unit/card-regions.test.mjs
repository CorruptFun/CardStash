import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

/*
 * "Scan the whole binder page."
 *
 * `refineCardCrop` answers "where is THE card" with 1D projection profiles —
 * the span of columns and the span of rows holding 92% of the edge mass. That
 * is exactly right for one card on a plain surface, and it fails two ways in
 * the field. Background clutter puts edge mass at the frame's margins and
 * drags both spans outward (measured on real photographs: a card beside its
 * packaging detects as 71-74% of the frame, which is OVER the 0.66 area gate,
 * so the crop is skipped and every text band then reads the table). And a
 * single span cannot represent two cards at all.
 *
 * `detectCardRegions` is 2D and explicitly rectangular. These tests pin the
 * properties that make it work, on synthetic frames where the truth is known
 * exactly — the real binder photo lives in tests/harness/photos and is checked
 * by eye with `preview.mjs --detect`, because a detector graded only by a
 * count hides which boxes are the table.
 */

/**
 * Minimal canvas shim. `detectCardRegions` downscales into a shared offscreen
 * canvas via document.createElement, so a fake SOURCE is not enough — the
 * destination has to exist too. drawImage here is nearest-neighbour, which is
 * all the detector needs (it works on Sobel energy at 224px, not on
 * resampling quality).
 */
globalThis.document = {
  createElement() {
    let buffer = new Uint8ClampedArray(0)
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage(src, _dx, _dy, dw, dh) {
          const w = Math.round(dw ?? canvas.width)
          const h = Math.round(dh ?? canvas.height)
          const from = src.getContext().getImageData(0, 0, src.width, src.height)
          buffer = new Uint8ClampedArray(w * h * 4)
          for (let y = 0; y < h; y++) {
            const sy = Math.min(from.height - 1, Math.floor((y * from.height) / h))
            for (let x = 0; x < w; x++) {
              const sx = Math.min(from.width - 1, Math.floor((x * from.width) / w))
              const si = (sy * from.width + sx) * 4
              const di = (y * w + x) * 4
              buffer[di] = from.data[si]
              buffer[di + 1] = from.data[si + 1]
              buffer[di + 2] = from.data[si + 2]
              buffer[di + 3] = 255
            }
          }
        },
        getImageData: (_x, _y, w, h) => ({ data: buffer, width: w, height: h }),
        putImageData() {},
      }),
    }
    return canvas
  },
}

const { detectCardRegions } = await bundleImport('src/lib/vision.ts')

const CARD_ASPECT = 63 / 88

/**
 * Minimal canvas stand-in: detectCardRegions only ever draws the source into
 * a 2D context and reads it back, so a fake that can do that is enough.
 */
function frame(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
  }
  paint(put)
  const ctx = {
    drawImage() {},
    getImageData: () => ({ data, width, height }),
    putImageData() {},
    canvas: { width, height },
  }
  return { width, height, getContext: () => ctx }

}

/** A filled dark card with a lighter interior — border energy on all four sides. */
function paintCard(put, x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const edge = x < x0 + 2 || x >= x0 + w - 2 || y < y0 + 2 || y >= y0 + h - 2
      // Interior texture so the card is not a flat block (flat interiors make
      // every sub-rectangle score identically).
      put(x, y, edge ? [20, 20, 24] : [140 + ((x * 7 + y * 3) % 60), 130, 120])
    }
  }
}

test('finds a single card and does not swallow the frame', () => {
  const W = 300
  const H = 400
  const cw = 120
  const ch = Math.round(cw / CARD_ASPECT)
  const canvas = frame(W, H, (put) => paintCard(put, 90, 100, cw, ch))
  const found = detectCardRegions(canvas)
  assert.ok(found.length >= 1, 'should find the card')
  const best = found[0]
  // Within a tenth of the frame of the truth on every side.
  assert.ok(Math.abs(best.x - 90 / W) < 0.1, `x ${best.x.toFixed(2)} vs ${(90 / W).toFixed(2)}`)
  assert.ok(Math.abs(best.y - 100 / H) < 0.1, `y ${best.y.toFixed(2)} vs ${(100 / H).toFixed(2)}`)
  assert.ok(best.w < 0.75, `should not swallow the frame, got w=${best.w.toFixed(2)}`)
})

test('finds every card of a 3x3 grid, not the panels inside them', () => {
  const W = 360
  const H = 480
  const cw = 100
  const ch = Math.round(cw / CARD_ASPECT)
  const gapX = 15
  const gapY = 12
  const canvas = frame(W, H, (put) => {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const x = 10 + c * (cw + gapX)
        const y = 8 + r * (ch + gapY)
        paintCard(put, x, y, cw, ch)
        // An inner art panel — the thing the first implementation returned
        // instead of the card, eight times out of nine.
        for (let yy = y + 12; yy < y + 12 + 40; yy++) {
          for (let xx = x + 10; xx < x + 10 + 60; xx++) {
            const edge = xx < x + 12 || xx >= x + 68 || yy < y + 14 || yy >= y + 50
            if (edge) put(xx, yy, [10, 10, 10])
          }
        }
      }
    }
  })
  const found = detectCardRegions(canvas, 12)
  assert.ok(found.length >= 6, `expected most of the nine cards, got ${found.length}`)
  // Nothing returned may be panel-sized: every box is at least half a card.
  const cardArea = (cw / W) * (ch / H)
  for (const f of found) {
    assert.ok(f.w * f.h > cardArea * 0.45, `box ${f.w.toFixed(2)}x${f.h.toFixed(2)} is a panel, not a card`)
  }
})

test('an empty frame yields nothing rather than inventing a card', () => {
  // The guard that matters for a review screen: a blank surface must not
  // produce rows for the user to un-tick.
  const canvas = frame(240, 320, () => {})
  assert.equal(detectCardRegions(canvas).length, 0)
})

test('every detection is inside the frame and card-shaped', () => {
  const canvas = frame(300, 400, (put) => {
    paintCard(put, 20, 30, 110, Math.round(110 / CARD_ASPECT))
    paintCard(put, 160, 30, 110, Math.round(110 / CARD_ASPECT))
  })
  for (const f of detectCardRegions(canvas)) {
    assert.ok(f.x >= -0.02 && f.y >= -0.02, 'inside the frame')
    assert.ok(f.x + f.w <= 1.02 && f.y + f.h <= 1.02, 'inside the frame')
    const aspect = (f.w * 300) / (f.h * 400)
    assert.ok(aspect > 0.5 && aspect < 1.0, `card-shaped, got aspect ${aspect.toFixed(2)}`)
    assert.ok(f.score > 0, 'carries its border score')
  }
})
