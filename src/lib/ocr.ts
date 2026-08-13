import { traceEvent } from './scandebug'
import type { Game } from './types'

/**
 * On-device OCR: Tesseract.js, fully self-hosted. The runtime is bundled as
 * its own lazy chunk; the worker, the wasm cores and the English language
 * data are copied from npm into `ocr/` at build time (see ocrAssets() in
 * vite.config.ts) and served from our own origin — no third-party CDN at
 * scan time. sw.js runtime-caches `ocr/` on first use, so scanning works
 * offline afterwards. The language data is the exact `4.0.0_best_int`
 * variant tesseract.js v6 would otherwise pull remotely: same accuracy.
 *
 * Two workers share the load: the primary reads name bands and pack fronts;
 * a secondary spins up in the background so the collector-line read can
 * overlap band reads instead of queueing behind them.
 */

let primaryPromise: Promise<any> | null = null
let cornerPromise: Promise<any | null> | null = null
/** The resolved secondary — corner reads use it the moment it's ready. */
let cornerWorker: any | null = null
/** Bumped by stopOcr so an in-flight secondary spawn can't resurrect a
 * terminated worker into the module slots. */
let generation = 0

async function spawnWorker(): Promise<any> {
  // The prebuilt ESM bundle's only export is `default` (the namespace).
  const { default: Tesseract } = await import('tesseract.js/dist/tesseract.esm.min.js')
  const { createWorker, PSM } = Tesseract
  const base = new URL('ocr/', document.baseURI).href
  const worker = await createWorker('eng', 1, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}core`,
    langPath: base.slice(0, -1), // the worker appends "/eng.traineddata.gz"
    // The service worker's ext cache is the single store for the language
    // data — skip the second copy Tesseract would keep in IndexedDB.
    cacheMethod: 'none',
  })
  // The input is a pre-cropped band, not a page: single-block segmentation
  // (PSM 6) skips Tesseract's layout analysis, a large share of its runtime.
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK }).catch(() => {})
  return worker
}

function getWorker(): Promise<any> {
  primaryPromise ??= spawnWorker().catch((err) => {
    primaryPromise = null
    throw err
  })
  return primaryPromise
}

/** No single recognition may run away: amplified sensor noise makes
 * Tesseract dwell for MINUTES on speckle it keeps trying to segment.
 * Calibrated above the SUCCESSFUL noisy reads (measured at 4.5–5s on dark
 * frames) and far below the runaway ones (20–60s). */
const RECOGNIZE_TIMEOUT_MS = 6_500
const RECOGNIZE_TIMEOUT_WIDE_MS = 8_000

let ocrTimeoutCount = 0
/** Monotonic count of watchdog kills — attempts snapshot it to notice when
 * the current frame keeps producing pathological OCR input. */
export const ocrTimeouts = (): number => ocrTimeoutCount

/**
 * Recognize with a hard timeout. On expiry the worker is terminated (the
 * only way to interrupt the wasm) and its slot cleared so the next read
 * respawns fresh from cache; the pass reports empty text — for the inputs
 * that trigger this, that IS the honest reading.
 */
async function recognizeBounded(worker: any, image: HTMLCanvasElement, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const result = await Promise.race([worker.recognize(image), timedOut])
    if (result === 'timeout') {
      ocrTimeoutCount++
      traceEvent('ocr-timeout', { ms: timeoutMs })
      try {
        await worker.terminate()
      } catch {
        /* already dying */
      }
      if ((await primaryPromise?.catch(() => null)) === worker) primaryPromise = null
      if (cornerWorker === worker) {
        cornerWorker = null
        cornerPromise = null
      }
      return ''
    }
    return String((result as any)?.data?.text ?? '')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Start the secondary worker once the primary is up (its assets then come
 * straight from cache). Purely an optimization: while it's missing or its
 * spawn failed, corner reads share the primary worker.
 */
function ensureCornerWorker(): void {
  const spawnedIn = generation
  cornerPromise ??= getWorker()
    .then(() => spawnWorker())
    .then((worker) => {
      if (spawnedIn !== generation) {
        // stopOcr ran while this spawned — don't resurrect into the slots.
        worker.terminate().catch(() => {})
        return null
      }
      cornerWorker = worker
      return worker
    })
    .catch(() => null)
}

export function warmOcr(): void {
  getWorker()
    .then(() => ensureCornerWorker())
    .catch(() => {})
}

export interface OcrBand {
  y: number
  h: number
}

/**
 * Where each game prints its card name, as horizontal bands of a card crop,
 * most-likely first — the scan loop OCRs them one at a time and stops on the
 * first match, so order is expected cost. Magic, Pokémon, Yu-Gi-Oh and
 * Digimon name their cards across the top; Riftbound, Lorcana and Star Wars:
 * Unlimited put the name on a plate under the art (mid-card); One Piece and
 * Gundam print it in the bottom banner. Auto mode has no game yet, so it
 * sweeps top first, then the mid-card catchall. Bands overlap so a line
 * straddling a cut is still read whole; `prepRegion` scales by width, so an
 * overlap re-reads at the same scale and dedupes cleanly.
 */
const TOP_BANDS: readonly OcrBand[] = [
  { y: 0, h: 0.26 },
  { y: 0.2, h: 0.26 },
]
const MID_BAND: OcrBand = { y: 0.44, h: 0.3 }
const BOTTOM_BAND: OcrBand = { y: 0.66, h: 0.32 }
const DEFAULT_BANDS: readonly OcrBand[] = [...TOP_BANDS, MID_BAND]

const GAME_BANDS: Partial<Record<Game, readonly OcrBand[]>> = {
  riftbound: [{ y: 0.46, h: 0.32 }, ...TOP_BANDS],
  lorcana: [MID_BAND, ...TOP_BANDS],
  starwars: [MID_BAND, ...TOP_BANDS],
  onepiece: [BOTTOM_BAND, ...TOP_BANDS],
  gundam: [BOTTOM_BAND, ...TOP_BANDS],
}

/** The name-band sweep for a game (or the auto-mode default sweep). */
export function nameBands(game?: Game): readonly OcrBand[] {
  return (game && GAME_BANDS[game]) || DEFAULT_BANDS
}

/** OCR runtime scales with pixel count; the name line survives this width fine. */
const OCR_WIDTH = 640

export interface OcrRect {
  x: number
  y: number
  w: number
  h: number
}

export type PrepVariant = 'normal' | 'binary' | 'binary-flip'

/**
 * Crop a region (fractions of the source), rescale toward `targetWidth`
 * (down for big name bands, up for tiny collector lines), grayscale and
 * normalize. 'normal' is a locally-adaptive contrast stretch; 'binary'
 * additionally thresholds to pure ink-on-paper — a different failure
 * surface that cracks stylized type over busy art.
 */
function prepRegion(canvas: HTMLCanvasElement, rect: OcrRect, targetWidth: number, variant: PrepVariant = 'normal'): HTMLCanvasElement {
  const sx = Math.max(0, Math.floor(rect.x * canvas.width))
  const sy = Math.max(0, Math.floor(rect.y * canvas.height))
  const sw = Math.max(1, Math.min(canvas.width - sx, Math.round(rect.w * canvas.width)))
  const sh = Math.max(1, Math.min(canvas.height - sy, Math.round(rect.h * canvas.height)))
  const scale = Math.min(3, Math.max(0.1, targetWidth / sw))
  const out = document.createElement('canvas')
  out.width = Math.max(16, Math.round(sw * scale))
  out.height = Math.max(16, Math.round(sh * scale))
  const ctx = out.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height)
  try {
    const image = ctx.getImageData(0, 0, out.width, out.height)
    normalizeContrast(image, variant)
    ctx.putImageData(image, 0, 0)
  } catch {
    /* preprocessing is an accuracy boost, not a requirement */
  }
  return out
}

/** Tiles per axis for local normalization; glare/shadow rarely covers all tiles. */
const CONTRAST_TILES = 4

/**
 * Grayscale + LOCALLY adaptive percentile contrast stretch: per-tile lo/hi
 * levels, bilinearly interpolated per pixel. A glare streak or shadow
 * gradient then only saturates its own corner instead of flattening the
 * whole band (the global stretch it replaces did exactly that). Flat tiles
 * (blank borders) inherit the global levels so noise isn't amplified.
 */
function normalizeContrast(image: ImageData, variant: PrepVariant = 'normal'): void {
  const { data, width, height } = image
  const pixels = width * height
  const luma = new Uint8ClampedArray(pixels)
  const globalHist = new Uint32Array(256)
  let lumaSum = 0
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const y = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
    luma[p] = y
    lumaSum += y
    globalHist[y]++
  }
  const levelAt = (histogram: Uint32Array, count: number, clipFraction: number): [number, number] => {
    const clip = count * clipFraction
    let lo = 0
    for (let mass = 0; lo < 255 && mass < clip; lo++) mass += histogram[lo]
    let hi = 255
    for (let mass = 0; hi > 0 && mass < clip; hi--) mass += histogram[hi]
    return [lo, hi]
  }
  const [globalLo, globalHi] = levelAt(globalHist, pixels, 0.02)

  const T = CONTRAST_TILES
  const tileW = Math.max(1, Math.ceil(width / T))
  const tileH = Math.max(1, Math.ceil(height / T))
  const tileLo = new Float64Array(T * T)
  const tileHi = new Float64Array(T * T)
  {
    const hist = new Uint32Array(256)
    for (let ty = 0; ty < T; ty++) {
      for (let tx = 0; tx < T; tx++) {
        hist.fill(0)
        let count = 0
        const yEnd = Math.min(height, (ty + 1) * tileH)
        const xEnd = Math.min(width, (tx + 1) * tileW)
        for (let y = ty * tileH; y < yEnd; y++) {
          const row = y * width
          for (let x = tx * tileW; x < xEnd; x++) {
            hist[luma[row + x]]++
            count++
          }
        }
        const [lo, hi] = count ? levelAt(hist, count, 0.04) : [globalLo, globalHi]
        // A flat tile has no signal worth stretching — use the global levels.
        const flat = hi - lo < 24
        tileLo[ty * T + tx] = flat ? globalLo : lo
        tileHi[ty * T + tx] = flat ? globalHi : hi
      }
    }
  }

  // Light type on a dark plate (Riftbound's name bar, collector lines on
  // dark frames) reads far worse than dark-on-light: flip the polarity of a
  // clearly dark crop so Tesseract always sees dark text on paper. The
  // 'binary-flip' variant forces the OPPOSITE call — full-art glyphs over
  // busy art regularly defeat the mean-luma heuristic.
  const invert = variant === 'binary-flip' ? lumaSum / pixels >= 112 : lumaSum / pixels < 112
  const values = new Uint8ClampedArray(pixels)
  for (let y = 0; y < height; y++) {
    const fy = Math.min(T - 1, Math.max(0, y / tileH - 0.5))
    const ty0 = Math.floor(fy)
    const ty1 = Math.min(T - 1, ty0 + 1)
    const wy = fy - ty0
    const row = y * width
    for (let x = 0; x < width; x++) {
      const fx = Math.min(T - 1, Math.max(0, x / tileW - 0.5))
      const tx0 = Math.floor(fx)
      const tx1 = Math.min(T - 1, tx0 + 1)
      const wx = fx - tx0
      const lo =
        (tileLo[ty0 * T + tx0] * (1 - wx) + tileLo[ty0 * T + tx1] * wx) * (1 - wy) +
        (tileLo[ty1 * T + tx0] * (1 - wx) + tileLo[ty1 * T + tx1] * wx) * wy
      const hi =
        (tileHi[ty0 * T + tx0] * (1 - wx) + tileHi[ty0 * T + tx1] * wx) * (1 - wy) +
        (tileHi[ty1 * T + tx0] * (1 - wx) + tileHi[ty1 * T + tx1] * wx) * wy
      const span = Math.max(12, hi - lo)
      const stretched = Math.max(0, Math.min(255, Math.round(((luma[row + x] - lo) * 255) / span)))
      values[row + x] = invert ? 255 - stretched : stretched
    }
  }

  // Amplified sensor noise reads as dense salt-and-pepper after the
  // stretch — the exact texture Tesseract dwells on for tens of seconds
  // trying to segment. When a DARK crop measures as speckle (a large share
  // of strong pixel-to-pixel jumps — printed text is structured, never
  // this), damp it with a small box blur AFTER amplification. The dark
  // requirement matters: bright glare texture also jumps, but blurring it
  // measurably cost legible reads, while dark-noise speckle only ever cost
  // time.
  if (lumaSum / pixels < 96) {
    let jumps = 0
    let samples = 0
    for (let p = 0; p < pixels - 1; p += 3) {
      if (p % width === width - 1) continue
      if (Math.abs(values[p] - values[p + 1]) > 96) jumps++
      samples++
    }
    if (samples && jumps / samples > 0.38) {
      const blurred = new Uint8ClampedArray(pixels)
      for (let y = 0; y < height; y++) {
        const up = Math.max(0, y - 1) * width
        const row = y * width
        const down = Math.min(height - 1, y + 1) * width
        for (let x = 0; x < width; x++) {
          const l = Math.max(0, x - 1)
          const r = Math.min(width - 1, x + 1)
          blurred[row + x] =
            (values[up + l] + values[up + x] + values[up + r] +
              values[row + l] + values[row + x] + values[row + r] +
              values[down + l] + values[down + x] + values[down + r]) / 9
        }
      }
      values.set(blurred)
    }
  }

  if (variant === 'binary' || variant === 'binary-flip') {
    // Otsu threshold over the normalized values → pure ink on paper.
    const hist = new Uint32Array(256)
    for (let p = 0; p < pixels; p++) hist[values[p]]++
    let sumAll = 0
    for (let v = 0; v < 256; v++) sumAll += v * hist[v]
    let weightBg = 0
    let sumBg = 0
    let best = 0
    let threshold = 127
    for (let v = 0; v < 256; v++) {
      weightBg += hist[v]
      if (!weightBg) continue
      const weightFg = pixels - weightBg
      if (!weightFg) break
      sumBg += v * hist[v]
      const meanBg = sumBg / weightBg
      const meanFg = (sumAll - sumBg) / weightFg
      const between = weightBg * weightFg * (meanBg - meanFg) ** 2
      if (between > best) {
        best = between
        threshold = v
      }
    }
    for (let p = 0; p < pixels; p++) values[p] = values[p] > threshold ? 255 : 0
  }

  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    data[i] = data[i + 1] = data[i + 2] = values[p]
  }
}

/** A pair of short lines can be one split name — long lines are rules text. */
const JOINABLE_LINE_LEN = 20

/** Suffixes that LOOK like junk but are load-bearing card-name endings. */
const NAME_SUFFIX = /^(?:ex|gx|v|vmax|vstar|x)$/i

/** A token that plausibly belongs to a printed name. */
function wordish(token: string): boolean {
  if (NAME_SUFFIX.test(token)) return true
  const letters = (token.match(/[A-Za-z]/g) ?? []).length
  return letters >= 3 && letters / token.length >= 0.7
}

/**
 * How much a candidate looks like a card name — used to rank candidates so
 * the lookup budget goes to the likeliest reads first, not to whatever
 * plate/art garbage OCR'd above the name.
 */
function plausibility(candidate: string): number {
  const tokens = candidate.split(' ')
  const letters = (candidate.match(/[A-Za-z]/g) ?? []).length
  const wordishShare = tokens.filter(wordish).length / tokens.length
  const caps = tokens.filter((t) => /^[A-Z]/.test(t)).length / tokens.length
  let score = (letters / candidate.length) * 2 + wordishShare * 2 + caps * 0.5
  // A fuller clean read carries more signal than its own lead fragment —
  // "JINX Loose Cannon" must outrank bare "JINX" (nameScore's lead-segment
  // tolerance still lets the fragment win the match if only it is real).
  score += Math.min(tokens.length, 3) * 0.15
  if (tokens.length === 1 && candidate.length <= 6) score -= 0.5
  if (candidate.length < 4) score -= 1
  if (candidate.length > 30) score -= (candidate.length - 30) / 20
  if (tokens.length > 5) score -= (tokens.length - 5) * 0.3
  return score
}

/** The longest run of name-plausible tokens ("=e Tauros ex, - w40" → "Tauros ex"). */
function wordishWindow(line: string): string | null {
  const tokens = line.split(' ')
  let best: string[] = []
  let run: string[] = []
  for (const token of tokens) {
    if (wordish(token)) {
      run.push(token)
      if (run.join(' ').length > best.join(' ').length) best = [...run]
    } else run = []
  }
  const window = best.join(' ').replace(/^["'.,]+|["'.,]+$/g, '')
  return (window.match(/[A-Za-z]/g) ?? []).length >= 4 ? window : null
}

/** Drop trailing junk tokens ("Lightning Bolt ek e)" → "Lightning Bolt"). */
function trimTrailingJunk(line: string): string | null {
  const tokens = line.split(' ')
  let end = tokens.length
  while (end > 1 && !wordish(tokens[end - 1])) end--
  return end < tokens.length ? tokens.slice(0, end).join(' ') : null
}

/**
 * Card-name candidates from a band's OCR lines, likeliest first. Beyond the
 * raw lines this offers: adjacent short lines joined (Riftbound's "JINX"
 * over "Loose Cannon" is catalogued as "Jinx, Loose Cannon"), the line minus
 * a short leading label ("BASIC Tauros" → "Tauros"), the line minus trailing
 * junk ("Lightning Bolt ek e)" → "Lightning Bolt"), and the longest
 * name-plausible token window ("AKALI 101A SEN" → "AKALI"). Candidates are
 * ranked by name-plausibility, not reading order — the lookup budget is
 * finite and art garbage above the name must not consume it.
 */
export function nameCandidates(lines: string[]): string[] {
  const out: string[] = []
  const push = (value: string | null) => {
    if (value && !out.some((seen) => seen.toLowerCase() === value.toLowerCase())) out.push(value)
  }
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 < lines.length && lines[i].length <= JOINABLE_LINE_LEN && lines[i + 1].length <= JOINABLE_LINE_LEN) {
      push(cleanOcrLine(`${lines[i]} ${lines[i + 1]}`))
    }
    push(lines[i])
    push(trimTrailingJunk(lines[i]))
    // Evolution/type labels share the name's visual row ("BASIC Tauros",
    // "STAGE 2 Charizard") and OCR merges them — offer the row minus its
    // short leading token as well. Long first words are left alone so real
    // two-word names don't shed their first half.
    const words = lines[i].split(' ')
    if (words.length >= 2 && words[0].length <= 6) {
      const stripped = cleanOcrLine(words.slice(1).join(' '))
      push(stripped)
      if (stripped) push(trimTrailingJunk(stripped))
    }
    push(wordishWindow(lines[i]))
  }
  // Stable rank: plausibility first, original order as the tiebreak.
  return out
    .map((candidate, at) => ({ candidate, at, score: plausibility(candidate) }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((row) => row.candidate)
    .slice(0, 8)
}

function candidatesFromText(text: string): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const cleaned = cleanOcrLine(line)
    if (cleaned && !seen.has(cleaned.toLowerCase())) {
      seen.add(cleaned.toLowerCase())
      lines.push(cleaned)
    }
  }
  return nameCandidates(lines)
}

/**
 * OCR one band of a card crop and return plausible name candidates, best
 * first.
 */
export async function readCardNames(
  canvas: HTMLCanvasElement,
  band: OcrBand,
  opts: { variant?: PrepVariant } = {},
): Promise<string[]> {
  const worker = await getWorker()
  const variant = opts.variant ?? 'normal'
  // The binary retry runs at higher resolution: thresholding sharpens glyph
  // edges, and the extra pixels are what let it crack stylized type.
  const region = prepRegion(canvas, { x: 0, y: band.y, w: 1, h: band.h }, variant === 'normal' ? OCR_WIDTH : 960, variant)
  const started = Date.now()
  const raw = await recognizeBounded(worker, region, RECOGNIZE_TIMEOUT_MS)
  const candidates = candidatesFromText(raw)
  traceEvent('ocr-band', { y: band.y, h: band.h, variant, ms: Date.now() - started, raw: raw.slice(0, 300), candidates })
  return candidates
}

/**
 * Position-agnostic fallback: OCR the whole card crop with automatic layout
 * detection — the name could be anywhere on promos, full-art specials and
 * custom cards — and mine every line for name candidates. Heavier than a
 * band, so the scan loop only calls it after the targeted bands miss.
 */
export async function readCardNamesAnywhere(canvas: HTMLCanvasElement): Promise<string[]> {
  const worker = await getWorker()
  const region = prepRegion(canvas, { x: 0, y: 0, w: 1, h: 1 }, 700)
  const started = Date.now()
  await worker.setParameters({ tessedit_pageseg_mode: '3' }).catch(() => {})
  let text = ''
  try {
    text = await recognizeBounded(worker, region, RECOGNIZE_TIMEOUT_WIDE_MS)
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {})
  }
  const candidates = candidatesFromText(text)
  traceEvent('ocr-anywhere', { ms: Date.now() - started, raw: text.slice(0, 400), candidates })
  return candidates
}

/**
 * Read the scattered large type on a pack/box front. Boxes aren't a single
 * text block, so this pass temporarily switches Tesseract to full page
 * segmentation, then restores the band-tuned mode.
 */
export async function readSealedLines(canvas: HTMLCanvasElement): Promise<string[]> {
  const worker = await getWorker()
  const region = prepRegion(canvas, { x: 0, y: 0, w: 1, h: 1 }, 720)
  await worker.setParameters({ tessedit_pageseg_mode: '3' }).catch(() => {})
  let text = ''
  try {
    text = await recognizeBounded(worker, region, RECOGNIZE_TIMEOUT_WIDE_MS)
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {})
  }
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    // Keep digits — set names carry them ("Modern Horizons 3", "151").
    const cleaned = raw
      .replace(/[|_~`@#%^*=<>{}[\]\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned.length < 3) continue
    if (((cleaned.match(/[A-Za-z0-9]/g) ?? []).length) / cleaned.length < 0.5) continue
    const key = cleaned.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      lines.push(cleaned)
    }
  }
  return lines.slice(0, 14)
}

/** Tiny collector-line type needs upscaling before Tesseract can read it. */
const CORNER_OCR_WIDTH = 1200

/** OCR an arbitrary card region (e.g. the collector line) and return raw text. */
export async function readRegionText(
  canvas: HTMLCanvasElement,
  rect: OcrRect,
  opts: { variant?: PrepVariant } = {},
): Promise<string> {
  ensureCornerWorker()
  const worker = cornerWorker ?? (await getWorker())
  const variant = opts.variant ?? 'normal'
  const region = prepRegion(canvas, rect, Math.min(CORNER_OCR_WIDTH, Math.round(rect.w * canvas.width * 3)), variant)
  const started = Date.now()
  const raw = await recognizeBounded(worker, region, RECOGNIZE_TIMEOUT_MS)
  traceEvent('ocr-region', { ...rect, variant, ms: Date.now() - started, raw: raw.slice(0, 200) })
  return raw
}

function cleanOcrLine(line: string): string | null {
  let cleaned = line
    .replace(/[|_~`!@#%^*=<>{}[\]\\]/g, ' ')
    .replace(/\b(HP|hp)\s*\d+\b/g, ' ')
    .replace(/\s(HP|hp)$/g, ' ')
    .replace(/\b\d{2,4}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  cleaned = cleaned.replace(/^[^A-Za-z"']+/, '').replace(/[^A-Za-z"'.!?)]+$/, '')
  if (cleaned.length < 3) return null
  const letters = (cleaned.match(/[A-Za-z]/g) ?? []).length
  if (letters < 3) return null
  // A noisy line can still carry the name — salvage its best token window
  // ("=e | Tauros ex, - w40 od" → "Tauros ex") instead of dropping the line.
  if (letters / cleaned.length < 0.55) return wordishWindow(cleaned)
  if (cleaned.length > 40) cleaned = cleaned.slice(0, 40)
  return cleaned
}

export async function stopOcr(): Promise<void> {
  generation++
  const pending = [primaryPromise, cornerPromise]
  primaryPromise = null
  cornerPromise = null
  cornerWorker = null
  for (const promise of pending) {
    if (!promise) continue
    try {
      await (await promise)?.terminate()
    } catch {
      /* already gone */
    }
  }
}
