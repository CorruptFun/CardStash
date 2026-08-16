/**
 * A QR encoder, in the app, with no dependency and no network.
 *
 * It exists for exactly one job: the label a user prints and sticks on a
 * physical binder, holding the link back to that binder in this app. That job
 * is offline by definition — you print a label in the room where the binder
 * is, often on a laptop that has never signed in — so an image API or a CDN
 * script would be the one part of the feature that stops working when the
 * rest of the app still does. Nothing here talks to anything.
 *
 * Deliberately narrow: byte mode, error level M, versions 1..10. That is up
 * to 213 bytes, which is a binder URL several times over, and it keeps the
 * tables small enough to read. Anything longer throws rather than silently
 * truncating — a QR that encodes half a URL scans perfectly and goes nowhere.
 *
 * `tests/unit/qr.test.mjs` decodes what this produces with a real QR decoder,
 * because "it looks like a QR code" is not evidence and the failure mode of a
 * subtly wrong encoder is a label that nobody can scan.
 */

/** Modules of a finished symbol, row-major, 1 = dark. */
export interface QrMatrix {
  size: number
  modules: Uint8Array
}

/** Error level M: ~15% recovery. A printed label gets scuffed. */
const EC_LEVEL_BITS = 0b00

/** Highest version this encoder emits. v10-M holds 213 bytes. */
export const QR_MAX_VERSION = 10

/**
 * Per version (1..10) at level M: EC codewords per block, then the block
 * layout as [count, dataCodewordsPerBlock] groups. Group 2's blocks are one
 * codeword longer than group 1's, which is what the interleave below assumes.
 */
const BLOCKS_M: { ec: number; groups: [number, number][] }[] = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
]

/** Alignment pattern centre coordinates per version (1 has none). */
const ALIGN_POS: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

function dataCodewords(version: number): number {
  return BLOCKS_M[version - 1].groups.reduce((sum, [count, size]) => sum + count * size, 0)
}

/** Bytes of payload a version can carry, after mode + length overhead. */
export function byteCapacity(version: number): number {
  // 4 bits of mode + 8 or 16 bits of character count.
  const headerBits = 4 + (version < 10 ? 8 : 16)
  return dataCodewords(version) - Math.ceil(headerBits / 8)
}

/* --- GF(256), the arithmetic Reed-Solomon runs on ------------------------ */

const EXP = new Uint8Array(256)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  EXP[255] = EXP[0]
}

function gfMul(a: number, b: number): number {
  if (!a || !b) return 0
  return EXP[(LOG[a] + LOG[b]) % 255]
}

/** The generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1)
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGenerator(degree)
  const out = new Uint8Array(degree)
  for (const byte of data) {
    const factor = byte ^ out[0]
    out.copyWithin(0, 1)
    out[degree - 1] = 0
    for (let i = 0; i < degree; i++) out[i] ^= gfMul(gen[i + 1], factor)
  }
  return out
}

/* --- the bitstream ------------------------------------------------------- */

class BitBuffer {
  bits: number[] = []
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1)
  }
}

function encodeData(bytes: Uint8Array, version: number): Uint8Array {
  const buf = new BitBuffer()
  buf.push(0b0100, 4)
  buf.push(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) buf.push(byte, 8)
  const capacityBits = dataCodewords(version) * 8
  // Terminator, then pad to a byte boundary, then the two alternating pad
  // codewords the spec names.
  buf.push(0, Math.min(4, capacityBits - buf.bits.length))
  while (buf.bits.length % 8 !== 0) buf.bits.push(0)
  const out = new Uint8Array(dataCodewords(version))
  for (let i = 0; i < buf.bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i + j]
    out[i / 8] = byte
  }
  for (let i = buf.bits.length / 8, pad = 0; i < out.length; i++, pad++) out[i] = pad % 2 === 0 ? 0xec : 0x11
  return out
}

/**
 * Split into blocks, error-correct each, and interleave — the step that makes
 * a scuff across the label lose one codeword from many blocks rather than a
 * whole block, which is the entire reason a damaged QR still reads.
 */
function addEcc(data: Uint8Array, version: number): Uint8Array {
  const { ec, groups } = BLOCKS_M[version - 1]
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = []
  let at = 0
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const slice = data.subarray(at, at + size)
      at += size
      blocks.push({ data: slice, ec: rsRemainder(slice, ec) })
    }
  }
  const out: number[] = []
  const longest = Math.max(...blocks.map((b) => b.data.length))
  for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.data.length) out.push(block.data[i])
  for (let i = 0; i < ec; i++) for (const block of blocks) out.push(block.ec[i])
  return Uint8Array.from(out)
}

/* --- the symbol ---------------------------------------------------------- */

class Symbol_ {
  size: number
  modules: Uint8Array
  /** Function patterns are never masked and never carry data. */
  fixed: Uint8Array

  constructor(readonly version: number) {
    this.size = version * 4 + 17
    this.modules = new Uint8Array(this.size * this.size)
    this.fixed = new Uint8Array(this.size * this.size)
  }

  at(x: number, y: number): number {
    return this.modules[y * this.size + x]
  }

  set(x: number, y: number, dark: boolean | number): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return
    this.modules[y * this.size + x] = dark ? 1 : 0
    this.fixed[y * this.size + x] = 1
  }

  isFixed(x: number, y: number): boolean {
    return this.fixed[y * this.size + x] === 1
  }
}

function drawFinder(sym: Symbol_, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      sym.set(cx + dx, cy + dy, dist !== 2 && dist !== 4)
    }
  }
}

function drawAlignment(sym: Symbol_, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) sym.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }
}

function drawFunctionPatterns(sym: Symbol_): void {
  for (let i = 0; i < sym.size; i++) {
    sym.set(6, i, i % 2 === 0)
    sym.set(i, 6, i % 2 === 0)
  }
  drawFinder(sym, 3, 3)
  drawFinder(sym, sym.size - 4, 3)
  drawFinder(sym, 3, sym.size - 4)

  const pos = ALIGN_POS[sym.version - 1]
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      // The three corners are already finder patterns.
      const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)
      if (!corner) drawAlignment(sym, pos[i], pos[j])
    }
  }

  // Reserve the format areas (written for real once the mask is chosen) and
  // the version blocks, so data placement steps over them.
  drawFormat(sym, 0)
  if (sym.version >= 7) drawVersion(sym)
}

function bitOf(value: number, index: number): number {
  return (value >>> index) & 1
}

function drawFormat(sym: Symbol_, mask: number): void {
  const data = (EC_LEVEL_BITS << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff

  for (let i = 0; i <= 5; i++) sym.set(8, i, bitOf(bits, i))
  sym.set(8, 7, bitOf(bits, 6))
  sym.set(8, 8, bitOf(bits, 7))
  sym.set(7, 8, bitOf(bits, 8))
  for (let i = 9; i < 15; i++) sym.set(14 - i, 8, bitOf(bits, i))

  for (let i = 0; i < 8; i++) sym.set(sym.size - 1 - i, 8, bitOf(bits, i))
  for (let i = 8; i < 15; i++) sym.set(8, sym.size - 15 + i, bitOf(bits, i))
  // The one module that is always dark, in every symbol ever printed.
  sym.set(8, sym.size - 8, 1)
}

function drawVersion(sym: Symbol_): void {
  let rem = sym.version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = ((sym.version << 12) | rem) & 0x3ffff
  for (let i = 0; i < 18; i++) {
    const bit = bitOf(bits, i)
    const a = sym.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    sym.set(a, b, bit)
    sym.set(b, a, bit)
  }
}

/** Zigzag placement: two-module columns, right to left, alternating direction. */
function drawCodewords(sym: Symbol_, data: Uint8Array): void {
  let i = 0
  for (let right = sym.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern; the zigzag skips over it.
    if (right === 6) right = 5
    for (let vert = 0; vert < sym.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? sym.size - 1 - vert : vert
        if (!sym.isFixed(x, y) && i < data.length * 8) {
          sym.modules[y * sym.size + x] = bitOf(data[i >>> 3], 7 - (i & 7))
          i++
        }
      }
    }
  }
}

function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

function applyMask(sym: Symbol_, mask: number): void {
  for (let y = 0; y < sym.size; y++) {
    for (let x = 0; x < sym.size; x++) {
      if (sym.isFixed(x, y)) continue
      if (maskAt(mask, x, y)) sym.modules[y * sym.size + x] ^= 1
    }
  }
}

/**
 * The spec's four penalty rules, used only to pick between the eight masks.
 * A symbol reads correctly under any of them; this picks the one least likely
 * to confuse a decoder with runs, blocks or finder-lookalikes.
 */
function penalty(sym: Symbol_): number {
  const n = sym.size
  let score = 0

  const runScore = (run: number) => (run >= 5 ? 3 + (run - 5) : 0)
  for (let y = 0; y < n; y++) {
    let run = 1
    for (let x = 1; x < n; x++) {
      if (sym.at(x, y) === sym.at(x - 1, y)) run++
      else {
        score += runScore(run)
        run = 1
      }
    }
    score += runScore(run)
  }
  for (let x = 0; x < n; x++) {
    let run = 1
    for (let y = 1; y < n; y++) {
      if (sym.at(x, y) === sym.at(x, y - 1)) run++
      else {
        score += runScore(run)
        run = 1
      }
    }
    score += runScore(run)
  }

  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = sym.at(x, y)
      if (v === sym.at(x + 1, y) && v === sym.at(x, y + 1) && v === sym.at(x + 1, y + 1)) score += 3
    }
  }

  // 1:1:3:1:1 finder-like runs, with four light modules on either side.
  const FINDER = [1, 0, 1, 1, 1, 0, 1]
  const looksLikeFinder = (get: (i: number) => number, start: number, len: number) => {
    for (let i = 0; i < 7; i++) if (get(start + i) !== FINDER[i]) return false
    const clearBefore = [1, 2, 3, 4].every((d) => start - d < 0 || get(start - d) === 0)
    const clearAfter = [0, 1, 2, 3].every((d) => start + 7 + d >= len || get(start + 7 + d) === 0)
    return clearBefore || clearAfter
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x + 7 <= n; x++) if (looksLikeFinder((i) => sym.at(i, y), x, n)) score += 40
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y + 7 <= n; y++) if (looksLikeFinder((i) => sym.at(x, i), y, n)) score += 40
  }

  let dark = 0
  for (const module of sym.modules) dark += module
  const percent = (dark * 100) / (n * n)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/** Encode `text` (UTF-8, byte mode) into a QR symbol at error level M. */
export function encodeQr(text: string, opts: { minVersion?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  let version = Math.max(1, Math.min(QR_MAX_VERSION, Math.floor(opts.minVersion ?? 1)))
  while (version <= QR_MAX_VERSION && bytes.length > byteCapacity(version)) version++
  if (version > QR_MAX_VERSION) {
    throw new Error(`Too long for a QR code (${bytes.length} bytes, max ${byteCapacity(QR_MAX_VERSION)})`)
  }

  const codewords = addEcc(encodeData(bytes, version), version)
  let best: { sym: Symbol_; score: number } | null = null
  for (let mask = 0; mask < 8; mask++) {
    const sym = new Symbol_(version)
    drawFunctionPatterns(sym)
    drawCodewords(sym, codewords)
    applyMask(sym, mask)
    drawFormat(sym, mask)
    const score = penalty(sym)
    if (!best || score < best.score) best = { sym, score }
  }
  const chosen = best!.sym
  return { size: chosen.size, modules: chosen.modules }
}

/**
 * The symbol as one SVG path, in module units, so the same string prints at
 * any size without a canvas and without a raster to scale up. Every dark
 * module is its own `M…h1v1h-1z` sub-path: fewer, longer runs would be
 * smaller, but printers hairline-gap adjacent sub-paths and a gap inside a
 * finder is a QR that will not read.
 */
export function qrPath(qr: QrMatrix): string {
  const parts: string[] = []
  for (let y = 0; y < qr.size; y++) {
    let x = 0
    while (x < qr.size) {
      if (!qr.modules[y * qr.size + x]) {
        x++
        continue
      }
      let run = 1
      while (x + run < qr.size && qr.modules[y * qr.size + x + run]) run++
      parts.push(`M${x} ${y}h${run}v1h-${run}z`)
      x += run
    }
  }
  return parts.join('')
}
