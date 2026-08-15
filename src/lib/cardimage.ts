/**
 * Turning a photo into a card picture the app can store forever.
 *
 * A patch's image lives in IndexedDB, rides the JSON backup, syncs through the
 * vault and may be contributed to the shared index (`cardsource.ts`), so its
 * size is not a detail — it is the difference between a feature and a way to
 * fill a phone's storage. A 12 MP camera capture is ~4 MB; six hundred of them
 * is a collection nobody can back up.
 *
 * So every image comes through here and comes out bounded: card-shaped, at
 * most `IMAGE_MAX_EDGE` on its long side, and under `MAX_IMAGE_BYTES` as a
 * base64 data URL. A data URL rather than a Blob because a patched card must
 * render offline from a plain `<img src>` in a hundred places, survive a JSON
 * export, and mean the same thing on the other side of a sync — an object URL
 * is none of those things after a reload.
 *
 * WebP where the browser has it (roughly half the bytes at the same quality),
 * JPEG where it does not. Never PNG: a photograph in PNG is several times the
 * size for no visible gain.
 */

import { decodeImage } from './camera'
import { imageHash, MAX_IMAGE_BYTES, sanitizeImage } from './cardpatch'

/**
 * Long edge of a stored card picture.
 *
 * Sized against what it is compared with rather than against what a phone can
 * capture: catalog art is ~745px on the long edge (Scryfall "normal", the
 * Pokémon API's large), and the card sheet shows it no larger than that. More
 * pixels would cost bytes on every device that ever syncs this row and show
 * the user nothing.
 */
export const IMAGE_MAX_EDGE = 720

/** Quality ladder, walked downwards until the result fits the byte budget. */
const QUALITY_STEPS = [0.82, 0.7, 0.58, 0.46]
/** If quality alone cannot make it fit, shrink and walk the ladder again. */
const SCALE_STEPS = [1, 0.75, 0.55]

function canvasToDataUrl(canvas: HTMLCanvasElement, type: string, quality: number): string {
  return canvas.toDataURL(type, quality)
}

/** Does this browser actually encode WebP, or silently hand back a PNG? */
let webpSupport: boolean | null = null
function supportsWebp(): boolean {
  if (webpSupport != null) return webpSupport
  try {
    const probe = document.createElement('canvas')
    probe.width = 1
    probe.height = 1
    webpSupport = probe.toDataURL('image/webp').startsWith('data:image/webp')
  } catch {
    webpSupport = false
  }
  return webpSupport
}

function scaled(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  if (factor >= 1) return source
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * factor))
  canvas.height = Math.max(1, Math.round(source.height * factor))
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

export interface CardImageResult {
  /** `data:image/webp;base64,…` — already through `sanitizeImage`. */
  dataUrl: string
  hash: string
  width: number
  height: number
  bytes: number
}

/**
 * Encode an already-decoded canvas down to a storable card picture.
 *
 * Returns null only when even the smallest, ugliest encoding will not fit,
 * which in practice means a canvas this browser refused to export at all
 * (a tainted canvas being the realistic cause).
 */
export function encodeCardImage(source: HTMLCanvasElement): CardImageResult | null {
  const type = supportsWebp() ? 'image/webp' : 'image/jpeg'
  for (const scale of SCALE_STEPS) {
    const canvas = scaled(source, scale)
    for (const quality of QUALITY_STEPS) {
      const dataUrl = canvasToDataUrl(canvas, type, quality)
      const clean = sanitizeImage(dataUrl)
      if (!clean) continue
      return { dataUrl: clean, hash: imageHash(clean), width: canvas.width, height: canvas.height, bytes: clean.length }
    }
  }
  return null
}

/**
 * A picked photo or a captured frame, ready to store.
 *
 * `decodeImage` is the scan pipeline's own decoder, so an upload here gets the
 * same EXIF-correct, orientation-fixed canvas a scan does — a card photographed
 * sideways is stored the way the user saw it, not the way the sensor did.
 */
export async function cardImageFromFile(file: Blob): Promise<CardImageResult> {
  const canvas = await decodeImage(file, IMAGE_MAX_EDGE)
  const result = encodeCardImage(canvas)
  canvas.width = 0
  canvas.height = 0
  if (!result) throw new Error("That image couldn't be saved — try a different photo")
  return result
}

/** Same, from a canvas the scanner already has in hand (a missed capture). */
export function cardImageFromCanvas(source: HTMLCanvasElement): CardImageResult | null {
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(source.width, source.height))
  const sized = scaled(source, scale)
  return encodeCardImage(sized)
}

/** Rough human size for the editor, so "too big" is never a surprise. */
export function imageWeight(dataUrl: string): string {
  // base64 carries 3 bytes per 4 characters; close enough for a hint.
  const kb = Math.round((dataUrl.length * 0.75) / 1024)
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
}

export { MAX_IMAGE_BYTES }
