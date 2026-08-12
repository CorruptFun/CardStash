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

/** Crop the top `share` of the card, downscaled to grayscale with stretched contrast. */
function prepBand(canvas: HTMLCanvasElement, share: number): HTMLCanvasElement {
  const scale = Math.min(1, OCR_WIDTH / Math.max(1, canvas.width))
  const srcHeight = Math.max(24, Math.round(canvas.height * share))
  const band = document.createElement('canvas')
  band.width = Math.max(1, Math.round(canvas.width * scale))
  band.height = Math.max(16, Math.round(srcHeight * scale))
  const ctx = band.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(canvas, 0, 0, canvas.width, srcHeight, 0, 0, band.width, band.height)
  try {
    const image = ctx.getImageData(0, 0, band.width, band.height)
    normalizeContrast(image)
    ctx.putImageData(image, 0, 0)
  } catch {
    /* preprocessing is an accuracy boost, not a requirement */
  }
  return band
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
  const band = prepBand(canvas, share)
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
