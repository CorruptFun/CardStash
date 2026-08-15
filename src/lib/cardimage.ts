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
 * Pokémon API's large), and nothing in this app paints a card bigger than
 * ~200 CSS px (the collection grid; the card sheet's is 108). 720 therefore
 * already carries roughly 3x headroom over the largest real render, which is
 * the right amount — a user's own photo sitting next to catalog art must not
 * be the one that looks soft — and more would cost bytes on every device that
 * ever syncs the row while showing nobody anything.
 */
export const IMAGE_MAX_EDGE = 720

/**
 * THE BUDGET IS A TARGET, NOT A CEILING, and that distinction is the whole
 * point of this ladder.
 *
 * The obvious implementation — encode at good quality, accept it if it fits
 * under the hard cap — means every picture lands just under the cap, because
 * essentially every picture fits. Measured on the committed card photographs
 * (`tests/harness/photos`), q0.82 at 720px produces a median of 78 KB and a
 * p90 of 105 KB, and all of it was "fitting" a 220 KB limit. Six hundred
 * patched cards would then be ~47 MB of IndexedDB on a phone that evicts
 * storage under pressure, and ~47 MB of base64 inside every backup.
 *
 * So the ladder steps DOWN until it reaches the target, and only falls back to
 * the hard cap for an image that genuinely will not compress. What it costs is
 * measurable and small: at the 420px a card is actually painted at, dropping
 * q0.82 → q0.72 costs about 0.9 dB PSNR and saves ~30% of the bytes, and every
 * step below that trades steadily less quality for steadily fewer bytes.
 *
 * Sizes here are data-URL CHARACTERS, which is what actually gets stored —
 * base64 is ~33% larger than the raw image bytes, and that overhead is real
 * cost, not an accounting detail.
 */
export const TARGET_IMAGE_BYTES = 64_000

/**
 * Quality ladder. Starts below the point where WebP stops buying visible
 * quality on a photograph and walks down; the floor is where card text starts
 * to smear, which matters because people photograph cards to read them.
 */
const QUALITY_STEPS = [0.8, 0.72, 0.64, 0.56, 0.48, 0.4]
/**
 * If quality alone cannot reach the target, shrink and walk again. A busy
 * full-art holo under bad light is the case that gets here; 0.75 of 720 is
 * 540px, still comfortably above the largest render.
 */
const SCALE_STEPS = [1, 0.75, 0.6]

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
  /**
   * The best thing seen so far that is at least STORABLE (under the hard cap),
   * kept so a picture that never reaches the target still gets saved rather
   * than refused. Smallest wins, because by the time we are here every
   * candidate has already been judged too big.
   */
  let fallback: CardImageResult | null = null

  for (const scale of SCALE_STEPS) {
    const canvas = scaled(source, scale)
    for (const quality of QUALITY_STEPS) {
      const dataUrl = canvasToDataUrl(canvas, type, quality)
      const clean = sanitizeImage(dataUrl)
      // `sanitizeImage` refuses anything over the hard cap, so a null here at
      // high quality is "too big", not "broken" — keep stepping down.
      if (!clean) continue
      const result = {
        dataUrl: clean,
        hash: imageHash(clean),
        width: canvas.width,
        height: canvas.height,
        bytes: clean.length,
      }
      if (clean.length <= TARGET_IMAGE_BYTES) return result
      if (!fallback || result.bytes < fallback.bytes) fallback = result
    }
  }
  return fallback
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

/**
 * Rough human size for a count of data-URL characters.
 *
 * base64 carries 3 bytes per 4 characters, so the stored string is ~33% larger
 * than the image it holds. This reports the IMAGE size, which is the number a
 * person recognises from their photo library.
 */
export function weightOfChars(chars: number): string {
  const kb = Math.round((chars * 0.75) / 1024)
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
}

/** The same, for one encoded image — used by the editor. */
export function imageWeight(dataUrl: string): string {
  return weightOfChars(dataUrl.length)
}

export { MAX_IMAGE_BYTES }
