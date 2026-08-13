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

/**
 * Start the secondary worker once the primary is up (its assets then come
 * straight from cache). Purely an optimization: while it's missing or its
 * spawn failed, corner reads share the primary worker.
 */
function ensureCornerWorker(): void {
  cornerPromise ??= getWorker()
    .then(() => spawnWorker())
    .then((worker) => {
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

/**
 * Crop a region (fractions of the source), rescale toward `targetWidth`
 * (down for big name bands, up for tiny collector lines), grayscale and
 * stretch contrast.
 */
function prepRegion(canvas: HTMLCanvasElement, rect: OcrRect, targetWidth: number): HTMLCanvasElement {
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
    normalizeContrast(image)
    ctx.putImageData(image, 0, 0)
  } catch {
    /* preprocessing is an accuracy boost, not a requirement */
  }
  return out
}

/** Grayscale + percentile contrast stretch (clips glare/shadow outliers). */
function normalizeContrast(image: ImageData): void {
  const { data } = image
  const pixels = data.length / 4
  const luma = new Uint8ClampedArray(pixels)
  const histogram = new Uint32Array(256)
  let lumaSum = 0
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const y = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
    luma[p] = y
    lumaSum += y
    histogram[y]++
  }
  const clip = pixels * 0.02
  let lo = 0
  for (let mass = 0; lo < 255 && mass < clip; lo++) mass += histogram[lo]
  let hi = 255
  for (let mass = 0; hi > 0 && mass < clip; hi--) mass += histogram[hi]
  const span = Math.max(1, hi - lo)
  // Light type on a dark plate (Riftbound's name bar, collector lines on
  // dark frames) reads far worse than dark-on-light: flip the polarity of a
  // clearly dark crop so Tesseract always sees dark text on paper.
  const invert = lumaSum / pixels < 112
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    const stretched = Math.max(0, Math.min(255, Math.round(((luma[p] - lo) * 255) / span)))
    const value = invert ? 255 - stretched : stretched
    data[i] = data[i + 1] = data[i + 2] = value
  }
}

/** A pair of short lines can be one split name — long lines are rules text. */
const JOINABLE_LINE_LEN = 20

/**
 * Card-name candidates from a band's OCR lines, best first. Champions and
 * characters often split the name across two printed lines — Riftbound's
 * "JINX" over "Loose Cannon" is catalogued as "Jinx, Loose Cannon", Lorcana
 * stacks name over version — so each adjacent pair of short lines is also
 * offered joined, ahead of its halves: an exact full-name hit outranks a
 * partial one.
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
    // Evolution/type labels share the name's visual row ("BASIC Tauros",
    // "STAGE 2 Charizard") and OCR merges them — offer the row minus its
    // short leading token as well. Long first words are left alone so real
    // two-word names don't shed their first half.
    const words = lines[i].split(' ')
    if (words.length >= 2 && words[0].length <= 6) push(cleanOcrLine(words.slice(1).join(' ')))
  }
  return out.slice(0, 6)
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
export async function readCardNames(canvas: HTMLCanvasElement, band: OcrBand): Promise<string[]> {
  const worker = await getWorker()
  const region = prepRegion(canvas, { x: 0, y: band.y, w: 1, h: band.h }, OCR_WIDTH)
  const started = Date.now()
  const { data } = await worker.recognize(region)
  const raw = String(data?.text ?? '')
  const candidates = candidatesFromText(raw)
  traceEvent('ocr-band', { y: band.y, h: band.h, ms: Date.now() - started, raw: raw.slice(0, 300), candidates })
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
    const { data } = await worker.recognize(region)
    text = String(data?.text ?? '')
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
    const { data } = await worker.recognize(region)
    text = String(data?.text ?? '')
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
export async function readRegionText(canvas: HTMLCanvasElement, rect: OcrRect): Promise<string> {
  ensureCornerWorker()
  const worker = cornerWorker ?? (await getWorker())
  const region = prepRegion(canvas, rect, Math.min(CORNER_OCR_WIDTH, Math.round(rect.w * canvas.width * 3)))
  const started = Date.now()
  const { data } = await worker.recognize(region)
  const raw = String(data?.text ?? '')
  traceEvent('ocr-region', { ...rect, ms: Date.now() - started, raw: raw.slice(0, 200) })
  return raw
}

function cleanOcrLine(line: string): string | null {
  let cleaned = line
    .replace(/[|_~`!@#%^*=<>{}[\]\\]/g, ' ')
    .replace(/\b(HP|hp)\s*\d+\b/g, ' ')
    .replace(/\b\d{2,4}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  cleaned = cleaned.replace(/^[^A-Za-z"']+/, '').replace(/[^A-Za-z"'.!?)]+$/, '')
  if (cleaned.length < 3) return null
  const letters = (cleaned.match(/[A-Za-z]/g) ?? []).length
  if (letters < 3 || letters / cleaned.length < 0.55) return null
  if (cleaned.length > 40) cleaned = cleaned.slice(0, 40)
  return cleaned
}

export async function stopOcr(): Promise<void> {
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
