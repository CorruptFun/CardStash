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
  /**
   * How much the frame's edge layout looks like UPRIGHT card text — the
   * spikiness of the row edge profile over that of the column profile (see
   * `profileSpikiness`). Text lines pack their edge pixels into narrow bands
   * across the axis they run perpendicular to, so an upright card reads > 1
   * and a quarter-turned one < 1. 1 means "no evidence" (detection failed).
   */
  lineRatio: number
}

/**
 * Per-unit-length total variation of an edge-count profile: how much of the
 * frame's edge mass is packed into narrow spikes rather than spread evenly.
 * Length-normalized so the row and column profiles of a non-square frame stay
 * comparable to each other.
 */
function profileSpikiness(profile: Float64Array): number {
  let sum = 0
  let variation = 0
  for (let i = 0; i < profile.length; i++) sum += profile[i]
  for (let i = 1; i < profile.length; i++) variation += Math.abs(profile[i] - profile[i - 1])
  return sum > 0 ? (variation / sum) * profile.length : 0
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
  const none: CropRefinement = { canvas: source, region: null, cardRegion: null, angle: 0, applied: false, lineRatio: 1 }
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

    // Text-layout orientation, read off the same profiles the region came
    // from: which axis the frame's edge mass is banded along. It answers a
    // question the detected shape can't — a card whose edges the detector
    // read badly still lays its type out in lines.
    const colSpikes = profileSpikiness(colEdges)
    const lineRatio = colSpikes > 0 ? profileSpikiness(rowEdges) / colSpikes : 1

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

    if (!cropRegion && !deskew) return { ...none, cardRegion: region, lineRatio }

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
    return { canvas: out, region: cropRegion, cardRegion, angle: deskew, applied: true, lineRatio }
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

/**
 * A card lying SIDEWAYS in the frame — how people photograph a card flat on a
 * desk. Every band and collector-line region downstream is written in upright
 * card coordinates, so a quarter-turned card misses all of them; the fix is to
 * turn the FRAME upright before any of that geometry is applied.
 */
export function looksSideways(refinement: CropRefinement, frame: HTMLCanvasElement): boolean {
  const ratio = refinement.lineRatio
  // Type laid out along the wrong axis is sideways whatever the outline says —
  // this is the arm that catches a card the detector shaped wrongly.
  if (ratio > 0 && ratio < SIDEWAYS_LINE_RATIO) return true
  const region = refinement.cardRegion ?? refinement.region
  // With no detection to go on, the frame's own shape is the only clue.
  const w = region ? region.w * frame.width : frame.width
  const h = region ? region.h * frame.height : frame.height
  // A landscape detection is only trusted as "sideways" while the layout
  // doesn't clearly disagree: an upright card the detector read as landscape
  // still bands its edges along rows, and it must not be turned.
  return h > 0 && w / h > SIDEWAYS_ASPECT && ratio < UPRIGHT_LINE_RATIO
}

/**
 * A card is 63:88 ≈ 0.72 upright and ≈ 1.4 on its side, but the detector
 * under-reads a sideways card badly (its long edges run the wrong way), so
 * the measured split is what the gate is set from, not the geometric ideal:
 * over the matrix, upright cards detect at p50 0.72 / p90 0.73, sideways ones
 * at 0.97. 0.85 sits in the empty middle. Being wrong here is cheap by
 * construction — `uprightOrientations` probes the as-captured orientation
 * first, and the frame as captured stays a candidate reading orientation.
 */
const SIDEWAYS_ASPECT = 0.85
/**
 * `lineRatio` gates, measured over the whole matrix (253 cells, all 23
 * fixtures × the standard battery + both sideways turns):
 *
 * - upright cells:  min 1.16, p10 1.61, p50 2.16 — never below 1.
 * - sideways cells: max 1.95, p50 0.95 — and the two whose OUTLINE also
 *   misreads (riftbound/champion-split-1, which detects at 0.71 sideways and
 *   0.95 upright — backwards both ways) sit at 0.66/0.67.
 *
 * So: below 0.85 — inside the empty [0.67, 1.16] — the layout alone settles
 * it. Above the aspect gate, the layout only has to not contradict: the only
 * upright frames that detect landscape are champion-split-1's, at 3.01/4.42,
 * while every sideways frame is ≤ 1.95, and 2.4 sits in that gap. Together
 * they fire on 46/46 sideways cells and 0/207 upright ones.
 */
const SIDEWAYS_LINE_RATIO = 0.85
const UPRIGHT_LINE_RATIO = 2.4

/** Rotate a frame by whole quarter turns (1 = 90° clockwise). */
export function rotateQuarter(source: HTMLCanvasElement, turns: number): HTMLCanvasElement {
  const t = ((turns % 4) + 4) % 4
  if (t === 0) return source
  const swap = t % 2 === 1
  const out = document.createElement('canvas')
  out.width = swap ? source.height : source.width
  out.height = swap ? source.width : source.height
  const ctx = out.getContext('2d')!
  ctx.translate(out.width / 2, out.height / 2)
  ctx.rotate((t * Math.PI) / 2)
  ctx.drawImage(source, -source.width / 2, -source.height / 2)
  return out
}

/**
 * Cards sharing a photo sit on a lattice — a binder page is literally a grid,
 * and even a loose row on a table lines up. Detections that already agree give
 * the pitch, and a slot the sweep missed can then be scored where the grid
 * says it must be rather than searched for blind.
 *
 * The missed ones are missed for ordinary reasons: glare across a row, a card
 * whose border merges with its neighbour's, a top row clipped by the frame.
 * Their own border evidence is real but under the bar, so the grid position
 * pays for the difference — the same evidence-pairing rule the matcher uses.
 * A predicted slot still has to MEASURE something (`GRID_FILL_SCORE_MIN`), so
 * an empty pocket stays empty instead of becoming a card.
 */
function completeGrid(
  cards: CardDetection[],
  borderScore: (x: number, y: number, w: number, h: number) => number,
  sw: number,
  sh: number,
): CardDetection[] {
  const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[xs.length >> 1]
  const w = median(cards.map((c) => c.w))
  const h = median(cards.map((c) => c.h))
  if (!(w > 0) || !(h > 0)) return cards

  /** 1D lattice from the observed centres: pitch = the smallest real gap. */
  const lattice = (centres: number[], size: number): { origin: number; pitch: number } => {
    const sorted = centres.slice().sort((a, b) => a - b)
    const gaps: number[] = []
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1]
      // Same column/row, not a step.
      if (gap > size * 0.5) gaps.push(gap)
    }
    if (!gaps.length) return { origin: sorted[0], pitch: 0 }
    const base = median(gaps)
    // Two slots apart reads as a double gap; fold those back down.
    const pitch = median(gaps.map((g) => (g > base * 1.6 ? g / Math.round(g / base) : g)))
    return { origin: sorted[0], pitch }
  }

  const cols = lattice(cards.map((c) => c.x + c.w / 2), w)
  const rows = lattice(cards.map((c) => c.y + c.h / 2), h)
  if (!(cols.pitch > 0) && !(rows.pitch > 0)) return cards

  const colPitch = cols.pitch > 0 ? cols.pitch : w
  const rowPitch = rows.pitch > 0 ? rows.pitch : h
  const spanFrom = (origin: number, pitch: number, centres: number[]): number[] => {
    const last = Math.max(...centres)
    const out: number[] = []
    for (let v = origin; v <= last + pitch * 0.5 && out.length < 12; v += pitch) out.push(v)
    return out
  }
  const colCentres = spanFrom(cols.origin, colPitch, cards.map((c) => c.x + c.w / 2))
  const rowCentres = spanFrom(rows.origin, rowPitch, cards.map((c) => c.y + c.h / 2))
  if (colCentres.length * rowCentres.length > 24) return cards

  // Snap to the lattice before filling it. A rectangle straddling the gap
  // between two rows still has four strong borders — the sleeve edge above and
  // the card sides running through both — so min-of-four cannot tell a card
  // from half of two stacked ones, and such a box scores HIGH (measured 1.72,
  // above several correct ones). What it cannot do is agree with its
  // neighbours: the majority sit on the true rows, so conforming an outlier to
  // the consensus fixes exactly the boxes that are wrong without touching the
  // ones that are right.
  const snap = (v: number, origin: number, pitch: number): number => {
    if (!(pitch > 0)) return v
    const k = Math.round((v - origin) / pitch)
    const target = origin + k * pitch
    return Math.abs(target - v) < pitch * 0.5 ? target : v
  }
  const out = cards.map((c) => {
    const cx = snap(c.x + c.w / 2, cols.origin, colPitch)
    const cy = snap(c.y + c.h / 2, rows.origin, rowPitch)
    if (cx === c.x + c.w / 2 && cy === c.y + c.h / 2) return c
    const score = borderScore((cx - w / 2) * sw, (cy - h / 2) * sh, w * sw, h * sh)
    // Only move it if the lattice position is defensible on its own evidence.
    return score >= GRID_FILL_SCORE_MIN ? { x: cx - w / 2, y: cy - h / 2, w, h, score } : c
  })
  for (const cx of colCentres) {
    for (const cy of rowCentres) {
      const taken = out.some((c) => Math.abs(c.x + c.w / 2 - cx) < w * 0.5 && Math.abs(c.y + c.h / 2 - cy) < h * 0.5)
      if (taken) continue
      const x = (cx - w / 2) * sw
      const y = (cy - h / 2) * sh
      // Same overhang the sweep allows. Held at 0.1 this guard rejected exactly
      // the clipped edge slots the lattice is best placed to find — the grid
      // knows where the top row IS even when the camera cut its border off.
      if (
        x < -w * sw * OVERHANG_MAX ||
        y < -h * sh * OVERHANG_MAX ||
        x + w * sw > sw * (1 + OVERHANG_MAX) ||
        y + h * sh > sh * (1 + OVERHANG_MAX)
      )
        continue
      const score = borderScore(x, y, w * sw, h * sh)
      if (score < GRID_FILL_SCORE_MIN) continue
      out.push({ x: cx - w / 2, y: cy - h / 2, w, h, score })
    }
  }
  return out
}

/** A card-shaped rectangle found in a frame, in frame fractions. */
export interface CardDetection extends Region {
  /** Border strength relative to the frame's mean edge energy. Higher is safer. */
  score: number
}

/** Analysis resolution for the multi-card sweep. Cheap, and card borders survive it. */
const DETECT_WIDTH = 224
/** Printed card aspect (63:88). Perspective and sleeves move it, so the sweep spans a range. */
const CARD_ASPECT = 63 / 88
const ASPECT_MIN = CARD_ASPECT * 0.82
const ASPECT_MAX = CARD_ASPECT * 1.2
/** A detection must beat the frame's average edge energy by this much on ALL four sides. */
const BORDER_SCORE_MIN = 1.35
/**
 * A border strip must be at least this visible to be measurable at all;
 * below it the frame cut the side off and the number would be noise.
 */
const CLIPPED_SIDE_VISIBLE = 0.4
/**
 * What the three REMAINING sides must clear when the fourth is off-frame.
 * Above BORDER_SCORE_MIN because three sides is weaker evidence than four —
 * the discount is for the camera's framing, not for the card's borders.
 */
const CLIPPED_BORDER_MIN = 1.5
/**
 * How far off the frame a card may hang and still be findable, as a fraction
 * of its own size. Generous enough for the top row of a hand-held binder page;
 * short of the point where a rectangle is mostly imaginary.
 */
const OVERHANG_MAX = 0.4
/**
 * How much better the turned frame must score before the cards are judged
 * sideways. Total border score, so a handful of hallucinated boxes cannot win
 * it on count alone.
 */

/** Overlap above which two detections are the same card. */
const NMS_IOU = 0.3
/** A box this much swallowed by an already-taken one is a panel inside a card. */
const CONTAINMENT_MAX = 0.6
/** Cards in one photo share a size; this much spread around the median is kept. */
const SIZE_CLUSTER_TOLERANCE = 1.45
/** A grid-predicted slot needs less independent evidence — but not none. */
const GRID_FILL_SCORE_MIN = 0.95

/**
 * Find every card-shaped rectangle in a frame.
 *
 * `refineCardCrop` answers a different question — "where is THE card" — with
 * 1D projection profiles: the span of columns and the span of rows holding
 * 92% of the edge mass. That is exactly right for one card on a plain surface
 * and it degrades badly everywhere else, because background clutter puts edge
 * mass at the frame's margins and drags both spans outward. Measured on real
 * photographs, a card on a wooden table beside its packaging detects as
 * 71–74% of the frame — which is over the 0.66 area gate, so the crop is
 * skipped and every text band then reads the table instead of the card. It
 * also cannot represent a second card at all, so a binder page is hopeless by
 * construction.
 *
 * This is 2D and explicitly rectangular. Sobel splits into vertical-edge and
 * horizontal-edge energy; integral images make any rectangle's border score
 * O(1); the sweep walks card-aspect rectangles across position and scale.
 *
 * The scoring rule is the whole idea: a candidate scores the **minimum** of
 * its four borders, not the sum. A card is a CLOSED rectangle, and requiring
 * all four sides is what separates one from the many strong-but-open edge
 * clusters a real scene is full of — a table edge, a sleeve, the side of a
 * box. Summing lets three good sides carry a fourth that isn't there, which
 * is the same failure the projection profiles have.
 */
/**
 * Find every card in a frame.
 *
 * KNOWN GAP, measured twice, both fixes rejected: a card lying QUARTER-TURNED
 * is not found. The sweep proposes only portrait rectangles (ASPECT_MIN..MAX,
 * from the printed 63:88) and a turned card's bounding box is landscape at
 * ~1.40, so the right rectangle is never proposed — on a real 3x3 page, 5
 * boxes and not one on a single card, one of them swallowing six.
 *
 * Two obvious fixes were built and measured, and neither survived:
 *
 * 1. Decide the page's orientation up front, then rotate the frame. Nothing
 *    available decides it. Total border score is not a discriminator — on a
 *    known-UPRIGHT page the turned frame scored HIGHER (14.09 vs 11.61),
 *    because a card grid has strong structure both ways — and it misfired on
 *    upright single cards. `lineRatio`, which is measured and reliable for ONE
 *    card, dilutes on a page where the binder's own rows outvote the card
 *    text: 0.45 on a genuinely sideways page, but 1.23 and 1.47 on two others
 *    just as turned.
 * 2. Propose BOTH aspect bands and let the existing arbitration sort it out.
 *    It cannot: containment suppression ("a card is never inside another
 *    card") and the size cluster both assume ONE card shape. Landscape boxes
 *    spanning two adjacent cards are larger, so they are taken first and
 *    swallow the correct ones — the known-good page fell 8/8 to 4/8 while the
 *    sideways page did not improve at all.
 *
 * What the evidence says is needed: a structural orientation decision made
 * ONCE per page — the correct way up puts the boxes on a regular lattice and
 * the wrong one scatters them, and `completeGrid` already infers that lattice
 * — rather than a per-rectangle shape guess. Until then this stays
 * portrait-only, which is the best-measured state.
 */
export function detectCardRegions(source: HTMLCanvasElement, maxCards = 12): CardDetection[] {
  try {
    const sw = DETECT_WIDTH
    const sh = Math.max(24, Math.round((source.height / source.width) * DETECT_WIDTH))
    const ctx = scaledContext(sw, sh)
    ctx.drawImage(source, 0, 0, sw, sh)
    const gray = grayscale(ctx.getImageData(0, 0, sw, sh))

    // Split the gradient: |gx| marks vertical edges (a card's left/right
    // sides), |gy| horizontal ones (top/bottom). Keeping them apart is what
    // lets a border be scored for the direction it should actually run in —
    // a horizontal table edge must not vouch for a card's vertical side.
    const vert = new Float64Array(sw * sh)
    const horiz = new Float64Array(sw * sh)
    for (let y = 1; y < sh - 1; y++) {
      const row = y * sw
      for (let x = 1; x < sw - 1; x++) {
        const i = row + x
        const gx =
          -gray[i - sw - 1] - 2 * gray[i - 1] - gray[i + sw - 1] + gray[i - sw + 1] + 2 * gray[i + 1] + gray[i + sw + 1]
        const gy =
          -gray[i - sw - 1] - 2 * gray[i - sw] - gray[i - sw + 1] + gray[i + sw - 1] + 2 * gray[i + sw] + gray[i + sw + 1]
        vert[i] = Math.abs(gx)
        horiz[i] = Math.abs(gy)
      }
    }

    const integral = (src: Float64Array): Float64Array => {
      const out = new Float64Array((sw + 1) * (sh + 1))
      for (let y = 0; y < sh; y++) {
        let rowSum = 0
        for (let x = 0; x < sw; x++) {
          rowSum += src[y * sw + x]
          out[(y + 1) * (sw + 1) + x + 1] = out[y * (sw + 1) + x + 1] + rowSum
        }
      }
      return out
    }
    const iv = integral(vert)
    const ih = integral(horiz)
    const sum = (ii: Float64Array, x0: number, y0: number, x1: number, y1: number): number => {
      const ax = Math.max(0, Math.min(sw, Math.round(x0)))
      const ay = Math.max(0, Math.min(sh, Math.round(y0)))
      const bx = Math.max(ax, Math.min(sw, Math.round(x1)))
      const by = Math.max(ay, Math.min(sh, Math.round(y1)))
      const W = sw + 1
      return ii[by * W + bx] - ii[ay * W + bx] - ii[by * W + ax] + ii[ay * W + ax]
    }
    /** Fraction of a rectangle that is actually inside the frame. */
    const visible = (x0: number, y0: number, x1: number, y1: number): number => {
      const w = Math.round(x1) - Math.round(x0)
      const h = Math.round(y1) - Math.round(y0)
      if (w <= 0 || h <= 0) return 0
      const iw = Math.max(0, Math.min(sw, Math.round(x1)) - Math.max(0, Math.round(x0)))
      const ih = Math.max(0, Math.min(sh, Math.round(y1)) - Math.max(0, Math.round(y0)))
      return (iw * ih) / (w * h)
    }
    // Deliberately divided by the REQUESTED area while `sum` clamps to the
    // frame: a strip hanging over the edge is scaled down by however much of
    // it is missing. That looks like a bug and is load-bearing — it is the
    // only thing penalising rectangles that wander off the picture, and
    // "fixing" it measured a binder page down from 7 cards to 4, because a box
    // drawn around the whole BINDER then scored well enough to swallow the
    // cards inside it (a card is never inside another card — but the binder is
    // not a card). Clipped SIDES are handled explicitly in borderScore instead.
    const mean = (ii: Float64Array, x0: number, y0: number, x1: number, y1: number): number => {
      const area = Math.max(1, (Math.round(x1) - Math.round(x0)) * (Math.round(y1) - Math.round(y0)))
      return sum(ii, x0, y0, x1, y1) / area
    }

    // Scene-relative baseline, so a flat scan and a noisy phone photo use the
    // same threshold.
    let energy = 0
    for (let i = 0; i < vert.length; i++) energy += vert[i] + horiz[i]
    const base = Math.max(1, energy / (2 * sw * sh))

    /**
     * Weakest of a rectangle's four borders, relative to the frame's energy.
     *
     * Min-of-four is the whole idea (a card is a CLOSED rectangle, and
     * requiring all four sides is what separates one from the strong-but-open
     * edge clusters a real scene is full of) — with one exception, and it is
     * an exception about the CAMERA rather than about the card: a border the
     * frame cut off cannot be measured at all. The top row of a binder page is
     * routinely half out of shot, and scoring those cards on a border that is
     * not in the picture rejects them for the photograph's framing rather than
     * for anything about them. Measured on the committed page: two of the
     * three top-row cards found by nothing else.
     *
     * Guarded the way every other tolerance here is. The exemption is granted
     * only where the frame boundary PHYSICALLY prevents the measurement — the
     * strip is mostly off-image, not merely weak — only one side may claim it,
     * and the three sides that remain must clear a higher bar than four would
     * have. A rectangle wandering off the edge of the picture gets no discount
     * for the sides it left behind.
     */
    const borderScore = (x: number, y: number, w: number, h: number): number => {
      const t = Math.max(1, w * 0.035)
      const sides: Array<[number, number]> = [
        [mean(iv, x - t, y, x + t, y + h), visible(x - t, y, x + t, y + h)],
        [mean(iv, x + w - t, y, x + w + t, y + h), visible(x + w - t, y, x + w + t, y + h)],
        [mean(ih, x, y - t, x + w, y + t), visible(x, y - t, x + w, y + t)],
        [mean(ih, x, y + h - t, x + w, y + h + t), visible(x, y + h - t, x + w, y + h + t)],
      ]
      const clipped = sides.filter(([, seen]) => seen < CLIPPED_SIDE_VISIBLE)
      if (clipped.length !== 1) return Math.min(...sides.map(([v]) => v)) / base
      const rest = sides.filter(([, seen]) => seen >= CLIPPED_SIDE_VISIBLE).map(([v]) => v)
      const weakest = Math.min(...rest) / base
      return weakest >= CLIPPED_BORDER_MIN ? weakest : Math.min(...sides.map(([v]) => v)) / base
    }

    const candidates: CardDetection[] = []
    const minW = Math.max(10, sw * 0.09)
    const maxW = sw * 0.98
    for (let w = minW; w <= maxW; w *= 1.14) {
      for (let aspect = ASPECT_MIN; aspect <= ASPECT_MAX + 1e-9; aspect += (ASPECT_MAX - ASPECT_MIN) / 2) {
        const h = w / aspect
        if (h > sh * 0.995) continue
        const step = Math.max(2, w * 0.11)
        // Sweep PAST the frame edges. A card the photograph cut off has its
        // rectangle partly outside the image, and a sweep anchored at x,y >= 0
        // cannot propose that rectangle at all — no border score, however
        // generous, ever gets a say. That was the whole reason the top row of a
        // binder page went missing: not a scoring question, a search-space one.
        // Bounded to OVERHANG_MAX of a card, and every proposal still has to
        // earn its place through borderScore, where at most one side may be
        // excused for being off-frame.
        const ox = w * OVERHANG_MAX
        const oy = h * OVERHANG_MAX
        for (let x = -ox; x + w <= sw + ox; x += step) {
          for (let y = -oy; y + h <= sh + oy; y += step) {
            const weakest = borderScore(x, y, w, h)
            if (weakest < BORDER_SCORE_MIN) continue
            candidates.push({ x: x / sw, y: y / sh, w: w / sw, h: h / sh, score: weakest })
          }
        }
      }
    }

    // Snap each survivor onto the card it nearly found. The sweep steps in
    // coarse jumps (11% of a card) so its hits sit a little off, and that
    // slop compounds: the lattice inferred from misaligned boxes predicts
    // missing slots into the GAPS between cards, where they score nothing and
    // are thrown away. A short hill-climb on the same integral images — a few
    // hundred O(1) probes — costs almost nothing and is what makes the grid
    // step work at all.
    const refine = (c: CardDetection): CardDetection => {
      let best = c
      let bestScore = c.score
      const W = c.w * sw
      const H = c.h * sh
      for (let pass = 0; pass < 2; pass++) {
        const reach = pass === 0 ? 0.09 : 0.035
        const steps = 4
        for (let dx = -steps; dx <= steps; dx++) {
          for (let dy = -steps; dy <= steps; dy++) {
            for (const ds of [1 - reach, 1, 1 + reach]) {
              const w2 = W * ds
              const h2 = H * ds
              const x2 = best.x * sw + (dx * reach * W) / steps
              const y2 = best.y * sh + (dy * reach * H) / steps
              if (x2 < -w2 * 0.15 || y2 < -h2 * 0.15 || x2 + w2 > sw * 1.15 || y2 + h2 > sh * 1.15) continue
              const score = borderScore(x2, y2, w2, h2)
              if (score > bestScore) {
                bestScore = score
                best = { x: x2 / sw, y: y2 / sh, w: w2 / sw, h: h2 / sh, score }
              }
            }
          }
        }
      }
      return best
    }

    // Suppress LARGEST-first, not best-first. A card's artwork panel is also a
    // bordered rectangle, and at some scales a card-shaped one — scored on its
    // own merits it often beats the card containing it, which is how the first
    // pass returned art panels for eight of nine binder slots. Taking the
    // outer rectangle first and then dropping anything it swallows encodes the
    // one thing that is always true here: a card is never inside another card.
    /**
     * Greedy largest-first selection. Comparing a candidate against boxes that
     * have already MOVED under refinement makes the two geometries
     * inconsistent and over-suppresses (measured: six cards down to three), so
     * this runs on one geometry at a time and refinement happens between the
     * two passes.
     */
    /** Area actually inside the frame — what a box is worth as a card. */
    const seenArea = (c: CardDetection): number =>
      Math.max(0, Math.min(1, c.x + c.w) - Math.max(0, c.x)) * Math.max(0, Math.min(1, c.y + c.h) - Math.max(0, c.y))

    const select = (list: CardDetection[]): CardDetection[] => {
      const out: CardDetection[] = []
      // Largest VISIBLE first, not largest. Once the sweep may propose
      // rectangles that hang off the frame, raw area lets a box win first pick
      // on pixels that are not in the picture — and first pick is decisive
      // here, because whatever is taken first suppresses everything it
      // contains. Measured: ranking by raw area, the overhanging boxes along
      // the bottom edge swallowed two correctly-found cards.
      for (const c of list.slice().sort((a, b) => seenArea(b) - seenArea(a))) {
        const clash = out.some((k) => {
          const ix = Math.max(0, Math.min(c.x + c.w, k.x + k.w) - Math.max(c.x, k.x))
          const iy = Math.max(0, Math.min(c.y + c.h, k.y + k.h) - Math.max(c.y, k.y))
          const inter = ix * iy
          if (!inter) return false
          // Contained in something already taken → a panel, not a card.
          if (inter / (c.w * c.h) > CONTAINMENT_MAX) return true
          return inter / (c.w * c.h + k.w * k.h - inter) > NMS_IOU
        })
        if (!clash) out.push(c)
      }
      return out
    }
    // Coarse pass picks WHICH rectangles; refinement snaps each onto the card
    // it nearly found; the second pass removes the duplicates that snapping
    // creates when two coarse boxes converge on one card.
    const kept = select(select(candidates).map(refine))

    // Cards photographed together are the same size — a binder page is a grid
    // of one card shape. That is a strong constraint and nothing else in the
    // sweep uses it: take the dominant area cluster and drop the outliers,
    // which is what removes the leftover panels and half-cards at the frame
    // edge. Only applied when a real cluster exists, so a single card in frame
    // is never second-guessed.
    if (kept.length >= 3) {
      const areas = kept.map((k) => k.w * k.h).sort((a, b) => a - b)
      const median = areas[areas.length >> 1]
      const cluster = kept.filter((k) => {
        const ratio = (k.w * k.h) / median
        return ratio >= 1 / SIZE_CLUSTER_TOLERANCE && ratio <= SIZE_CLUSTER_TOLERANCE
      })
      if (cluster.length >= 3) {
        const filled = completeGrid(cluster, borderScore, sw, sh)
        return filled.sort((a, b) => b.score - a.score).slice(0, maxCards)
      }
    }
    return kept.sort((a, b) => b.score - a.score).slice(0, maxCards)
  } catch {
    /* detection is an optimization; callers fall back to the whole frame */
    return []
  }
}
