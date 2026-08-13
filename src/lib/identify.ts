import { type FrameCapture } from './camera'
import { bestMatchAcrossGames, matchGame } from './cardsearch'
import { isAbort } from './fetchJson'
import {
  CORNER_REGION,
  CORNER_RETRY_REGIONS,
  parseCornerInfo,
  parsePasscode,
  sameYgoCode,
  SOLE_EVIDENCE_REGIONS,
  YGO_PASSCODE_REGION,
  type CornerRead,
} from './corner'
import { LIGHT_MATCH_GAMES } from './games'
import { nameBands, readCardNames, readCardNamesAnywhere, readRegionText, readSealedLines, type OcrRect } from './ocr'
import { matchPokemon, pokemonByCollector } from './pokemon'
import { beginScanTrace, endScanTrace, traceEvent } from './scandebug'
import { mtgBySetNumber, mtgMatchTraits, mtgPrintings } from './scryfall'
import { identifySealedText } from './sealed'
import { settings } from './settings'
import { catalogByCollector, isCatalogGame } from './tcgcsv'
import type { Card, Game } from './types'
import { detectFoil, hammingDistance, refineCardCrop } from './vision'
import { normalizeName, similarity } from './util'
import { ygoById, ygoPrintingVariants } from './ygo'

export type ScanMode = 'card' | 'sealed'

/*
 * Identification is fully on-device: Tesseract reads the name band and the
 * collector line, pixel analysis reads the foil sheen, and the card APIs are
 * only consulted by name/set/number. No cloud vision involved — the Gemini
 * key (if any) is for the AI deck builder alone.
 */

/* Frame-hash cache: skip re-identifying the same card sitting on the table. */

interface CacheEntry {
  hash: string
  mode: ScanMode
  /** The game filter the attempt ran under — a miss under 'auto' must not
   * suppress a retry after the user picks the right game. */
  hint?: Game
  card: Card | null
  /** Foil sheen read off the physical copy — kept so cached hits price right. */
  foil?: boolean
  at: number
}

const cache: CacheEntry[] = []
const CACHE_LIMIT = 60
/** A full miss now burns a multi-pass OCR sweep — don't re-burn the same
 * unchanged frame twice a minute; a tap rescans instantly regardless. */
const MISS_TTL_MS = 30_000
const HASH_TOLERANCE = 10

function cacheLookup(hash: string, mode: ScanMode, hint?: Game): CacheEntry | null {
  const now = Date.now()
  for (const entry of cache) {
    if (entry.mode === mode && hammingDistance(entry.hash, hash) <= HASH_TOLERANCE) {
      // A miss only counts against the same filter it was produced under.
      if (entry.card === null && entry.hint !== hint) continue
      return entry.card === null && now - entry.at > MISS_TTL_MS ? null : entry
    }
  }
  return null
}

function cacheStore(hash: string, mode: ScanMode, hint: Game | undefined, card: Card | null, foil?: boolean): void {
  cache.unshift({ hash, mode, hint, card, foil, at: Date.now() })
  if (cache.length > CACHE_LIMIT) cache.length = CACHE_LIMIT
}

export function clearScanCache(): void {
  cache.length = 0
}

export type IdentifyOutcome =
  | { ok: true; card: Card; identification: IdentificationMeta }
  | {
      ok: false
      reason: 'ocr-miss' | 'cached-miss' | 'api'
      message: string
      readName?: string
      readGame?: Game
    }

export interface IdentificationMeta {
  game: Game
  name: string
  setCode?: string | null
  number?: string | null
  confidence: number
  via: 'ocr' | 'cache'
  /** The physical copy showed a foil/holo sheen (on-device detector). */
  foil?: boolean
}

export async function identifyFrame(
  capture: FrameCapture,
  hash: string,
  opts: { ignoreMisses?: boolean; mode?: ScanMode; signal?: AbortSignal } = {},
): Promise<IdentifyOutcome> {
  const mode = opts.mode ?? 'card'
  const config = settings()
  const gameHint = config.gameFilter === 'auto' ? undefined : config.gameFilter
  beginScanTrace(mode, gameHint)
  const startedAt = Date.now()
  /** Every exit funnels through here so the diagnostics trace always closes. */
  const finish = (outcome: IdentifyOutcome): IdentifyOutcome => {
    endScanTrace(
      outcome.ok
        ? {
            ok: true,
            name: outcome.card.name,
            game: outcome.card.game,
            setCode: outcome.identification.setCode ?? outcome.card.setCode,
            number: outcome.identification.number ?? outcome.card.number,
            via: outcome.identification.via,
            confidence: outcome.identification.confidence,
            ms: Date.now() - startedAt,
          }
        : { ok: false, reason: outcome.reason, message: outcome.message, name: outcome.readName, ms: Date.now() - startedAt },
    )
    return outcome
  }
  const cached = cacheLookup(hash, mode, gameHint)
  const cacheUsable = cached && (!cached.card || !gameHint || cached.card.game === gameHint)
  if (cacheUsable && cached.card) {
    traceEvent('cache', { hit: true, card: cached.card.name })
    return finish({
      ok: true,
      card: cached.card,
      identification: {
        game: cached.card.game,
        name: cached.card.name,
        setCode: cached.card.setCode,
        number: cached.card.number,
        confidence: 1,
        via: 'cache',
        foil: cached.foil,
      },
    })
  }
  if (cacheUsable && !opts.ignoreMisses) {
    traceEvent('cache', { hit: false })
    return finish({ ok: false, reason: 'cached-miss', message: 'Same frame as a recent miss' })
  }

  const outcome =
    mode === 'sealed'
      ? await identifySealedFrame(capture.canvas, gameHint)
      : await identifyViaOcr(capture.canvas, gameHint, opts.signal)
  if (outcome.ok) {
    // Cache only well-evidenced hits: a collector-line-only identification
    // (confidence 0.7) must be re-derived per attempt, not re-served at
    // cache confidence.
    if (outcome.identification.confidence >= 0.75)
      cacheStore(hash, mode, gameHint, outcome.card, outcome.identification.foil)
  }
  // Cache unreadable frames too: the same card sitting unchanged shouldn't
  // re-burn OCR + lookups every retry. A manual rescan tap bypasses this.
  else if (outcome.reason === 'ocr-miss') cacheStore(hash, mode, gameHint, null)
  return finish(outcome)
}

/** Pack/box front → set name → the set's sealed product. All on-device OCR. */
async function identifySealedFrame(canvas: HTMLCanvasElement, gameHint: Game | undefined): Promise<IdentifyOutcome> {
  let lines: string[]
  try {
    lines = await readSealedLines(canvas)
  } catch {
    return { ok: false, reason: 'api', message: 'OCR engine failed to load — check connection' }
  }
  traceEvent('sealed-ocr', { lines })
  if (!lines.length) {
    return { ok: false, reason: 'ocr-miss', message: 'Couldn’t read the packaging — fill the frame with the front' }
  }
  let match
  try {
    match = await identifySealedText(lines, gameHint ? [gameHint] : undefined)
  } catch {
    return { ok: false, reason: 'api', message: 'Couldn’t reach the product catalog', readName: lines[0] }
  }
  if (!match) {
    return {
      ok: false,
      reason: 'ocr-miss',
      message: `Read “${lines[0]}” but couldn’t match a set — get the set name in frame`,
      readName: lines[0],
      readGame: gameHint,
    }
  }
  return {
    ok: true,
    card: match.card,
    identification: {
      game: match.game,
      name: match.card.name,
      setCode: match.card.setCode,
      confidence: match.score,
      via: 'ocr',
    },
  }
}

const OCR_MATCH_THRESHOLD = 0.66
/** Short reads need a higher bar: one edit on 4 letters already scores 0.75,
 * which is how "loli" became Loki and "son" became Sona. Genuine short reads
 * (champion leads like "JINX") score ≈1 and clear it comfortably. */
const OCR_MATCH_THRESHOLD_SHORT = 0.82
const SHORT_READ_LEN = 8
/** Reads still carrying junk tokens get a middle bar — their inflated edit
 * distance otherwise squeaks wrong cards past the base threshold. */
const OCR_MATCH_THRESHOLD_NOISY = 0.72

function matchThresholdFor(read: string): number {
  const normalized = read.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (normalized.length < SHORT_READ_LEN) return OCR_MATCH_THRESHOLD_SHORT
  const tokens = read.split(/\s+/)
  const junk = tokens.filter((t) => (t.match(/[A-Za-z]/g) ?? []).length < 3 && !/^(?:ex|gx|v|x)$/i.test(t)).length
  return junk / tokens.length > 0.3 ? OCR_MATCH_THRESHOLD_NOISY : OCR_MATCH_THRESHOLD
}
/** Per-game budget for a name lookup: one slow card API mustn't stall the frame. */
const OCR_MATCH_TIMEOUT_MS = 6_000
/** A single hinted game has no four-way fan-out — its API gets longer (the keyless Pokémon API needs it). */
const OCR_MATCH_TIMEOUT_HINTED_MS = 9_000
/** Candidates tried per band. Candidates arrive plausibility-ranked, but a
 * fused plate row (name + faction + type) can still push the clean name a few
 * slots down — the budget must reach it. */
const OCR_NAMES_PER_BAND = 6
/** Auto-mode collector-line crop: the bottom strip every game but YGO prints it in. */
const CORNER_STRIP: OcrRect = { x: 0, y: 0.85, w: 1, h: 0.15 }
/** Full-magnification OCR passes the sole-evidence corner sweep may spend.
 * Every one of them is paid on a MISS, while the scanner is still running —
 * keep it tight enough that an unreadable card doesn't cook the phone. */
const SOLE_EVIDENCE_PASS_BUDGET = 5

async function identifyViaOcr(
  frame: HTMLCanvasElement,
  gameHint: Game | undefined,
  signal?: AbortSignal,
): Promise<IdentifyOutcome> {
  /** Checked between passes: a stopped scanner must not keep escalating
   * OCR passes and lookups in the background. */
  const bail = () => {
    if (signal?.aborted) throw new DOMException('Scan attempt aborted', 'AbortError')
  }
  // The reticle crop is a fixed window; the card in it is regularly smaller,
  // off-center or slightly rolled. Tighten to the detected card and deskew
  // before any OCR — every band below assumes card-relative geometry.
  const refined = refineCardCrop(frame)
  const canvas = refined.canvas
  traceEvent('crop', {
    applied: refined.applied,
    angle: refined.angle,
    ...(refined.region ? { x: refined.region.x, y: refined.region.y, w: refined.region.w, h: refined.region.h } : {}),
    ...(refined.cardRegion ? { card: refined.cardRegion } : {}),
  })
  // The tiny collector-line crops need card-relative precision even when the
  // frame wasn't worth cropping — map them through the detected card region.
  const mapRect = (rect: OcrRect): OcrRect => {
    const card = refined.cardRegion
    if (!card) return rect
    return {
      x: card.x + rect.x * card.w,
      y: card.y + rect.y * card.h,
      w: rect.w * card.w,
      h: rect.h * card.h,
    }
  }
  // No hint: only sweep games with a cheap by-name API. Catalog-backed games
  // (Riftbound & co.) are reachable by picking them in the scan game filter.
  const games = gameHint ? [gameHint] : LIGHT_MATCH_GAMES
  const config = settings()
  const timeoutMs = games.length === 1 ? OCR_MATCH_TIMEOUT_HINTED_MS : OCR_MATCH_TIMEOUT_MS
  const tried = new Set<string>()
  let firstRead: string | undefined
  let cornerText: Promise<string> | null = null
  // Attempt-wide budget against DYING APIs: fast lookups are nearly free and
  // deep candidate exploration is the accuracy win, but lookups riding their
  // multi-second timeouts must not stretch one attempt into minutes — only
  // those count against the budget, plus a hard wall-clock deadline.
  let slowLookupsLeft = 4
  const lookupDeadline = Date.now() + 20_000
  const SLOW_LOOKUP_MS = 1_500

  /** Candidates not yet consumed by a lookup; remember the first plausible read. */
  const freshOf = (names: string[]): string[] => {
    const fresh = names.filter((name) => !tried.has(name.toLowerCase()))
    firstRead ??= fresh[0]
    return fresh
  }

  /** Look the candidates up; a confident hit is refined to the exact edition. */
  const tryCandidates = async (fresh: string[]): Promise<IdentifyOutcome | null> => {
    if (!fresh.length) return null
    // Queue the collector-line OCR now: it runs on the secondary OCR worker
    // (or on the primary, idle while the name candidates are out on the
    // network), so the line is usually read "for free" by the time a match
    // wants it. With a game hint the crop is that game's exact region; in
    // auto mode the shared bottom strip covers every game but Yu-Gi-Oh,
    // whose mid-card code refineFromCorner re-reads.
    cornerText ??= readRegionText(canvas, mapRect(gameHint ? CORNER_REGION[gameHint] : CORNER_STRIP)).catch(() => '')
    for (const name of fresh.slice(0, OCR_NAMES_PER_BAND)) {
      if (slowLookupsLeft <= 0 || Date.now() > lookupDeadline) break
      // Consumed here, not at freshOf: candidates past this pass's window
      // stay eligible for the next pass instead of being silently dropped.
      tried.add(name.toLowerCase())
      const lookupStarted = Date.now()
      const best = await bestMatchAcrossGames(name, games, {
        pokemonKey: config.pokemonKey,
        timeoutMs,
      }).catch(() => null)
      const lookupMs = Date.now() - lookupStarted
      if (lookupMs > SLOW_LOOKUP_MS) slowLookupsLeft--
      traceEvent('lookup', {
        read: name,
        games: games.join(','),
        matched: best?.card.name ?? null,
        game: best?.card.game,
        score: best ? Number(best.score.toFixed(3)) : null,
        ms: lookupMs,
      })
      if (!best || best.score < matchThresholdFor(name)) continue
      // Name pinned the card; now read the printed collector line to pin
      // the exact edition, and check the surface for a foil sheen.
      const refined = await refineFromCorner(best.card, canvas, cornerText, !!gameHint, mapRect, config.pokemonKey).catch(() => null)
      let card = refined?.card ?? best.card
      const foil = detectFoil(canvas)
      traceEvent('refine', {
        setCode: refined?.read.setCode ?? null,
        number: refined?.read.number ?? null,
        total: refined?.read.total ?? null,
        edition: refined ? refined.card.setCode : null,
        foil,
      })
      // Sheen on a printing that never came foil: the copy in hand must be
      // a different printing — re-pick the newest foil-capable one.
      if (foil && !refined && card.game === 'mtg' && !!card.finishes?.length && !card.finishes.some((f) => f !== 'nonfoil')) {
        const better = await mtgMatchTraits(card.name, null, { foil: true }).catch(() => null)
        if (better) card = better
      }
      return {
        ok: true,
        card,
        identification: {
          game: card.game,
          name,
          setCode: refined?.read.setCode,
          number: refined?.read.number,
          confidence: best.score,
          via: 'ocr',
          foil: foil ? true : undefined,
        },
      }
    }
    return null
  }

  // Bands are OCR'd one at a time, the game's most likely name position
  // first (Riftbound & co. print names mid-card, not at the top), so a hit
  // in the first band skips the rest of the work entirely.
  for (const band of nameBands(gameHint)) {
    bail()
    let names: string[]
    try {
      names = await readCardNames(canvas, band)
    } catch {
      if (tried.size || firstRead) break
      return { ok: false, reason: 'api', message: 'OCR engine failed to load — check connection' }
    }
    const hit = await tryCandidates(freshOf(names))
    if (hit) return hit
  }

  // The contrast-stretched pass misreads stylized type over busy art (full
  // arts, foils). Before the heavier sweeps, re-read the game's primary band
  // binarized at higher resolution — in both polarities, since ornate glyph
  // faces routinely defeat the mean-luma polarity heuristic. A different
  // failure surface, so it regularly cracks what the first pass mangled.
  for (const variant of ['binary', 'binary-flip'] as const) {
    bail()
    try {
      const hit = await tryCandidates(freshOf(await readCardNames(canvas, nameBands(gameHint)[0], { variant })))
      if (hit) return hit
    } catch (err) {
      if (isAbort(err)) throw err
      /* fall through to the full sweep */
    }
  }

  // The bands assume a standard frame, but promos, full-art specials and
  // custom cards put names in unexpected places. Before giving up, sweep the
  // whole card once with automatic layout detection and mine every line.
  bail()
  try {
    const hit = await tryCandidates(freshOf(await readCardNamesAnywhere(canvas)))
    if (hit) return hit
  } catch (err) {
    if (isAbort(err)) throw err
    /* the band sweep's verdict below stands */
  }

  // Name reading is out of road (ornate faces, foil sheen over the title —
  // or a non-Latin print the shipped English OCR simply cannot read). The
  // collector line still pins the card, because it stays Latin digits on
  // every print worldwide: a fraction + printed set size (Pokémon, catalog
  // games), an exact set code + collector number (MTG), or the 8-digit
  // passcode (Yu-Gi-Oh).
  if (gameHint) {
    bail()
    try {
      // cornerText (when queued) already covered the exact hinted region;
      // if no candidate ever queued it, let the normal-region read run.
      const read = await readCornerInfo(gameHint, canvas, cornerText, cornerText != null, mapRect, true)
      let card: Card | null = null
      if (gameHint === 'pokemon' && read.number && read.total && (!read.fused || read.setCode)) {
        // A printed slash stands alone; a RECONSTRUCTED fraction ("0207066"
        // — the italic slash read as a digit) identifies only with the
        // printed set code corroborating (pokemonByCollector's fused mode
        // demands code + size + membership all agree). A bare digit run
        // resolving to some real card is exactly how a confident wrong
        // identification would slip out.
        traceEvent('corner-id', { number: read.number, total: read.total, setCode: read.setCode ?? null, fused: read.fused ?? false })
        card = await pokemonByCollector(read.number, read.total, config.pokemonKey, read.setCode, read.fused === true)
      } else if (isCatalogGame(gameHint) && read.number && read.total && !read.fused) {
        traceEvent('corner-id', { number: read.number, total: read.total })
        card = await catalogByCollector(gameHint, read.number, read.total)
      } else if (
        gameHint === 'mtg' &&
        read.setCode &&
        read.number &&
        // Collector numbers are DENSE — a one-digit misread lands on a real
        // neighboring card. Sole-evidence reads must carry the modern
        // frame's zero-padding ("0266") or a self-consistent vintage
        // fraction; the set code itself only parses beside a language token.
        (read.padded === true || (read.total && Number(read.number) <= Number(read.total)))
      ) {
        traceEvent('corner-id', { setCode: read.setCode, number: read.number, total: read.total ?? null })
        card = await mtgBySetNumber(read.setCode, read.number, read.total)
      }
      if (!card && gameHint === 'yugioh') {
        // The passcode identifies the card in every language; the sparse id
        // space means a misread digit resolves to nothing, not a wrong card.
        const passcode = parsePasscode(
          await readRegionText(canvas, mapRect(YGO_PASSCODE_REGION), {
            variant: 'binary',
            upscale: 5,
            maxWidth: 1600,
            sparse: true,
          }).catch(() => ''),
        )
        if (passcode) {
          traceEvent('corner-id', { passcode })
          card = await ygoById(passcode)
          // The mid-card set code, when it was also read, picks the exact
          // printing (rarity moves YGO prices by orders of magnitude).
          if (card && read.number) {
            card = ygoPrintingVariants(card).find((variant) => sameYgoCode(variant.number, read.number)) ?? card
          }
        }
      }
      if (card) {
        return {
          ok: true,
          card,
          identification: {
            game: card.game,
            name: card.name,
            setCode: read.setCode ?? card.setCode,
            number: read.number ?? card.number,
            confidence: 0.7,
            via: 'ocr',
            foil: detectFoil(canvas) ? true : undefined,
          },
        }
      }
    } catch {
      /* the miss verdict below stands */
    }
  }

  return {
    ok: false,
    reason: 'ocr-miss',
    message: firstRead
      ? `Read “${firstRead}” but couldn’t match it`
      : gameHint
        ? 'Couldn’t read the card — more light helps'
        : 'Couldn’t read the card name — more light helps. For non-English cards, pick the game so the collector line can identify them',
    readName: firstRead,
  }
}

function collectorEq(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  const norm = (value: string) => value.toLowerCase().replace(/^0+(?=\d)/, '')
  return norm(a) === norm(b)
}

/**
 * Read the collector line printed on the card (set code / collector number /
 * "123/198") and re-match to that exact edition. The heavy OCR usually
 * already happened: `cornerText` was queued while the name match was out on
 * the network. When that speculative crop reads empty — above all Yu-Gi-Oh
 * in auto mode, whose code sits mid-card rather than in the bottom strip —
 * the game's own region is read as a second chance, unless the speculative
 * crop WAS that region (`cornerIsExact`). Fails soft: any trouble keeps the
 * name-based match.
 */
/**
 * Read the collector line with escalating effort: the speculative strip
 * first, the game's own region, then narrow per-game slivers at full
 * magnification, binarized — the line is tiny type that drowns beside rules
 * text at strip scale.
 *
 * `thorough` (the corner-ONLY path, where this read is the sole evidence)
 * keeps escalating until the read could actually identify something —
 * number AND set code (AND total, where the game prints fractions) — and
 * merges across passes, because the parts can live in opposite polarities:
 * a Japanese Pokémon card prints its set code white-on-black in a badge
 * right beside dark-on-light digits, so no single pass reads both.
 */
async function readCornerInfo(
  game: Game,
  canvas: HTMLCanvasElement,
  cornerText: Promise<string> | null,
  cornerIsExact: boolean,
  mapRect: (rect: OcrRect) => OcrRect,
  thorough = false,
): Promise<CornerRead> {
  const done = (read: CornerRead) =>
    thorough
      ? !!(
          read.number &&
          read.setCode &&
          !read.fused &&
          (game === 'pokemon' ? !!read.total : true) &&
          // Same bar the identify guard applies — a junk fraction that would
          // be rejected there must not stop the escalation here.
          (game === 'mtg'
            ? read.padded === true || (!!read.total && Number(read.number) <= Number(read.total))
            : true)
        )
      : !!(read.setCode || read.number)
  // Keep the strongest fraction — self-consistent slashed > slashed >
  // reconstructed > bare number — and take the set code from whichever pass
  // caught it.
  const merge = (a: CornerRead, b: CornerRead): CornerRead => {
    const rank = (r: CornerRead) => {
      if (!r.number) return 0
      if (!r.total) return 1
      if (r.fused) return 2
      return Number(r.number) <= Number(r.total) ? 4 : 3
    }
    const main = rank(b) > rank(a) ? b : a
    return { ...main, setCode: a.setCode ?? b.setCode }
  }
  // Sole-evidence reads get extra magnification (the set-code badge on a
  // Japanese card is a few pixels of type that 3× upscale smears) and sparse
  // segmentation, which mines the small detached line the default
  // single-block mode drops in favour of the rules box above it.
  const zoom = thorough ? { upscale: 5, maxWidth: 1600, sparse: true } : {}
  let read = parseCornerInfo(game, cornerText ? await cornerText : '')
  // Escalation is bounded: these passes run only after every name read has
  // already failed, and each is a full-magnification OCR — an unbounded
  // sweep would turn every unreadable card into seconds of phone CPU.
  let budget = thorough ? SOLE_EVIDENCE_PASS_BUDGET : 3
  const pass = async (rect: OcrRect, opts: { variant?: 'normal' | 'binary' | 'binary-flip'; sparse?: boolean } = {}) => {
    if (budget <= 0 || done(read)) return
    budget--
    read = merge(read, parseCornerInfo(game, await readRegionText(canvas, rect, { ...zoom, ...opts })))
  }
  // The speculative strip was read cheaply (single-block, 3×) for the refine
  // path; when this read is the sole evidence, re-read the game's own region
  // properly even if the strip already covered it.
  if (!cornerIsExact || thorough) await pass(mapRect(CORNER_REGION[game]))
  const retries = thorough
    ? [...(SOLE_EVIDENCE_REGIONS[game] ?? []), ...(CORNER_RETRY_REGIONS[game] ?? [CORNER_REGION[game]])]
    : (CORNER_RETRY_REGIONS[game] ?? [CORNER_REGION[game]])
  // 'normal' first when thorough: Tesseract's own LOCAL binarization reads
  // mixed-polarity lines (a white set-code badge beside dark digits) that a
  // single global threshold cannot.
  for (const variant of thorough ? (['normal', 'binary'] as const) : (['binary'] as const)) {
    for (const rect of retries) await pass(mapRect(rect), { variant })
  }
  // The detected card region can end ABOVE the printed line (full-bleed
  // captures: the bottom line hugs the card edge, outside the crop
  // detector's floor) — last passes over the RAW frame's bottom band. One
  // stays non-sparse: block segmentation reads the set-code/language line
  // ("NEO・JP") that sparse mode shreds into fragments.
  if (thorough) {
    const bottom: OcrRect = { x: 0, y: 0.9, w: 0.55, h: 0.1 }
    await pass(bottom, { variant: 'normal' })
    await pass(bottom, { variant: 'normal', sparse: false })
  }
  return read
}

async function refineFromCorner(
  card: Card,
  canvas: HTMLCanvasElement,
  cornerText: Promise<string> | null,
  cornerIsExact: boolean,
  mapRect: (rect: OcrRect) => OcrRect,
  pokemonKey?: string,
): Promise<{ card: Card; read: CornerRead } | null> {
  // This read is what tells "Tauros" from "Tauros ex" — it earns the work.
  const read = await readCornerInfo(card.game, canvas, cornerText, cornerIsExact, mapRect)
  if (!read.setCode && !read.number) return null
  let exact: Card | null = null
  if (card.game === 'yugioh') {
    exact = ygoPrintingVariants(card).find((variant) => sameYgoCode(variant.number, read.number)) ?? null
  } else if (card.game === 'pokemon') {
    exact = await matchPokemon(card.name, read.setCode, read.number, pokemonKey, read.total)
  } else if (card.game === 'mtg' && !read.setCode && read.number) {
    // Number without a set code: pick the newest printing carrying it.
    const prints = await mtgPrintings(card.name)
    exact = prints.find((print) => collectorEq(print.number, read.number)) ?? null
  } else {
    exact = await matchGame(card.game, card.name, read.setCode, read.number, { pokemonKey })
  }
  if (!exact || !relatedNames(exact.name, card.name)) return null
  return { card: exact, read }
}

/**
 * May a corner-pinned card replace the name-matched one? Guards against a
 * misread collector line swapping in an unrelated card — while still letting
 * the number upgrade across suffix variants ("Tauros" → "Tauros ex": the
 * printed 183/226 is exactly how the right variant is told apart).
 */
function relatedNames(a: string, b: string): boolean {
  if (similarity(a, b) >= 0.7) return true
  const na = normalizeName(a)
  const nb = normalizeName(b)
  return na.length >= 4 && nb.length >= 4 && (na.startsWith(nb) || nb.startsWith(na))
}
