import type { Card } from './types'
import { frameHash, hammingDistance } from './vision'

/**
 * Art-hash printing re-pick — the mechanism for printings that differ only by
 * ARTWORK.
 *
 * A basic land, an alternate-art common, a borderless reprint: same name,
 * often the same frame and treatment, different picture. Nothing else in the
 * pipeline can reach that class — the collector line is exactly the type that
 * fails on such cards, `printingTiebreak`'s own guard exits when the
 * treatments don't differ, and a fuzzy name match answers with the catalog's
 * default printing. The artwork is the only discriminator, and the app is
 * already allowed to look at it: candidate `imageSmall`s are the same catalog
 * images the UI shows, served by CDNs that answer CORS (measured — Scryfall,
 * TCGdex and TCGplayer all send `access-control-allow-origin: *`; see the
 * scan-harness skill, lesson 77).
 *
 * Everything here is bounded by the spike that preceded it (lesson 77):
 *
 * - A single-rect hash comparison DIES at ≥2% crop jitter, so the capture
 *   side hashes a ±4% SHIFT GRID and every distance is min-over-shifts.
 * - Absolute thresholds are wrong — the borderless margin measured 22 vs 36
 *   — so the decision is rank-among-candidates with a minimum separation,
 *   and candidates come only from an exact-name printings list, so a
 *   different card is never a reachable answer (the tie-break's own rule).
 * - The swap must beat the CURRENT answer's art group, not merely win: when
 *   the incumbent's art wins the argmin, the answer stands and nothing
 *   changes hands.
 */

export interface ArtRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where the art sits on an MTG card, as fractions of the full card. Validated
 * by the spike against real full-card scans (regular and borderless alike —
 * on a full-bleed frame the rect simply samples art). Catalog smalls are
 * full-card scans, so the same rect serves both sides of the comparison.
 */
const MTG_ART_RECT: ArtRect = { x: 0.08, y: 0.11, w: 0.84, h: 0.43 }

/** Games the re-pick knows an art rect for. The seam is game-agnostic. */
export function artRectFor(game: string): ArtRect | null {
  return game === 'mtg' ? MTG_ART_RECT : null
}

/**
 * The capture-side shift grid: ±4% of the card in 2% steps, both axes. 25
 * hashes of a 9×8 downsample — microseconds, not a budget item. Measured:
 * this is what turns 26–51 bits of jitter-induced distance back into the
 * aligned ~15–25, while different arts stay ≥36.
 */
const SHIFTS: ReadonlyArray<readonly [number, number]> = (() => {
  const steps = [-0.04, -0.02, 0, 0.02, 0.04]
  const grid: (readonly [number, number])[] = []
  for (const dx of steps) for (const dy of steps) grid.push([dx, dy] as const)
  return grid
})()

/** Swap only when a different art wins by at least this many bits… */
const ART_MARGIN = 10
/** …and looks like the SAME art in absolute terms (true-art measured ≤22). */
const ART_MAX_DISTANCE = 40
/**
 * Distinct arts compared, newest first. A cap so a heavily-reprinted name
 * cannot turn one scan into an image crawl; newest-first because it is the
 * only neutral order when the answer is unknown (lesson 76: a cap ordered by
 * the BELIEVED printing protects the favourite, and the believed printing is
 * the one the fuzzy match got wrong). The incumbent's own art always joins,
 * cap or no cap, or "did a different art win?" could not be asked honestly.
 */
const MAX_ARTS = 16
/** Wall-clock ceiling on the whole image round. */
const ART_FETCH_BUDGET_MS = 6_000
/** Parallel image fetches — smalls are ~15KB; three keeps phones polite. */
const FETCH_CONCURRENCY = 3

export interface ArtGroup {
  /** illustration_id when the catalog has one, else the print's own id. */
  key: string
  /** Newest raw print carrying this art. */
  raw: any
  /** Its small-image URL, if any print in the group has one. */
  url: string | null
}

/**
 * Distinct arts of one name, newest first, capped at MAX_ARTS — except the
 * incumbent's group, which always makes the list.
 */
export function artGroups(raws: any[], currentApiId?: string | null): ArtGroup[] {
  const groups = new Map<string, ArtGroup>()
  for (const raw of raws) {
    if (!raw?.id || raw.digital) continue
    const key = String(raw.illustration_id ?? raw.id)
    const url = raw.image_uris?.small ?? null
    const existing = groups.get(key)
    if (existing) {
      if (!existing.url && url) existing.url = url
      continue
    }
    groups.set(key, { key, raw, url })
  }
  const all = [...groups.values()]
  if (all.length <= MAX_ARTS) return all
  const currentKey = currentApiId ? artGroupKeyOf(raws, currentApiId) : null
  const kept = all.slice(0, MAX_ARTS)
  if (currentKey && !kept.some((g) => g.key === currentKey)) {
    const current = all.find((g) => g.key === currentKey)
    if (current) kept[kept.length - 1] = current
  }
  return kept
}

/** The art-group key of the print `apiId` names, if it is in the list. */
export function artGroupKeyOf(raws: any[], apiId: string): string | null {
  const raw = raws.find((r) => String(r?.id) === String(apiId))
  return raw ? String(raw.illustration_id ?? raw.id) : null
}

export interface ArtScore {
  key: string
  d: number
}

/**
 * The decision, pure and testable: does a DIFFERENT art beat the incumbent
 * decisively? Refuses on any weaker footing — one scored group, the
 * incumbent winning, a thin margin, or a "winner" too far from everything to
 * be the same art at all.
 */
export function decideByArt(
  scores: ArtScore[],
  currentKey: string | null,
): { key: string; d: number; margin: number } | null {
  if (scores.length < 2) return null
  const ranked = [...scores].sort((a, b) => a.d - b.d)
  const [best, second] = ranked
  if (!currentKey || best.key === currentKey) return null
  if (best.d > ART_MAX_DISTANCE) return null
  const margin = second.d - best.d
  if (margin < ART_MARGIN) return null
  return { key: best.key, d: best.d, margin }
}

/** Clamp a fraction rect into [0,1] so a shifted rect never samples off-frame. */
function clampRect(rect: ArtRect): ArtRect {
  const x = Math.min(Math.max(rect.x, 0), 1)
  const y = Math.min(Math.max(rect.y, 0), 1)
  return { x, y, w: Math.min(rect.w, 1 - x), h: Math.min(rect.h, 1 - y) }
}

/**
 * Hash the CAPTURED art at every shift. `mapRect` is the same card→frame
 * mapping the corner regions ride, so detector jitter shifts these rects in
 * card coordinates exactly the way it shifts the art itself.
 */
export function captureArtHashes(
  canvas: HTMLCanvasElement,
  art: ArtRect,
  mapRect: (rect: ArtRect) => ArtRect,
): string[] {
  const hashes: string[] = []
  for (const [dx, dy] of SHIFTS) {
    const r = clampRect(mapRect(clampRect({ x: art.x + dx, y: art.y + dy, w: art.w, h: art.h })))
    hashes.push(
      frameHash(canvas, {
        x: r.x * canvas.width,
        y: r.y * canvas.height,
        w: r.w * canvas.width,
        h: r.h * canvas.height,
      }),
    )
  }
  return hashes
}

/** Hash a catalog scan's art region (full-card image, no detection involved). */
export function catalogArtHash(image: ImageBitmap, art: ArtRect): string {
  return frameHash(image, {
    x: art.x * image.width,
    y: art.y * image.height,
    w: art.w * image.width,
    h: art.h * image.height,
  })
}

/**
 * `fetch()` rather than an <img>: the response is CORS-checked (so the hash
 * never touches a tainted surface), a failure is a value rather than an
 * event, and the harness's stub layer can serve it offline. Any trouble —
 * offline, 404, a CDN without CORS — returns null and the caller declines.
 */
async function loadCatalogImage(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url, { mode: 'cors', signal })
    if (!res.ok) return null
    return await createImageBitmap(await res.blob())
  } catch {
    return null
  }
}

export interface ArtPick {
  raw: any
  distance: number
  margin: number
  /** Scores actually measured, best first — for the trace. */
  scored: ArtScore[]
}

/**
 * The whole re-pick: group, fetch, hash, decide. Returns null for every way
 * of declining — the caller keeps its answer and loses nothing.
 */
export async function pickPrintingByArt(
  current: Card,
  raws: any[],
  captureHashes: string[],
  signal?: AbortSignal,
): Promise<ArtPick | null> {
  const groups = artGroups(raws, current.apiId).filter((g) => g.url)
  if (groups.length < 2) return null
  const currentKey = artGroupKeyOf(raws, current.apiId)
  if (!currentKey) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ART_FETCH_BUDGET_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const scores: ArtScore[] = []
  try {
    let next = 0
    const worker = async () => {
      while (next < groups.length && !controller.signal.aborted) {
        const group = groups[next++]
        const image = await loadCatalogImage(group.url!, controller.signal)
        if (!image) continue
        const catalog = catalogArtHash(image, MTG_ART_RECT)
        image.close()
        let best = Infinity
        for (const hash of captureHashes) best = Math.min(best, hammingDistance(hash, catalog))
        scores.push({ key: group.key, d: best })
      }
    }
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, groups.length) }, worker))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  // The incumbent's art must actually have been scored: deciding "a different
  // art wins" against an incumbent whose image failed to load would swap on
  // one-sided evidence.
  if (!scores.some((s) => s.key === currentKey)) return null
  const verdict = decideByArt(scores, currentKey)
  if (!verdict) return null
  const winner = groups.find((g) => g.key === verdict.key)
  if (!winner) return null
  return {
    raw: winner.raw,
    distance: verdict.d,
    margin: verdict.margin,
    scored: [...scores].sort((a, b) => a.d - b.d),
  }
}
