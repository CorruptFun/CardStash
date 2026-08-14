import { CAPTURE_MAX_EDGE, decodeImage } from './camera'
import { identifyFrame, PAGE_SCAN_BUDGET, type IdentifyOutcome } from './identify'
import { detectCardRegions, frameHash, type CardDetection } from './vision'

/**
 * Multi-card scanning: a binder page, a stack fanned on a table, a row of
 * cards in a photo. `detectCardRegions` finds them, each crop is identified on
 * its own, and the caller shows a REVIEW screen before anything is written.
 *
 * Nothing here adds a card. A binder page files ~9 rows in one confirmation,
 * so a silent wrong card is nine times more expensive than in single scanning
 * — the user confirms, always.
 */

/**
 * Long-edge cap for a multi-card source, ABOVE the single-card
 * CAPTURE_MAX_EDGE (1600) on purpose. A 3x3 page cut out of a 1600px frame
 * leaves each card ~500px wide, and camera.ts documents ~790px as where the
 * printed collector fraction stops being legible — so a page scaled like a
 * single card would arrive at the pipeline pre-blinded, and the collector-line
 * rescue that identifies foils and non-English cards could never fire.
 * Scaling by the grid instead lands each crop at single-card resolution.
 * 3200x2400 is 7.7M pixels, inside Safari's 16.7M canvas ceiling.
 */
export const PAGE_MAX_EDGE = 3200

/**
 * A 3x3 binder page is 9; the extra room covers a 4x3 page and the odd
 * double-counted slot without letting a pathological frame queue 40
 * identifications.
 */
export const MAX_PAGE_CARDS = 12

/**
 * Each crop is kept as a JPEG for the review screen — shown as the row's
 * thumbnail, and decoded again if the user retries that one card. Keeping the
 * CANVASES instead would hold ~6MB of backing store each: nine of them is
 * 58MB of live RGBA sitting behind a screen the user reads at their own pace,
 * on the device least able to spare it. The same picture as a JPEG is ~200KB.
 */
const KEEP_QUALITY = 0.82

/**
 * Grow each detection slightly before cropping. The detector returns the
 * card's BORDER, and a crop exactly on it can shave the outermost pixels of a
 * name or the collector line at the bottom edge — the same over-tightening
 * that once cut the "C" off Counterspell (vision.ts). Erring outward is free:
 * a crop a few percent proud of the card still reads as a near-full frame to
 * `refineCardCrop`, which then maps rather than re-crops.
 */
const CROP_PAD = 0.035

export interface PageCard {
  /** Stable key for the review list. */
  id: string
  region: CardDetection
  /**
   * JPEG data URL of the crop: the review row's thumbnail, and the input a
   * per-row retry re-reads. Bounded to single-card capture resolution.
   */
  image: string
  outcome: IdentifyOutcome
}

export interface PageScanProgress {
  done: number
  total: number
}

function cropRegion(source: HTMLCanvasElement, region: CardDetection): HTMLCanvasElement {
  const padX = region.w * CROP_PAD
  const padY = region.h * CROP_PAD
  const x0 = Math.max(0, (region.x - padX) * source.width)
  const y0 = Math.max(0, (region.y - padY) * source.height)
  const x1 = Math.min(source.width, (region.x + region.w + padX) * source.width)
  const y1 = Math.min(source.height, (region.y + region.h + padY) * source.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(x1 - x0))
  canvas.height = Math.max(1, Math.round(y1 - y0))
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(
    source, x0, y0, x1 - x0, y1 - y0, 0, 0, canvas.width, canvas.height,
  )
  return canvas
}

function keepAsJpeg(crop: HTMLCanvasElement): string {
  const scale = Math.min(1, CAPTURE_MAX_EDGE / Math.max(crop.width, crop.height))
  if (scale === 1) return crop.toDataURL('image/jpeg', KEEP_QUALITY)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(crop.width * scale))
  canvas.height = Math.max(1, Math.round(crop.height * scale))
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(crop, 0, 0, canvas.width, canvas.height)
  const url = canvas.toDataURL('image/jpeg', KEEP_QUALITY)
  release(canvas)
  return url
}

/**
 * Reading order — rows top to bottom, then left to right within a row — so the
 * review list is in the same order as the page the user is holding. Sorting by
 * `y` alone interleaves the rows, because cards in one row never sit at
 * exactly the same height.
 */
function inReadingOrder(regions: CardDetection[]): CardDetection[] {
  if (regions.length < 2) return regions.slice()
  const rowHeight = regions.reduce((sum, r) => sum + r.h, 0) / regions.length
  return regions
    .slice()
    .sort((a, b) => a.y - b.y)
    .reduce<CardDetection[][]>((rows, region) => {
      const row = rows[rows.length - 1]
      // Same row while the centres sit within half a card of each other.
      if (row && Math.abs(region.y + region.h / 2 - (row[0].y + row[0].h / 2)) < rowHeight * 0.5) row.push(region)
      else rows.push([region])
      return rows
    }, [])
    .flatMap((row) => row.sort((a, b) => a.x - b.x))
}

/** Let go of a big canvas explicitly — Safari holds the backing store otherwise. */
function release(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

/**
 * Find every card in `source` and identify each one.
 *
 * Sequential by design. The OCR worker pool is shared and small, so running
 * nine identifications concurrently would contend for it rather than finish
 * sooner — and a phone doing nine card reads back to back is the heaviest
 * thing this app ever asks of it. Each card runs on PAGE_SCAN_BUDGET (a
 * fraction of the single-card budget), the signal aborts between cards as well
 * as inside one, and nothing here fires on its own: a page scan is always a
 * deliberate tap.
 */
export async function scanPage(
  source: HTMLCanvasElement,
  opts: { signal?: AbortSignal; maxCards?: number; onProgress?: (progress: PageScanProgress) => void } = {},
): Promise<PageCard[]> {
  const regions = inReadingOrder(detectCardRegions(source, opts.maxCards ?? MAX_PAGE_CARDS))
  const out: PageCard[] = []
  opts.onProgress?.({ done: 0, total: regions.length })
  for (let i = 0; i < regions.length; i++) {
    if (opts.signal?.aborted) break
    const region = regions[i]
    const crop = cropRegion(source, region)
    let outcome: IdentifyOutcome
    try {
      outcome = await identifyFrame({ canvas: crop }, frameHash(crop), {
        // The user asked for THIS page: a stale miss on a similar-looking
        // crop must not answer for a card they can see in front of them.
        ignoreMisses: true,
        mode: 'card',
        signal: opts.signal,
        budget: PAGE_SCAN_BUDGET,
      })
    } catch (err: any) {
      if (opts.signal?.aborted) {
        release(crop)
        break
      }
      outcome = { ok: false, reason: 'ocr-miss', message: String(err?.message ?? err).slice(0, 120) }
    }
    out.push({ id: `${i}:${region.x.toFixed(3)}:${region.y.toFixed(3)}`, region, image: keepAsJpeg(crop), outcome })
    release(crop)
    opts.onProgress?.({ done: i + 1, total: regions.length })
  }
  return out
}

/**
 * Re-read ONE card from the review screen, on the full single-card budget.
 *
 * A page scan trades depth for breadth — PAGE_SCAN_BUDGET is a fraction of
 * what a single card gets — so the card the user is squinting at deserves the
 * budget it would have had if they had scanned it alone. This is the "fix"
 * half of "fix or discard": the alternative is making them leave the page and
 * lose the other eight rows.
 */
export async function rescanPageCard(card: PageCard, signal?: AbortSignal): Promise<IdentifyOutcome> {
  const canvas = await decodeImage(card.image, CAPTURE_MAX_EDGE)
  try {
    return await identifyFrame({ canvas }, frameHash(canvas), { ignoreMisses: true, mode: 'card', signal })
  } catch (err: any) {
    return { ok: false, reason: 'ocr-miss', message: String(err?.message ?? err).slice(0, 120) }
  } finally {
    release(canvas)
  }
}
