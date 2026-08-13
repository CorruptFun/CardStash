import type { Region } from './camera'

/** Tiny frame analysis that gates the scanner: motion, focus, card region. */

export function grayscale(image: ImageData): Uint8ClampedArray {
  const { data, width, height } = image
  const gray = new Uint8ClampedArray(width * height)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
  }
  return gray
}

/** Mean abs diff between two grayscale frames (sampled); 255 = no baseline. */
function motionScore(current: Uint8ClampedArray, previous: Uint8ClampedArray): number {
  const len = Math.min(current.length, previous.length)
  if (!len) return 255
  let sum = 0
  for (let i = 0; i < len; i += 4) sum += Math.abs(current[i] - previous[i])
  return sum / (len / 4)
}

export interface FrameAnalysis {
  motion: number
  sharpness: number
  luma: number
  region: Region | null
  gray: Uint8ClampedArray
}

export function analyzeFrame(image: ImageData, previousGray: Uint8ClampedArray | null): FrameAnalysis {
  const { width, height } = image
  const gray = grayscale(image)
  let lumaSum = 0
  for (let i = 0; i < gray.length; i += 4) lumaSum += gray[i]
  const luma = lumaSum / (gray.length / 4)
  const motion = previousGray ? motionScore(gray, previousGray) : 255

  // Sobel edge pass, accumulating per-column/per-row edge counts.
  const colEdges = new Float64Array(width)
  const rowEdges = new Float64Array(height)
  let edgeSum = 0
  let samples = 0
  for (let y = 1; y < height - 1; y++) {
    const row = y * width
    for (let x = 1; x < width - 1; x++) {
      const i = row + x
      const gx =
        -gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1] + gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1]
      const gy =
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] + gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1]
      const magnitude = Math.abs(gx) + Math.abs(gy)
      edgeSum += magnitude
      samples++
      if (magnitude > 160) {
        colEdges[x] += 1
        rowEdges[y] += 1
      }
    }
  }
  const sharpness = samples ? edgeSum / samples : 0
  const region = findCardRegion(colEdges, rowEdges, width, height)
  return { motion, sharpness, luma, region, gray }
}

/** Trim an edge histogram to the span holding ~92% of its mass. */
function edgeSpan(histogram: Float64Array, size: number): [number, number] | null {
  let total = 0
  for (let i = 0; i < size; i++) total += histogram[i]
  if (total < size * 0.06) return null
  const keep = total * 0.92
  let lo = 0
  let hi = size - 1
  let mass = total
  while (hi - lo > size * 0.2) {
    const left = histogram[lo]
    const right = histogram[hi]
    if (mass - Math.min(left, right) < keep) break
    if (left <= right) {
      mass -= left
      lo++
    } else {
      mass -= right
      hi--
    }
  }
  return [lo, hi]
}

function findCardRegion(colEdges: Float64Array, rowEdges: Float64Array, width: number, height: number): Region | null {
  const cols = edgeSpan(colEdges, width)
  const rows = edgeSpan(rowEdges, height)
  if (!cols || !rows) return null
  const [x0, x1] = cols
  const [y0, y1] = rows
  let w = x1 - x0
  let h = y1 - y0
  if (w < width * 0.14 || h < height * 0.14) return null
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const aspect = w / h
  const CARD_ASPECT = 63 / 88
  if (aspect < CARD_ASPECT * 0.62) w = h * CARD_ASPECT * 0.75
  if (aspect > 1 / (CARD_ASPECT * 0.62)) h = w * CARD_ASPECT * 0.75
  return {
    x: Math.max(0, cx - w / 2) / width,
    y: Math.max(0, cy - h / 2) / height,
    w: Math.min(width, w) / width,
    h: Math.min(height, h) / height,
  }
}

/** Analysis resolution for locating the card inside a captured crop. */
const REFINE_WIDTH = 192
/** Rotations smaller than this aren't worth resampling; bigger than max is a misdetection. */
const DESKEW_MIN_DEG = 1.2
const DESKEW_MAX_DEG = 9

export interface CropRefinement {
  canvas: HTMLCanvasElement
  /** The crop region that was applied to the input (null: no crop). */
  region: Region | null
  /**
   * Where the card sits within the RETURNED canvas — identity after a crop,
   * the detected region when the crop was skipped as not worth it. Precision
   * consumers (the tiny collector-line slivers) map through this; the broad
   * name bands stay frame-relative on purpose, a mediocre detection must not
   * shift them off the name.
   */
  cardRegion: Region | null
  /** Roll angle that was removed, in degrees (0 when none). */
  angle: number
  applied: boolean
}

/**
 * Tighten a captured frame to the card actually in it, and undo small
 * hand-held roll. The capture crop is a fixed reticle-shaped window — the
 * card is regularly smaller, off-center, or a few degrees rotated in it,
 * which starves OCR of pixels and smears glyph baselines. Edge-projection
 * finds the card; the dominant near-horizontal edge orientation gives the
 * roll. Fails soft: anything implausible returns the input untouched.
 */
export function refineCardCrop(source: HTMLCanvasElement): CropRefinement {
  const none: CropRefinement = { canvas: source, region: null, cardRegion: null, angle: 0, applied: false }
  try {
    const sw = REFINE_WIDTH
    const sh = Math.max(24, Math.round((source.height / source.width) * REFINE_WIDTH))
    const ctx = scaledContext(sw, sh)
    ctx.drawImage(source, 0, 0, sw, sh)
    const image = ctx.getImageData(0, 0, sw, sh)
    const gray = grayscale(image)
    // The Sobel magnitude thresholds below are calibrated for a normally-lit
    // frame. In low light real card edges fall under them while the vignette
    // and noise survive — which is how dark frames got cropped INTO the
    // card. Stretch a low-contrast buffer to full range first (the 192px
    // downscale has already averaged away most sensor noise, so this
    // amplifies edges, not speckle).
    {
      const histogram = new Uint32Array(256)
      for (let i = 0; i < gray.length; i++) histogram[gray[i]]++
      const clip = gray.length * 0.02
      let lo = 0
      for (let mass = 0; lo < 255 && mass < clip; lo++) mass += histogram[lo]
      let hi = 255
      for (let mass = 0; hi > 0 && mass < clip; hi--) mass += histogram[hi]
      if (hi - lo < 110 && hi > lo) {
        const span = hi - lo
        for (let i = 0; i < gray.length; i++) {
          gray[i] = Math.max(0, Math.min(255, Math.round(((gray[i] - lo) * 255) / span)))
        }
      }
    }

    const colEdges = new Float64Array(sw)
    const rowEdges = new Float64Array(sh)
    // Histogram of edge orientations near horizontal, weighted by magnitude:
    // a rolled card shows up as a sharp peak off 0°.
    const HALF_SPAN = 14
    const angleBins = new Float64Array(HALF_SPAN * 4 + 1)
    for (let y = 1; y < sh - 1; y++) {
      const row = y * sw
      for (let x = 1; x < sw - 1; x++) {
        const i = row + x
        const gx =
          -gray[i - sw - 1] - 2 * gray[i - 1] - gray[i + sw - 1] + gray[i - sw + 1] + 2 * gray[i + 1] + gray[i + sw + 1]
        const gy =
          -gray[i - sw - 1] - 2 * gray[i - sw] - gray[i - sw + 1] + gray[i + sw - 1] + 2 * gray[i + sw] + gray[i + sw + 1]
        const magnitude = Math.abs(gx) + Math.abs(gy)
        if (magnitude > 160) {
          colEdges[x] += 1
          rowEdges[y] += 1
        }
        if (magnitude > 220) {
          // Edge direction is perpendicular to the gradient.
          let deg = (Math.atan2(gy, gx) * 180) / Math.PI - 90
          while (deg <= -90) deg += 180
          while (deg > 90) deg -= 180
          if (Math.abs(deg) <= HALF_SPAN) angleBins[Math.round((deg + HALF_SPAN) * 2)] += magnitude
        }
      }
    }

    let angle = 0
    {
      // Weighted median of the near-horizontal orientation mass.
      let total = 0
      for (const w of angleBins) total += w
      if (total > 0) {
        let acc = 0
        for (let b = 0; b < angleBins.length; b++) {
          acc += angleBins[b]
          if (acc >= total / 2) {
            angle = b / 2 - HALF_SPAN
            break
          }
        }
      }
    }
    const deskew = Math.abs(angle) >= DESKEW_MIN_DEG && Math.abs(angle) <= DESKEW_MAX_DEG ? angle : 0

    let region = findCardRegion(colEdges, rowEdges, sw, sh)
    if (region) {
      // Margin, then snap toward card shape by GROWING the short side — a
      // wrong region must never cut the name off the crop.
      const CARD_ASPECT = 63 / 88
      let x0 = region.x - 0.025
      let y0 = region.y - 0.025
      let x1 = region.x + region.w + 0.025
      let y1 = region.y + region.h + 0.025
      const w = x1 - x0
      const h = y1 - y0
      const frameAspect = (source.width * w) / (source.height * h)
      if (frameAspect < CARD_ASPECT * 0.92) {
        const grow = ((CARD_ASPECT * 0.92) / frameAspect - 1) * w
        x0 -= grow / 2
        x1 += grow / 2
      } else if (frameAspect > CARD_ASPECT * 1.35) {
        const grow = (frameAspect / (CARD_ASPECT * 1.35) - 1) * h
        y0 -= grow / 2
        y1 += grow / 2
      }
      x0 = Math.max(0, x0)
      y0 = Math.max(0, y0)
      x1 = Math.min(1, x1)
      y1 = Math.min(1, y1)
      region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      if (region.w < 0.3 || region.h < 0.3) region = null
      else if (region.w > 0.94 && region.h > 0.94) region = null
    }

    // Only crop when it buys real magnification. A near-full detection is
    // regularly a few percent tight (light borders, noise edges) and a crop
    // that clips half a glyph off the title costs far more than the pixels
    // it gains — those frames stay whole, with the detection kept for
    // precision consumers to map through.
    const cropRegion = region && region.w * region.h <= 0.66 ? region : null

    if (!cropRegion && !deskew) return { ...none, cardRegion: region }

    const sx = (cropRegion?.x ?? 0) * source.width
    const sy = (cropRegion?.y ?? 0) * source.height
    const cw = Math.max(1, Math.round((cropRegion?.w ?? 1) * source.width))
    const ch = Math.max(1, Math.round((cropRegion?.h ?? 1) * source.height))
    const out = document.createElement('canvas')
    out.width = cw
    out.height = ch
    const octx = out.getContext('2d')!
    if (deskew) {
      // Neutral fill so the revealed corners don't skew contrast stretching.
      octx.fillStyle = '#7f7f7f'
      octx.fillRect(0, 0, cw, ch)
      octx.translate(cw / 2, ch / 2)
      octx.rotate((-deskew * Math.PI) / 180)
      octx.drawImage(source, sx, sy, cw, ch, -cw / 2, -ch / 2, cw, ch)
    } else {
      octx.drawImage(source, sx, sy, cw, ch, 0, 0, cw, ch)
    }
    // After a crop the card IS the canvas; otherwise the (deskewed) canvas
    // still carries the detection for mapping — small angles keep it valid.
    const cardRegion = cropRegion ? null : region
    return { canvas: out, region: cropRegion, cardRegion, angle: deskew, applied: true }
  } catch {
    return none
  }
}

/**
 * Foil sheen detector — no cloud vision needed. A foil throws bright,
 * saturated specular streaks whose hues span the rainbow and spread across
 * the card; printed art almost never puts 5+ hue families of near-specular
 * highlights in multiple quadrants at once. Deliberately conservative: it
 * answers "definitely foil" or "don't know", never "definitely not" —
 * a foil held flat can show no sheen at all.
 */
export function foilSheen(image: ImageData): boolean {
  const { data, width, height } = image
  const total = width * height
  if (!total) return false
  const hueBins = new Uint32Array(12)
  const quadrants = [0, 0, 0, 0]
  const halfW = width / 2
  const halfH = height / 2
  let sheen = 0
  for (let p = 0, i = 0; p < total; p++, i += 4) {
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255
    const max = Math.max(r, g, b)
    if (max < 0.78) continue
    const min = Math.min(r, g, b)
    const delta = max - min
    if (delta / max < 0.34) continue // white glare, paper, borders
    sheen++
    const x = p % width
    const y = (p / width) | 0
    quadrants[(x < halfW ? 0 : 1) + (y < halfH ? 0 : 2)]++
    let hue: number
    if (max === r) hue = ((g - b) / delta + 6) % 6
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    hueBins[Math.min(11, (hue * 2) | 0)]++
  }
  if (sheen / total < 0.03) return false
  const strong = Math.max(4, sheen * 0.05)
  let families = 0
  for (const count of hueBins) if (count >= strong) families++
  const spread = quadrants.filter((q) => q >= total * 0.004).length
  return families >= 5 && spread >= 2
}

const FOIL_SAMPLE_W = 120
const FOIL_SAMPLE_H = 168

/** Run the sheen check on a card crop. False means "unknown", not "non-foil". */
export function detectFoil(source: CanvasImageSource): boolean {
  try {
    const ctx = scaledContext(FOIL_SAMPLE_W, FOIL_SAMPLE_H)
    ctx.drawImage(source, 0, 0, FOIL_SAMPLE_W, FOIL_SAMPLE_H)
    return foilSheen(ctx.getImageData(0, 0, FOIL_SAMPLE_W, FOIL_SAMPLE_H))
  } catch {
    return false
  }
}

let sharedCtx: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null

function scaledContext(width: number, height: number): CanvasRenderingContext2D {
  if (!sharedCtx) {
    const canvas = document.createElement('canvas')
    sharedCtx = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! }
  }
  sharedCtx.canvas.width = width
  sharedCtx.canvas.height = height
  return sharedCtx.ctx
}

/**
 * 128-bit perceptual hash of a frame (mean + gradient bits on an 8×8 grid) —
 * good enough to recognize "same card, same table" across a few seconds.
 */
export function frameHash(source: CanvasImageSource): string {
  const ctx = scaledContext(9, 8)
  ctx.drawImage(source, 0, 0, 9, 8)
  const gray = grayscale(ctx.getImageData(0, 0, 9, 8))
  let mean = 0
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) mean += gray[y * 9 + x]
  mean /= 64
  let meanHi = 0
  let meanLo = 0
  let gradHi = 0
  let gradLo = 0
  let bit = 0
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const value = gray[y * 9 + x]
      const aboveMean = value > mean ? 1 : 0
      const gradient = value > gray[y * 9 + x + 1] ? 1 : 0
      if (bit < 32) {
        meanHi = (meanHi << 1) | aboveMean
        gradHi = (gradHi << 1) | gradient
      } else {
        meanLo = (meanLo << 1) | aboveMean
        gradLo = (gradLo << 1) | gradient
      }
      bit++
    }
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
  return hex(meanHi) + hex(meanLo) + hex(gradHi) + hex(gradLo)
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 128
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (xor) {
      distance += xor & 1
      xor >>= 1
    }
  }
  return distance
}
