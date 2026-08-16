/**
 * The QR encoder, held to the only standard that matters: a real decoder
 * reads back exactly what went in.
 *
 * "It renders a plausible-looking square" is not evidence. A wrong generator
 * polynomial, a mis-numbered format bit or an off-by-one in the zigzag all
 * produce something that looks like a QR code in a screenshot and scans as
 * nothing at all — and the artefact here is a label somebody glues to a
 * binder, so the failure would be discovered weeks later with the sticker
 * already on the shelf.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import jsQR from 'jsqr'
import { bundleImport } from './bundle.mjs'

const { encodeQr, qrPath, byteCapacity, QR_MAX_VERSION } = await bundleImport('src/lib/qr.ts')

/** Paint a symbol into the RGBA buffer a decoder expects, quiet zone and all. */
function raster(qr, scale = 4, quiet = 4) {
  const side = (qr.size + quiet * 2) * scale
  const data = new Uint8ClampedArray(side * side * 4).fill(255)
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y * qr.size + x]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx
          data[px * 4] = 0
          data[px * 4 + 1] = 0
          data[px * 4 + 2] = 0
        }
      }
    }
  }
  return { data, width: side, height: side }
}

function roundTrip(text) {
  const qr = encodeQr(text)
  const img = raster(qr)
  const decoded = jsQR(img.data, img.width, img.height)
  assert.ok(decoded, `nothing decoded for ${JSON.stringify(text.slice(0, 40))} (version size ${qr.size})`)
  assert.equal(decoded.data, text)
  return qr
}

test('a binder label URL round-trips through a real decoder', () => {
  roundTrip('https://corruptfun.github.io/CardStash/#/binders/k3f9a2b1c8')
  roundTrip('http://localhost:5173/#/binders/abc123')
})

test('every version this encoder emits decodes', () => {
  // One string per version, sized to just fill it, so each block layout and
  // both character-count widths (8-bit under v10, 16-bit at v10) are exercised.
  for (let version = 1; version <= QR_MAX_VERSION; version++) {
    const text = 'A'.repeat(byteCapacity(version))
    const qr = roundTrip(text)
    assert.equal(qr.size, version * 4 + 17, `version ${version} sized wrong`)
  }
})

test('capacity grows with version and stops at the documented ceiling', () => {
  for (let v = 2; v <= QR_MAX_VERSION; v++) assert.ok(byteCapacity(v) > byteCapacity(v - 1))
  assert.equal(byteCapacity(1), 14)
  assert.equal(byteCapacity(QR_MAX_VERSION), 213)
})

test('too long throws rather than encoding a truncated link', () => {
  assert.throws(() => encodeQr('x'.repeat(byteCapacity(QR_MAX_VERSION) + 1)), /Too long/)
})

test('UTF-8 survives — a binder name is whatever the user typed', () => {
  roundTrip('https://example.com/#/binders/abc?n=Pokémon Rares — 2026 ✦')
})

test('the SVG path covers exactly the dark modules', () => {
  const qr = encodeQr('https://example.com/#/binders/abc123')
  const path = qrPath(qr)
  let dark = 0
  for (const m of qr.modules) dark += m
  // Every sub-path is a horizontal run; the run lengths must total the dark
  // module count, or the drawing and the symbol have diverged.
  const runs = [...path.matchAll(/h(\d+)v1/g)].reduce((sum, m) => sum + Number(m[1]), 0)
  assert.equal(runs, dark)
  assert.ok(path.startsWith('M'))
})
