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
 * Horizontal bands of a card crop that can hold the name line, cheapest
 * first. The scan loop OCRs them one at a time and stops on the first match.
 * Band 2 overlaps band 1's floor (so a name line straddling the cut is still
 * read whole) but not its whole area: `prepRegion` scales by width, so
 * re-OCRing band 1's rows again would reproduce identical pixels — and
 * identical candidates — for twice the runtime.
 */
export const OCR_BANDS: readonly OcrBand[] = [
  { y: 0, h: 0.26 },
  { y: 0.2, h: 0.26 },
]

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
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const y = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
    luma[p] = y
    histogram[y]++
  }
  const clip = pixels * 0.02
  let lo = 0
  for (let mass = 0; lo < 255 && mass < clip; lo++) mass += histogram[lo]
  let hi = 255
  for (let mass = 0; hi > 0 && mass < clip; hi--) mass += histogram[hi]
  const span = Math.max(1, hi - lo)
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    const value = Math.max(0, Math.min(255, Math.round(((luma[p] - lo) * 255) / span)))
    data[i] = data[i + 1] = data[i + 2] = value
  }
}

/**
 * OCR one band of a card crop (the name line lives in the upper half) and
 * return plausible name candidates, best first.
 */
export async function readCardNames(canvas: HTMLCanvasElement, band: OcrBand): Promise<string[]> {
  const worker = await getWorker()
  const region = prepRegion(canvas, { x: 0, y: band.y, w: 1, h: band.h }, OCR_WIDTH)
  const { data } = await worker.recognize(region)
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const line of String(data?.text ?? '').split('\n')) {
    const cleaned = cleanOcrLine(line)
    if (cleaned && !seen.has(cleaned.toLowerCase())) {
      seen.add(cleaned.toLowerCase())
      candidates.push(cleaned)
    }
  }
  return candidates.slice(0, 4)
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
  const { data } = await worker.recognize(region)
  return String(data?.text ?? '')
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
