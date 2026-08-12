/**
 * On-device OCR fallback (no Gemini key): Tesseract.js from a CDN, loaded
 * lazily and cached by the service worker's `ext` cache.
 */
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js'

declare global {
  interface Window {
    Tesseract?: any
  }
}

let workerPromise: Promise<any> | null = null

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.crossOrigin = 'anonymous'
    script.onload = () => resolve()
    script.onerror = () => {
      script.remove()
      reject(new Error(`Failed to load ${src}`))
    }
    document.head.appendChild(script)
  })
}

async function getWorker(): Promise<any> {
  workerPromise ??= (async () => {
    if (!window.Tesseract) await loadScript(TESSERACT_CDN)
    if (!window.Tesseract) throw new Error('Tesseract failed to initialize')
    const worker = await window.Tesseract.createWorker('eng', 1)
    // The input is a pre-cropped band, not a page: single-block segmentation
    // (PSM 6) skips Tesseract's layout analysis, a large share of its runtime.
    await worker.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {})
    return worker
  })().catch((err) => {
    workerPromise = null
    throw err
  })
  return workerPromise
}

export function warmOcr(): void {
  getWorker().catch(() => {})
}

/**
 * Horizontal bands of a card crop that can hold the name line, cheapest
 * first. The scan loop OCRs them one at a time and stops on the first match.
 */
export const OCR_BANDS = [0.26, 0.46] as const

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
 * OCR one top band of a card crop (the name line lives up there) and return
 * plausible name candidates, best first.
 */
export async function readCardNames(canvas: HTMLCanvasElement, share: number): Promise<string[]> {
  const worker = await getWorker()
  const band = prepRegion(canvas, { x: 0, y: 0, w: 1, h: share }, OCR_WIDTH)
  const { data } = await worker.recognize(band)
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

/** Tiny collector-line type needs upscaling before Tesseract can read it. */
const CORNER_OCR_WIDTH = 1200

/** OCR an arbitrary card region (e.g. the collector line) and return raw text. */
export async function readRegionText(canvas: HTMLCanvasElement, rect: OcrRect): Promise<string> {
  const worker = await getWorker()
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
  const pending = workerPromise
  workerPromise = null
  if (pending) {
    try {
      await (await pending).terminate()
    } catch {
      /* already gone */
    }
  }
}
