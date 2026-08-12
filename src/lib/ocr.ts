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
    return window.Tesseract.createWorker('eng', 1)
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
 * OCR the top bands of a card crop (name line lives up there) and return
 * plausible name candidates, best first.
 */
export async function readCardNames(canvas: HTMLCanvasElement): Promise<string[]> {
  const worker = await getWorker()
  const bands = [0.24, 0.42].map((share) => {
    const band = document.createElement('canvas')
    const height = Math.max(24, Math.round(canvas.height * share))
    band.width = canvas.width
    band.height = height
    band.getContext('2d')!.drawImage(canvas, 0, 0, canvas.width, height, 0, 0, band.width, height)
    return band
  })
  const texts: string[] = []
  for (const band of bands) {
    try {
      const { data } = await worker.recognize(band)
      if (data.text) texts.push(data.text)
    } catch {
      /* one band failing is fine */
    }
  }
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const cleaned = cleanOcrLine(line)
      if (cleaned && !seen.has(cleaned.toLowerCase())) {
        seen.add(cleaned.toLowerCase())
        candidates.push(cleaned)
      }
    }
  }
  return candidates.slice(0, 6)
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
