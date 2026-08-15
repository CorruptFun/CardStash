// Sync + tiny: just reads whether a session exists in localStorage. The cloud
// modules it would otherwise pull in stay behind the dynamic import below.
import { isSignedIn } from './authsession'
import { type FrameCapture } from './camera'
import { bestMatchAcrossGames, matchGame } from './cardsearch'
import { isAbort } from './fetchJson'
import {
  collectorLineAllows,
  CORNER_REGION,
  CORNER_RETRY_REGIONS,
  looksLikeCollectorLine,
  parseCornerInfo,
  parsePasscode,
  parsePokemonVariant,
  pokemonNameSuffix,
  sameYgoCode,
  SOLE_EVIDENCE_REGIONS,
  YGO_PASSCODE_REGION,
  type CornerRead,
} from './corner'
import { GAME_LABEL, LIGHT_MATCH_GAMES } from './games'
import {
  latinWordCount,
  nameBands,
  ocrTimeouts,
  readCardNames,
  readCardNamesAnywhere,
  readRegionText,
  readSealedLines,
  type OcrRect,
} from './ocr'
import { matchPokemon, pokemonByCollector } from './pokemon'
import { beginScanTrace, endScanTrace, traceEvent } from './scandebug'
import { mtgBySetNumber, mtgMatchTraits, mtgPrintings } from './scryfall'
import { identifySealedText } from './sealed'
import { settings } from './settings'
import { catalogByCollector, catalogLeadVariants, isCatalogGame } from './tcgcsv'
import type { Card, Game } from './types'
import { detectFoil, hammingDistance, looksSideways, refineCardCrop, rotateQuarter, type CropRefinement } from './vision'
import { isLeadOnlyMatch, nameLead, normalizeName, similarity } from './util'
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
  /**
   * Which path answered. `cloud` is the opt-in Gemini rescue and is worth
   * distinguishing everywhere it surfaces: it is the only one that cost money
   * and the only one that sent a frame off the device.
   */
  via: 'ocr' | 'cache' | 'cloud'
  /** The physical copy showed a foil/holo sheen (on-device detector). */
  foil?: boolean
}

/**
 * What one attempt may spend. The defaults are the single-card numbers, tuned
 * for a user holding a phone over one card and willing to wait a few seconds
 * for it — a slow miss beats a failure there.
 *
 * A page scan inverts that trade. Nine cards on the single-card budget is up
 * to three minutes of sustained OCR on a device in someone's hand, which is a
 * heat and battery problem long before it is a patience problem, so each card
 * on a page gets a fraction and the breadth pays for the depth.
 */
export interface ScanBudget {
  /** Wall clock for card-API lookups. */
  lookupMs: number
  /** Slow (>1.5s) lookups before the attempt stops exploring candidates. */
  slowLookups: number
  /** Ceiling on OCR escalation before the attempt drops to the collector path. */
  ocrMs: number
  /** Collector-line rescue passes (hinted mode only). */
  cornerPasses: number
}

/**
 * Per-card budget inside a page scan. Roughly a third of a single card's,
 * which puts a nine-card page in the tens of seconds rather than the minutes
 * the full budget would allow — and every card the user actually cares about
 * can still be re-read at full budget from the review screen
 * (`rescanPageCard`), which is where the depth belongs once there is a human
 * looking at one row.
 */
export const PAGE_SCAN_BUDGET: ScanBudget = { lookupMs: 7_000, slowLookups: 2, ocrMs: 6_500, cornerPasses: 2 }

export async function identifyFrame(
  capture: FrameCapture,
  hash: string,
  opts: { ignoreMisses?: boolean; mode?: ScanMode; signal?: AbortSignal; budget?: ScanBudget; cache?: boolean } = {},
): Promise<IdentifyOutcome> {
  const mode = opts.mode ?? 'card'
  const config = settings()
  // The scan filter always sits inside the enabled games (the settings store
  // keeps it there). A lone enabled game needs no sweep — treat it as a hint,
  // which also buys it the exact collector-line crop, the longer budget and
  // the collector-line rescue that identifies non-English cards.
  const gameHint =
    config.gameFilter !== 'auto' ? config.gameFilter : config.enabledGames.length === 1 ? config.enabledGames[0] : undefined
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
  // The frame cache answers "this is the same card still sitting under the
  // camera". A multi-card scan is the opposite situation — a set of DIFFERENT
  // physical cards, deliberately asked for — so it opts out of both halves.
  // Reading would let one slot answer for another within HASH_TOLERANCE,
  // inheriting its printing and its foil flag with neither the collector-line
  // read nor the foil detector ever running; and it would make the review
  // screen's re-read a no-op that returns the same card at cache confidence 1,
  // promoting a row the pipeline was NOT sure about to ticked-and-unflagged on
  // no new evidence. Writing would evict the live scanner's entries and then
  // serve a page's answer back to it.
  const useCache = opts.cache ?? true
  const cached = useCache ? cacheLookup(hash, mode, gameHint) : null
  // A hit must still fit the current filter AND the enabled games — a card
  // scanned just before its game was turned off shouldn't resurface from here.
  const cacheUsable =
    cached &&
    (!cached.card || ((!gameHint || cached.card.game === gameHint) && config.enabledGames.includes(cached.card.game)))
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
      : await identifyViaOcr(capture.canvas, gameHint, opts.signal, opts.budget ?? DEFAULT_BUDGET)
  if (outcome.ok) {
    // Cache only well-evidenced hits: a collector-line-only identification
    // (confidence 0.7) must be re-derived per attempt, not re-served at
    // cache confidence.
    if (useCache && outcome.identification.confidence >= 0.75)
      cacheStore(hash, mode, gameHint, outcome.card, outcome.identification.foil)
  }
  // Cache unreadable frames too: the same card sitting unchanged shouldn't
  // re-burn OCR + lookups every retry. A manual rescan tap bypasses this.
  else if (useCache && outcome.reason === 'ocr-miss') cacheStore(hash, mode, gameHint, null)
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
    match = await identifySealedText(lines, gameHint ? [gameHint] : settings().enabledGames)
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
/**
 * Name-match bar on a frame this pass TURNED upright. Turning is an inferred
 * orientation over fewer pixels, and a partial read there is dangerous in a
 * specific way: Pokémon print the evolution line right under the name, and
 * that line is itself a real card name ("Iono's Tadbulb" on an Iono's
 * Bellibolt ex), so a half-read band matches a genuine wrong card with
 * conviction. Measured on the sideways battery, correct turned hits score
 * 1.00 (exact name) or 0.70 (collector-line evidence, judged separately),
 * while both wrong cards sat at 0.79 — this bar is set in that empty gap.
 *
 * It is applied to the WHOLE printed name, not to `nameScore`: that function
 * forgives a missing epithet on purpose (the card prints "JINX" over "Loose
 * Cannon"), which puts every bare champion lead at exactly 0.95 — 1 − its
 * 0.05 penalty — and a lead cannot tell one sibling from another. Reading a
 * quarter-turned "Ahri - Inquisitive" as "Ahri" duly matched "Ahri -
 * Alluring" at 0.95. Off a turned frame the epithet has to be read too.
 */
const TURNED_MATCH_THRESHOLD = 0.95

/**
 * Confidence for an identification resting on the printed collector line
 * rather than on the name: two agreeing numbers against an independent
 * catalog row. Deliberately under the 0.75 cache-write gate, so these
 * re-derive per attempt instead of being re-served as certainty.
 */
const CORNER_CONFIDENCE = 0.7

/**
 * The bar a CLOUD read's name must clear — far above the 0.66 a local read
 * needs, and above the 0.82 short-read bar too.
 *
 * The asymmetry is the point. A local candidate is one of eight guesses mined
 * out of noisy OCR, so the thresholds are tuned to let a mangled-but-real name
 * through. A cloud read of a legible card comes back essentially exact — the
 * Krookodile frame that defeated every local pass returned "Krookodile ex"
 * with its collector line. So a FUZZY cloud answer is not a degraded read, it
 * is the model guessing, and letting a guess squeak past a low bar would
 * reintroduce the wrong-card class through a new door.
 */
const CLOUD_MATCH_THRESHOLD = 0.9

/**
 * Confidence for a cloud-rescued identification. Below a local exact name hit
 * (1.0), because the evidence is one model's reading rather than a matched
 * name plus an independently printed line; above CORNER_CONFIDENCE. Above the
 * 0.75 cache-write gate on purpose — unlike a corner-only ID this answer is
 * stable for a given frame, and re-deriving it would pay for the same API call
 * twice on a frame the user is still holding in view.
 */
const CLOUD_CONFIDENCE = 0.85

/** Full-magnification OCR passes the sole-evidence corner sweep may spend.
 * Every one of them is paid on a MISS, while the scanner is still running —
 * keep it tight enough that an unreadable card doesn't cook the phone. */
const SOLE_EVIDENCE_PASS_BUDGET = 5

/** The single-card budget: what an attempt spends when one card is in frame. */
const DEFAULT_BUDGET: ScanBudget = { lookupMs: 20_000, slowLookups: 4, ocrMs: 18_000, cornerPasses: SOLE_EVIDENCE_PASS_BUDGET }

/** Card-relative → frame-relative rect mapping for one crop refinement. */
function mapThrough(refined: CropRefinement): (rect: OcrRect) => OcrRect {
  return (rect) => {
    const card = refined.cardRegion
    if (!card) return rect
    return {
      x: card.x + rect.x * card.w,
      y: card.y + rect.y * card.h,
      w: rect.w * card.w,
      h: rect.h * card.h,
    }
  }
}

/**
 * One candidate way up for a captured frame: the crop to read, whether
 * getting there took a quarter turn (which raises the name-match bar), and
 * whether only the orientation-agnostic sweep applies to it.
 */
interface Orientation {
  refined: CropRefinement
  turned: boolean
  /**
   * Every name band is written in upright card coordinates, so a frame we
   * believe is sideways earns only the whole-card PSM-3 sweep — which reads
   * quarter-turned type on its own (Tesseract's layout analysis rotates
   * vertical text lines) and is the pass that identifies these frames today.
   */
  sweepOnly?: boolean
}

/**
 * The ways up worth reading a sideways-looking frame, best first.
 *
 * Both quarter turns are probed at the strip where the collector line is
 * printed; a turn whose strip actually reads like one wins outright. That
 * test is script-agnostic on purpose — a Japanese card offers no other Latin
 * evidence, and the choice must be made before a name has been read or a game
 * is even known.
 *
 * When neither strip parses — the common case, since that line is the tiniest
 * type on the card and a sideways card is physically smaller in frame — the
 * old behaviour was to give up and read the frame as captured, which every
 * band below then missed by a quarter turn. Both turns stay candidates
 * instead, ordered by whether their strip carried readable words at all: the
 * right way up shows rules or flavour text, the wrong way up (180° out) shows
 * the same pixels upside down, which Tesseract cannot read. The frame AS
 * CAPTURED stays last in the list, so a card that was never sideways still
 * gets the read it would have had.
 */
async function uprightOrientations(
  frame: HTMLCanvasElement,
  asIs: CropRefinement,
  gameHint: Game | undefined,
): Promise<Orientation[]> {
  const strip = gameHint ? CORNER_REGION[gameHint] : CORNER_STRIP
  const probe = (refined: CropRefinement) =>
    readRegionText(refined.canvas, mapThrough(refined)(strip), { variant: 'binary' }).catch(() => '')
  // A card already the right way up (a mis-detection) would read its own
  // collector line — so an as-captured hit means: don't turn anything. Probed
  // on the REFINED canvas, since that is the geometry the strip is written in.
  const asCaptured = await probe(asIs)
  if (looksLikeCollectorLine(asCaptured)) {
    traceEvent('upright', { turns: 0, reason: 'as-captured' })
    return [{ refined: asIs, turned: false }]
  }
  const candidates: { turns: number; refined: CropRefinement; words: number }[] = []
  for (const turns of [1, 3]) {
    const refined = refineCardCrop(rotateQuarter(frame, turns))
    const text = await probe(refined)
    if (looksLikeCollectorLine(text)) {
      traceEvent('upright', { turns, raw: text.slice(0, 60) })
      return [{ refined, turned: true }]
    }
    candidates.push({ turns, refined, words: latinWordCount(text) })
  }
  candidates.sort((a, b) => b.words - a.words || a.turns - b.turns)
  traceEvent('upright', {
    turns: null,
    reason: 'both turns',
    order: candidates.map((c) => `${c.turns}:${c.words}w`).join(' '),
  })
  return [
    ...candidates.map((candidate) => ({ refined: candidate.refined, turned: true })),
    { refined: asIs, turned: false, sweepOnly: true },
  ]
}

async function identifyViaOcr(
  frame: HTMLCanvasElement,
  gameHint: Game | undefined,
  signal?: AbortSignal,
  budget: ScanBudget = DEFAULT_BUDGET,
): Promise<IdentifyOutcome> {
  /** Checked between passes: a stopped scanner must not keep escalating
   * OCR passes and lookups in the background. */
  const bail = () => {
    if (signal?.aborted) throw new DOMException('Scan attempt aborted', 'AbortError')
  }
  // The reticle crop is a fixed window; the card in it is regularly smaller,
  // off-center or slightly rolled. Tighten to the detected card and deskew
  // before any OCR — every band below assumes card-relative geometry.
  // (No global pre-lift for dark frames: the OCR prep's per-tile stretch is
  // already a local exposure adaptation, and pre-amplifying defeats its
  // flat-tile noise guard — measured as a net loss on the matrix. Dark
  // frames are instead handled inside detection and at the camera.)
  const darkFrame = frameLuma(frame) < DARK_FRAME_LUMA
  const asIs = refineCardCrop(frame)
  // A card lying SIDEWAYS on a desk is a normal way to photograph one, and
  // every band and collector region below is written in upright card
  // coordinates — so turn the FRAME upright first, before any of that
  // geometry applies. Which quarter turn is up can't be known from shape
  // alone; the collector line arbitrates when it reads, and when it doesn't
  // both turns are simply read through, likeliest first.
  const orientations: Orientation[] = looksSideways(asIs, frame)
    ? await uprightOrientations(frame, asIs, gameHint)
    : [{ refined: asIs, turned: false }]
  /** One orientation, with the per-orientation state the passes below share. */
  interface Reading extends Orientation {
    canvas: HTMLCanvasElement
    /** The tiny collector-line crops need card-relative precision even when
     * the frame wasn't worth cropping — mapped through the detected region. */
    mapRect: (rect: OcrRect) => OcrRect
    /** Speculative collector-line read, queued once the first lookup goes out. */
    cornerText: Promise<string> | null
  }
  const readings: Reading[] = orientations.map((orientation) => {
    const { refined } = orientation
    traceEvent('crop', {
      applied: refined.applied,
      angle: refined.angle,
      ...(orientation.turned ? { turned: true } : {}),
      ...(orientation.sweepOnly ? { sweepOnly: true } : {}),
      ...(refined.region ? { x: refined.region.x, y: refined.region.y, w: refined.region.w, h: refined.region.h } : {}),
      ...(refined.cardRegion ? { card: refined.cardRegion } : {}),
    })
    return { ...orientation, canvas: refined.canvas, mapRect: mapThrough(refined), cornerText: null }
  })
  const config = settings()
  // No hint: only sweep enabled games with a cheap by-name API. Catalog-backed
  // games (Riftbound & co.) are reachable by picking them in the scan game
  // filter — unless they're all the user keeps on, in which case their
  // catalogs are exactly what was opted into and become the sweep.
  const light = LIGHT_MATCH_GAMES.filter((game) => config.enabledGames.includes(game))
  const games = gameHint ? [gameHint] : light.length ? light : config.enabledGames
  const timeoutMs = games.length === 1 ? OCR_MATCH_TIMEOUT_HINTED_MS : OCR_MATCH_TIMEOUT_MS
  const tried = new Set<string>()
  let firstRead: string | undefined
  // Attempt-wide budget against DYING APIs: fast lookups are nearly free and
  // deep candidate exploration is the accuracy win, but lookups riding their
  // multi-second timeouts must not stretch one attempt into minutes — only
  // those count against the budget, plus a hard wall-clock deadline.
  let slowLookupsLeft = budget.slowLookups
  const lookupDeadline = Date.now() + budget.lookupMs
  const SLOW_LOOKUP_MS = 1_500
  // OCR escalation budget: two watchdog kills, or 18s of attempt, means this
  // frame's texture is pathological — more band passes won't read it, they
  // only stretch "Identifying…". Remaining OCR is skipped; the (small,
  // bounded) collector-line path still gets its chance.
  const timeoutsAtStart = ocrTimeouts()
  const attemptStarted = Date.now()
  const outOfOcrRoad = () => ocrTimeouts() - timeoutsAtStart >= 2 || Date.now() - attemptStarted > budget.ocrMs

  /** Candidates not yet consumed by a lookup; remember the first plausible read. */
  const freshOf = (names: string[]): string[] => {
    const fresh = names.filter((name) => !tried.has(name.toLowerCase()))
    firstRead ??= fresh[0]
    return fresh
  }

  /** Look the candidates up; a confident hit is refined to the exact edition. */
  const tryCandidates = async (fresh: string[], reading: Reading): Promise<IdentifyOutcome | null> => {
    if (!fresh.length) return null
    const { canvas, mapRect } = reading
    // Queue the collector-line OCR now: it runs on the secondary OCR worker
    // (or on the primary, idle while the name candidates are out on the
    // network), so the line is usually read "for free" by the time a match
    // wants it. With a game hint the crop is that game's exact region; in
    // auto mode the shared bottom strip covers every game but Yu-Gi-Oh,
    // whose mid-card code refineFromCorner re-reads.
    const cornerText = (reading.cornerText ??= readRegionText(
      canvas,
      mapRect(gameHint ? CORNER_REGION[gameHint] : CORNER_STRIP),
    ).catch(() => ''))
    for (const name of fresh.slice(0, OCR_NAMES_PER_BAND)) {
      if (slowLookupsLeft <= 0 || Date.now() > lookupDeadline) break
      // Consumed here, not at freshOf: candidates past this pass's window
      // stay eligible for the next pass instead of being silently dropped.
      tried.add(name.toLowerCase())
      const lookupStarted = Date.now()
      let best = await bestMatchAcrossGames(name, games, {
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
      const bar = reading.turned ? Math.max(matchThresholdFor(name), TURNED_MATCH_THRESHOLD) : matchThresholdFor(name)
      if (!best || best.score < bar) continue
      // Turned frames additionally lose the epithet forgiveness baked into
      // the score — see TURNED_MATCH_THRESHOLD. Strictly narrowing: the full
      // name's similarity is never above the score this already cleared.
      if (reading.turned && similarity(name, best.card.name) < TURNED_MATCH_THRESHOLD) {
        traceEvent('turned-reject', { read: name, card: best.card.name, score: Number(best.score.toFixed(3)) })
        continue
      }
      // In the auto sweep the name was matched across GAMES, and the winner is
      // simply whichever API scored best — so a game that failed to answer
      // (pokemontcg.io 500s routinely) cedes its card to whatever else fuzzy-
      // matched the read. The printed collector line is the one piece of game
      // evidence going spare here, already read for the refine below: a card
      // showing a set-size fraction is not a Yu-Gi-Oh card, however well some
      // OCR fragment of it happened to match one.
      if (games.length > 1 && !collectorLineAllows(best.card.game, await cornerText)) {
        traceEvent('game-reject', { read: name, card: best.card.name, game: best.card.game, score: Number(best.score.toFixed(3)) })
        continue
      }
      // A bare champion lead cannot tell siblings apart, and `nameScore`
      // forgives the missing epithet by design — which parks EVERY lead-only
      // read at exactly 0.95, clearing every bar. Measured over the captured
      // Riftbound catalogue, 48 of its 98 champion leads carry more than one
      // epithet ("Ahri - Alluring" vs "Ahri - Inquisitive"; Vi carries four),
      // and the epithet shares the same hard-to-read plate as the name, so a
      // half-read plate is the COMMON case rather than the rare one. Measured: "Ambessa" off a
      // clipped plate answered "Ambessa - The Wolf" for a "Respected and
      // Feared" card — a confident wrong card, wrong price, auto-collected.
      // Refuse it here and the printed collector line, which CAN separate
      // them, gets its turn instead. (Same reasoning as
      // TURNED_MATCH_THRESHOLD, which exists for this exact loophole.)
      if (isCatalogGame(best.card.game) && isLeadOnlyMatch(name, best.card.name)) {
        const lead = nameLead(best.card.name)
        const variants = lead ? await catalogLeadVariants(best.card.game, lead).catch(() => 0) : 0
        if (variants > 1) {
          traceEvent('lead-ambiguous', { read: name, card: best.card.name, variants, score: Number(best.score.toFixed(3)) })
          continue
        }
      }
      // The read matched a bare species, but the card's own rules box names a
      // suffix variant — "Pokémon-GX rule" under a card answered as "Tauros".
      // A dropped two-letter suffix hits a real card EXACTLY, so this arrives
      // as a 1.0 score that no threshold can question; only other evidence
      // can. Prefer the variant the card declares when that card exists, and
      // when it does not, refuse rather than answer with the species: the
      // frame says the two disagree, and a confident wrong card is the
      // costlier way to be wrong (wrong price, auto-collected in collect
      // mode). Strictly narrowing — it only ever fires when the matched name
      // carries no suffix at all, so a name band that DID read one is left
      // alone.
      if (best.card.game === 'pokemon' && !pokemonNameSuffix(best.card.name)) {
        const declared = parsePokemonVariant(await cornerText)
        if (declared) {
          const wanted = `${best.card.name} ${declared}`
          const variant = await matchPokemon(wanted, undefined, undefined, config.pokemonKey).catch(() => null)
          const ok = variant && normalizeName(variant.name) === normalizeName(wanted)
          traceEvent('variant-declared', {
            read: name,
            card: best.card.name,
            declared,
            resolved: ok ? variant.name : null,
          })
          if (!ok) continue
          best = { ...best, card: variant }
        }
      }
      // Name pinned the card; now read the printed collector line to pin
      // the exact edition, and check the surface for a foil sheen.
      const refined = await refineFromCorner(
        best.card,
        canvas,
        cornerText,
        !!gameHint,
        mapRect,
        config.pokemonKey,
        !!gameHint,
      ).catch(() => null)
      let card = refined?.card ?? best.card
      const foil = detectFoil(canvas)
      traceEvent('refine', {
        setCode: refined?.read.setCode ?? null,
        number: refined?.read.number ?? null,
        total: refined?.read.total ?? null,
        edition: refined ? refined.card.setCode : null,
        ...(refined?.viaCollector ? { viaCollector: true, overrode: best.card.name } : {}),
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
          // On a collector-line override the name read is what got REJECTED
          // — reporting it would misdescribe the evidence that answered.
          name: refined?.viaCollector ? card.name : name,
          setCode: refined?.read.setCode,
          number: refined?.read.number,
          confidence: refined?.viaCollector ? CORNER_CONFIDENCE : best.score,
          via: 'ocr',
          foil: foil ? true : undefined,
        },
      }
    }
    return null
  }

  /**
   * Every name pass over one orientation. A non-ok return is the hard OCR
   * engine failure — nothing else here answers with a verdict.
   */
  const namePasses = async (reading: Reading): Promise<IdentifyOutcome | null> => {
    const { canvas } = reading
    // Bands are OCR'd one at a time, the game's most likely name position
    // first (Riftbound & co. print names mid-card, not at the top), so a hit
    // in the first band skips the rest of the work entirely.
    if (!reading.sweepOnly) {
      for (const band of nameBands(gameHint)) {
        bail()
        if (outOfOcrRoad()) break
        let names: string[]
        try {
          names = await readCardNames(canvas, band)
        } catch {
          if (tried.size || firstRead) break
          return { ok: false, reason: 'api', message: 'OCR engine failed to load — check connection' }
        }
        const hit = await tryCandidates(freshOf(names), reading)
        if (hit) return hit
      }

      // The contrast-stretched pass misreads stylized type over busy art (full
      // arts, foils). Before the heavier sweeps, re-read the game's primary band
      // binarized at higher resolution — in both polarities, since ornate glyph
      // faces routinely defeat the mean-luma polarity heuristic. A different
      // failure surface, so it regularly cracks what the first pass mangled.
      // On a genuinely dark frame that has produced NO plausible text at all,
      // one binarized retry is the last realistic chance — the flip and the
      // whole-card sweep never rescue pure noise, they just grind for seconds
      // while the user watches "Identifying…". Fail fast toward the actionable
      // fix (light) instead.
      // Then the three chroma projections, which throw the colour away
      // instead of averaging it in. A holographic sheen is saturated light,
      // and the luma every pass above uses averages it straight into the ink
      // — the contrast is gone before any stretch or threshold runs, which is
      // why an ordinary phone photo of a foil was the pipeline's worst case.
      // NOT gated on detectFoil: that detector is tuned conservatively for
      // PRICING ("false means unknown, not non-foil") and does not fire on a
      // sheen at all, and the win turned out to be much wider than foil
      // anyway, because card art is saturated in general.
      //
      // chroma-min/max split by the text's own polarity over a coloured
      // ground. chroma-sat answers the opposite layout — a metallic NAME on a
      // comparatively neutral bar, which is what a Yu-Gi-Oh Ultra or Secret
      // Rare actually prints. It is last because it is the narrowest: a card
      // whose name reads at any rung above never reaches it.
      const bandVariants =
        darkFrame && !firstRead
          ? (['binary'] as const)
          : (['binary', 'binary-flip', 'chroma-min', 'chroma-max', 'chroma-sat'] as const)
      for (const variant of bandVariants) {
        bail()
        if (outOfOcrRoad()) break
        try {
          const hit = await tryCandidates(freshOf(await readCardNames(canvas, nameBands(gameHint)[0], { variant })), reading)
          if (hit) return hit
        } catch (err) {
          if (isAbort(err)) throw err
          /* fall through to the full sweep */
        }
      }
    }

    // The bands assume a standard frame, but promos, full-art specials and
    // custom cards put names in unexpected places. Before giving up, sweep the
    // whole card once with automatic layout detection and mine every line.
    if (!(darkFrame && !firstRead) && !outOfOcrRoad()) {
      bail()
      try {
        const hit = await tryCandidates(freshOf(await readCardNamesAnywhere(canvas)), reading)
        if (hit) return hit
      } catch (err) {
        if (isAbort(err)) throw err
        /* the band sweep's verdict below stands */
      }
    }
    return null
  }

  // Name reading is out of road (ornate faces, foil sheen over the title —
  // or a non-Latin print the shipped English OCR simply cannot read). The
  // collector line still pins the card, because it stays Latin digits on
  // every print worldwide: a fraction + printed set size (Pokémon, catalog
  // games), an exact set code + collector number (MTG), or the 8-digit
  // passcode (Yu-Gi-Oh).
  const cornerIdentify = async (reading: Reading, gameHint: Game): Promise<IdentifyOutcome | null> => {
    const { canvas, mapRect, cornerText } = reading
    bail()
    try {
      // cornerText (when queued) already covered the exact hinted region;
      // if no candidate ever queued it, let the normal-region read run.
      // A frame that already burned the OCR budget (watchdog kills, or 18s
      // of grinding) gets a SHORT sole-evidence sweep, not the full one:
      // pathological texture won't suddenly resolve on the fifth
      // magnified pass either, and the user is watching "Identifying…".
      // The frame that burned its OCR budget gets the short sweep; a page
      // scan's cards get the short sweep from the start, because nine of them
      // share one user's patience and one phone's thermal headroom.
      const cornerPasses = Math.min(budget.cornerPasses, outOfOcrRoad() ? 2 : budget.cornerPasses)
      const read = await readCornerInfo(gameHint, canvas, cornerText, cornerText != null, mapRect, {
        thorough: true,
        passBudget: cornerPasses,
      })
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
        // Prefer a passcode any earlier pass already read. The dedicated
        // region is a 7%-tall strip and it MISSES on real photographs where
        // the wider bottom band, read moments earlier in the same attempt,
        // has the digits perfectly — measured on a secret rare whose strip
        // returned "" while the band beside it returned "72444406 1st
        // Edition". The evidence was in hand and thrown away because only one
        // rectangle was allowed to supply it. Same guard either way: eight
        // digits against a sparse id space.
        const passcode =
          read.passcode ??
          parsePasscode(
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
            confidence: CORNER_CONFIDENCE,
            via: 'ocr',
            foil: detectFoil(canvas) ? true : undefined,
          },
        }
      }
    } catch {
      /* the miss verdict below stands */
    }
    return null
  }

  // One orientation is the normal case and reads exactly as it always did.
  /**
   * Last resort: read the frame in the cloud (see gemini.ts). Opt-in, own key.
   *
   * The answer is NOT trusted on its own. A multimodal model returns confident
   * wrong answers exactly like the local matcher does — and worse, it hands
   * back no intermediate evidence (band text, collector line, rules box) for
   * the existing guards to bite on. So the guard is built from what the model
   * IS asked for: the name and the printed collector number, which must belong
   * to the same real card.
   *
   * - The name must clear `CLOUD_MATCH_THRESHOLD` (0.9), well above the 0.66
   *   a local read needs. A cloud read of a legible card is essentially exact;
   *   anything fuzzy here is the model guessing, and a guess that squeaks past
   *   a low bar is the wrong-card class arriving through a new door.
   * - When a number was read it PINS the printing, the same way
   *   `refineFromCorner` lets two printed numbers outrank one fuzzy name.
   *   `relatedNames` guards the swap so the pin can only pick a different
   *   printing of the same card, never a different card.
   *
   * Confidence 0.85: below a local exact name hit (1.0) because the evidence
   * is one model's reading of the whole card rather than a matched name plus a
   * corroborating printed line, and above the collector-only path (0.7).
   * Deliberately under the 0.75 cache-write gate? No — above it, because unlike
   * a corner-only ID this answer is stable for the same frame and re-deriving
   * it would mean paying for the same API call twice.
   */
  const cloudIdentify = async (reading: Reading): Promise<IdentifyOutcome | null> => {
    // Two routes to the same answer, tried in this order:
    //   1. HOSTED — a subscriber's scan, read by our own edge function with a
    //      key that never ships to the client. Entitlement and the monthly
    //      allowance are the SERVER's call; nothing is pre-checked here beyond
    //      being signed in at all, because a client-side entitlement check is a
    //      suggestion and only adds a way to be locally wrong about it.
    //   2. BYO KEY — the user's own Gemini key, explicitly switched on. Still
    //      supported and unmetered: someone paying Google directly costs us
    //      nothing, and it is the only route for a user who wants no account.
    // `cloudScanRescue` gates BOTH routes, and that is a privacy decision
    // rather than a UI one. Keying the hosted route on `isSignedIn()` alone —
    // as the first cut did — uploads a failed frame from every signed-in user,
    // including ones with no subscription, who then get a 403 and nothing
    // else. The image left the device to achieve exactly nothing. Sending a
    // camera frame anywhere has to be something the user switched on, and
    // paying for a tier is not the same act as consenting to the upload.
    if (!config.cloudScanRescue) return null
    const hosted = isSignedIn()
    const byo = !!config.geminiKey
    if (!hosted && !byo) return null
    bail()
    // Dynamic import, but be honest about what it buys: gemini.ts is ALREADY in
    // the main bundle (BuilderView and SettingsView import it statically), so
    // this saves no download — unlike drive.ts and cloud.ts, which really are
    // code-split. What it does buy is keeping authsession/cloudconfig out of
    // the scan path until a rescue actually runs.
    const { readCardHosted, readCardViaGemini } = await import('./gemini')
    // Deliberately NOT config.geminiModel on the BYO path — that one belongs to
    // the deck builder. Empty override falls through to the pinned
    // CLOUD_SCAN_MODEL; the hosted path pins its model server-side, because a
    // client-chosen model is a client-chosen bill.
    const read =
      (hosted ? await readCardHosted(reading.canvas, signal).catch(() => null) : null) ??
      (byo
        ? await readCardViaGemini(reading.canvas, config.geminiKey, config.cloudScanModel || undefined, signal).catch(
            () => null,
          )
        : null)
    if (!read) {
      traceEvent('cloud-read', { name: null })
      return null
    }
    traceEvent('cloud-read', {
      name: read.name,
      number: read.number ?? null,
      total: read.printedTotal ?? null,
      setCode: read.setCode ?? null,
    })
    const best = await bestMatchAcrossGames(read.name, games, {
      pokemonKey: config.pokemonKey,
      timeoutMs,
    }).catch(() => null)
    if (!best || best.score < CLOUD_MATCH_THRESHOLD) {
      traceEvent('cloud-reject', {
        read: read.name,
        card: best?.card.name ?? null,
        score: best ? Number(best.score.toFixed(3)) : null,
      })
      return null
    }
    // Pin the printing with the model's OWN collector line before judging the
    // name. This ordering is load-bearing, not tidiness: measured, the name
    // lookup alone answered "Pikachu ex" for a card the model had transcribed
    // perfectly as "Pikachu" 002/015, because `bestMatchAcrossGames` ranks by
    // `nameScore`, which forgives a missing suffix by design and parks a bare
    // species at ~0.95 (guard invariant 8). The number is what separates them.
    let card = best.card
    if (read.number) {
      const pinned = await matchGame(card.game, read.name, read.setCode, read.number, {
        pokemonKey: config.pokemonKey,
      }).catch(() => null)
      if (pinned && relatedNames(pinned.name, card.name)) card = pinned
    }
    // Now judge the WHOLE printed name, with `similarity` rather than
    // `nameScore` — the same narrowing TURNED_MATCH_THRESHOLD applies, for the
    // same reason. A cloud read is not a degraded guess to be forgiven; it is a
    // claimed exact transcription, so there is nothing to forgive and the
    // forgiveness is precisely what manufactures the wrong card. Measured on
    // the pikachu clip: `nameScore` let "Pikachu" become "Pikachu ex" five
    // times; `similarity` scores that pairing 0.78 and refuses it.
    if (similarity(read.name, card.name) < CLOUD_MATCH_THRESHOLD) {
      traceEvent('cloud-reject', {
        read: read.name,
        card: card.name,
        score: Number(similarity(read.name, card.name).toFixed(3)),
        why: 'name',
      })
      return null
    }
    traceEvent('cloud-accept', {
      card: card.name,
      game: card.game,
      score: Number(best.score.toFixed(3)),
      edition: card.setCode ?? null,
    })
    return {
      ok: true,
      card,
      identification: {
        game: card.game,
        name: read.name,
        setCode: read.setCode ?? card.setCode,
        number: read.number ?? card.number,
        confidence: CLOUD_CONFIDENCE,
        via: 'cloud',
        foil: detectFoil(reading.canvas) ? true : undefined,
      },
    }
  }

  // When the frame looked sideways and the collector line couldn't settle
  // which way up it is, the alternatives are read in turn — names across all
  // of them first, because a band read on the right way up beats a magnified
  // corner sweep on the wrong one, and the corner path is the expensive one.
  for (const reading of readings) {
    const hit = await namePasses(reading)
    if (hit) return hit
  }
  if (gameHint) {
    for (const reading of readings) {
      // The as-captured fallback is only in the list because the whole-card
      // sweep reads turned type; its collector regions are a quarter turn off
      // and would only spend magnified passes on the card's side edge.
      if (reading.sweepOnly) continue
      const hit = await cornerIdentify(reading, gameHint)
      if (hit) return hit
    }
  }

  // Every local pass has failed. If — and only if — the user supplied their own
  // Gemini key AND opted in, read the frame in the cloud as a last resort.
  //
  // This is the one place a camera frame may leave the device, and it is
  // deliberately the place where the alternative is telling the user "no". The
  // frames that succeed locally never reach here, so opting in does not put
  // ordinary scanning on the network.
  const cloud = await cloudIdentify(readings[0])
  if (cloud) return cloud

  // Auto mode never sweeps the catalog-backed games — each would pull a whole
  // TCGplayer catalog per lookup — so a Riftbound (or One Piece, SWU, Digimon,
  // Gundam) card cannot match here however good the photo is. That is a
  // property of the filter, not of the frame, and the old copy blamed the
  // light for it. Say which games need picking, and only while they are
  // actually enabled and actually excluded.
  const needsPicking = !gameHint
    ? config.enabledGames.filter((game) => isCatalogGame(game) && !games.includes(game))
    : []
  // Kept short: this lands in the no-match chip, not a dialog. Naming the
  // first few is what makes it recognisable ("that's my game") — the count
  // carries the rest.
  const named = needsPicking.slice(0, 2).map((game) => GAME_LABEL[game])
  const rest = needsPicking.length - named.length
  const pickHint = named.length
    ? ` ${named.join(', ')}${rest ? ` and ${rest} more` : ''} only scan when you pick the game above.`
    : ''
  return {
    ok: false,
    reason: 'ocr-miss',
    message: firstRead
      ? `Read “${firstRead}” but couldn’t match it.${pickHint}`
      : darkFrame
        ? 'Too dark to read — add light or turn on the flash'
        : gameHint
          ? 'Couldn’t read the card — more light helps'
          : `Couldn’t read the card name — more light helps.${pickHint || ' For non-English cards, pick the game so the collector line can identify them'}`,
    readName: firstRead,
  }
}

/** Mean luma of a capture, sampled small. */
function frameLuma(canvas: HTMLCanvasElement): number {
  try {
    const probe = document.createElement('canvas')
    probe.width = 32
    probe.height = 32
    const ctx = probe.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(canvas, 0, 0, 32, 32)
    const data = ctx.getImageData(0, 0, 32, 32).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum += (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
    return sum / (data.length / 4)
  } catch {
    return 255
  }
}

/** Under this mean luma the frame counts as dark for the fail-fast path. */
const DARK_FRAME_LUMA = 55

/**
 * Bands of the RAW frame — not of the detected card region — that the printed
 * line falls into when the crop detector's floor lands above it. Left first:
 * every modern card prints there. The right band is where vintage Pokémon and
 * MTG put it, and without it a Base Set Charizard's "4/102" is unreadable at
 * every tier, however much magnification is thrown at the wrong rectangle.
 */
const RAW_BOTTOM_BANDS: OcrRect[] = [
  { x: 0, y: 0.9, w: 0.55, h: 0.1 },
  { x: 0.45, y: 0.9, w: 0.55, h: 0.1 },
]
/**
 * The raw bands get their OWN budget rather than whatever the mapped-region
 * loops leave behind — which is nothing. Measured on `charizard-base`: two
 * variants over four regions is eight passes against a budget of four or five,
 * so these bands, the only ones that can read a line the card region excludes,
 * had never once run. A last-resort pass reached only when it wasn't needed is
 * not a last resort. They still cost nothing when a region already read the
 * line, because every pass short-circuits on a finished read.
 */
const RAW_BAND_PASSES = 3

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
  opts: {
    thorough?: boolean
    passBudget?: number
    /**
     * Refine-path escalation: how many EXTRA magnified passes the read may
     * spend if the cheap tier found nothing. Zero (the default) is the old
     * behaviour — see the call in `refineFromCorner` for why it isn't always.
     */
    deepPasses?: number
  } = {},
): Promise<CornerRead> {
  const { thorough = false, passBudget, deepPasses = 0 } = opts
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
    return { ...main, setCode: a.setCode ?? b.setCode, passcode: a.passcode ?? b.passcode }
  }
  // Sole-evidence reads get extra magnification (the set-code badge on a
  // Japanese card is a few pixels of type that 3× upscale smears) and sparse
  // segmentation, which mines the small detached line the default
  // single-block mode drops in favour of the rules box above it.
  let zoom: { upscale?: number; maxWidth?: number; sparse?: boolean } = thorough
    ? { upscale: 5, maxWidth: 1600, sparse: true }
    : {}
  let read = parseCornerInfo(game, cornerText ? await cornerText : '')
  // Escalation is bounded: these passes run only after every name read has
  // already failed, and each is a full-magnification OCR — an unbounded
  // sweep would turn every unreadable card into seconds of phone CPU.
  let budget = passBudget ?? (thorough ? SOLE_EVIDENCE_PASS_BUDGET : 3)
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
    budget = RAW_BAND_PASSES
    await pass(RAW_BOTTOM_BANDS[0], { variant: 'normal' })
    await pass(RAW_BOTTOM_BANDS[0], { variant: 'normal', sparse: false })
    await pass(RAW_BOTTOM_BANDS[1], { variant: 'normal', sparse: false })
  }
  // The refine path's deep tier. Everything above it is one wide strip plus
  // two binarized slivers at 3× — and on a hand-held photo the collector line
  // is about 2% of the card's height, routinely below what that resolves. The
  // sole-evidence tier reads exactly this type, so borrow the half of it that
  // is cheap: its badge-tight REGIONS at 5× magnification, in both polarities.
  // Not its sparse segmentation — layout analysis over a magnified crop is the
  // slow half, and this runs while the user is still watching "Identifying…".
  if (deepPasses > 0 && !done(read)) {
    zoom = { upscale: 5, maxWidth: 1600 }
    budget = deepPasses
    // Both region lists: the sole-evidence windows are aimed bottom-LEFT
    // where every modern card prints, and the retry list carries the vintage
    // bottom-RIGHT one — which is where Base Set puts "4/102", and Base Set
    // Charizard mis-editioned is the single most expensive way to be wrong in
    // this game. They were already tried binarized at 3×; 5× and Tesseract's
    // own local binarization are new evidence, not a repeat.
    const deepRegions = [...(SOLE_EVIDENCE_REGIONS[game] ?? []), ...(CORNER_RETRY_REGIONS[game] ?? [])]
    for (const variant of ['normal', 'binary'] as const) {
      for (const rect of deepRegions) await pass(mapRect(rect), { variant })
    }
    // Every region above is mapped through the DETECTED card region, and when
    // that region's floor lands inside the card — a full-bleed capture whose
    // bottom line hugs the edge — all of them sit a few percent too high, on
    // the flavour text instead of the number. Measured on `charizard-base`:
    // the crop ended at 0.93 of the frame and "4/102" prints at 0.96.
    budget = RAW_BAND_PASSES
    for (const rect of RAW_BOTTOM_BANDS) await pass(rect, { variant: 'normal' })
  }
  return read
}

/**
 * Games where the collector line does not merely REFINE the printing — it is
 * the only thing that decides it. A Pokémon species name answers to twenty
 * years of reprints, so a name match alone lands on whichever edition the
 * catalog listed first: measured on the matrix, 16 of 43 identified Pokémon
 * cells, including a Base Set Charizard reported as a $3 Celebrations promo.
 * These get the deep corner tier when the cheap passes miss the line.
 */
const PRINTING_RIDES_ON_THE_LINE = new Set<Game>(['pokemon'])
/** Extra magnified corner passes those games may spend inside a refine. */
const REFINE_DEEP_PASSES = 4

async function refineFromCorner(
  card: Card,
  canvas: HTMLCanvasElement,
  cornerText: Promise<string> | null,
  cornerIsExact: boolean,
  mapRect: (rect: OcrRect) => OcrRect,
  pokemonKey?: string,
  /** A game was picked, so a retry here taxes no other game's wait. */
  hinted = false,
): Promise<{ card: Card; read: CornerRead; viaCollector?: boolean } | null> {
  // This read is what tells "Tauros" from "Tauros ex" — it earns the work.
  const read = await readCornerInfo(card.game, canvas, cornerText, cornerIsExact, mapRect, {
    // Escalate only where the edition genuinely hangs on this read, and only
    // with a hint: in the auto fan-out this retry would spend the shared
    // budget every other game is waiting on (the cost asymmetry that
    // `ApiKeys.thorough` exists for), for a line auto mode cannot act on.
    deepPasses: hinted && PRINTING_RIDES_ON_THE_LINE.has(card.game) ? REFINE_DEEP_PASSES : 0,
  })
  if (!read.setCode && !read.number) return null
  // The printed fraction is independent of whatever the name band read, and
  // it is the SAME evidence the corner-only path identifies on. When it
  // resolves a card of its own and that card is unrelated to the name match,
  // the two disagree about what is physically in frame — and the line is the
  // stronger claim: two printed numbers agreeing with a catalog row, against
  // one fuzzy name read. Measured: an artist credit ("Kudos Productions")
  // matched "Production Surge" at 0.688 on a card whose line read 120/166,
  // which is exactly the correct card. Guarded like every other sole-evidence
  // use — a printed slash actually read (`!fused`), both halves agreeing with
  // a catalog row — so a mangled line resolves to nothing rather than to a
  // neighbour.
  if (isCatalogGame(card.game) && read.number && read.total && !read.fused) {
    const byLine = await catalogByCollector(card.game, read.number, read.total).catch(() => null)
    if (byLine && !relatedNames(byLine.name, card.name)) return { card: byLine, read, viaCollector: true }
  }
  let exact: Card | null = null
  if (card.game === 'yugioh') {
    exact = ygoPrintingVariants(card).find((variant) => sameYgoCode(variant.number, read.number)) ?? null
  } else if (card.game === 'pokemon') {
    // Verified inside `matchPokemon`, against the printed SET SIZE rather than
    // here against the number — measured, that distinction is the whole
    // lesson. A `collectorEq` veto at this layer looks like the check MTG and
    // Yu-Gi-Oh do, but the two halves of a Pokémon fraction fail
    // independently: `rayquaza-vmax` reads "70/203", a mangled number beside a
    // clean total, and the total alone correctly pins Evolving Skies. Vetoing
    // on the number threw that away and fell back to a Celebrations promo — a
    // guard that turns a right answer into a wrong one. The size check
    // belongs where the set is known, and that is the match layer.
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
