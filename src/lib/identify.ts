import { type FrameCapture } from './camera'
import { bestMatchAcrossGames, matchGame } from './cardsearch'
import { CORNER_REGION, parseCornerInfo, sameYgoCode, type CornerRead } from './corner'
import { LIGHT_MATCH_GAMES } from './games'
import { nameBands, readCardNames, readCardNamesAnywhere, readRegionText, readSealedLines, type OcrRect } from './ocr'
import { matchPokemon } from './pokemon'
import { mtgMatchTraits, mtgPrintings } from './scryfall'
import { identifySealedText } from './sealed'
import { settings } from './settings'
import type { Card, Game } from './types'
import { detectFoil, hammingDistance } from './vision'
import { similarity } from './util'
import { ygoPrintingVariants } from './ygo'

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
  card: Card | null
  /** Foil sheen read off the physical copy — kept so cached hits price right. */
  foil?: boolean
  at: number
}

const cache: CacheEntry[] = []
const CACHE_LIMIT = 60
const MISS_TTL_MS = 15_000
const HASH_TOLERANCE = 10

function cacheLookup(hash: string, mode: ScanMode): CacheEntry | null {
  const now = Date.now()
  for (const entry of cache) {
    if (entry.mode === mode && hammingDistance(entry.hash, hash) <= HASH_TOLERANCE) {
      return entry.card === null && now - entry.at > MISS_TTL_MS ? null : entry
    }
  }
  return null
}

function cacheStore(hash: string, mode: ScanMode, card: Card | null, foil?: boolean): void {
  cache.unshift({ hash, mode, card, foil, at: Date.now() })
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
  opts: { ignoreMisses?: boolean; mode?: ScanMode } = {},
): Promise<IdentifyOutcome> {
  const mode = opts.mode ?? 'card'
  const config = settings()
  const gameHint = config.gameFilter === 'auto' ? undefined : config.gameFilter
  const cached = cacheLookup(hash, mode)
  const cacheUsable = cached && (!cached.card || !gameHint || cached.card.game === gameHint)
  if (cacheUsable && cached.card) {
    return {
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
    }
  }
  if (cacheUsable && !opts.ignoreMisses) {
    return { ok: false, reason: 'cached-miss', message: 'Same frame as a recent miss' }
  }

  const outcome =
    mode === 'sealed' ? await identifySealedFrame(capture.canvas, gameHint) : await identifyViaOcr(capture.canvas, gameHint)
  if (outcome.ok) cacheStore(hash, mode, outcome.card, outcome.identification.foil)
  // Cache unreadable frames too: the same card sitting unchanged shouldn't
  // re-burn OCR + lookups every retry. A manual shutter tap bypasses this.
  else if (outcome.reason === 'ocr-miss') cacheStore(hash, mode, null)
  return outcome
}

/** Pack/box front → set name → the set's sealed product. All on-device OCR. */
async function identifySealedFrame(canvas: HTMLCanvasElement, gameHint: Game | undefined): Promise<IdentifyOutcome> {
  let lines: string[]
  try {
    lines = await readSealedLines(canvas)
  } catch {
    return { ok: false, reason: 'api', message: 'OCR engine failed to load — check connection' }
  }
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

const OCR_MATCH_THRESHOLD = 0.62
/** Per-game budget for a name lookup: one slow card API mustn't stall the frame. */
const OCR_MATCH_TIMEOUT_MS = 6_000
/** A single hinted game has no four-way fan-out — its API gets longer (the keyless Pokémon API needs it). */
const OCR_MATCH_TIMEOUT_HINTED_MS = 9_000
/** Candidates tried per band — the name is usually the first line or the first joined pair. */
const OCR_NAMES_PER_BAND = 4
/** Auto-mode collector-line crop: the bottom strip every game but YGO prints it in. */
const CORNER_STRIP: OcrRect = { x: 0, y: 0.85, w: 1, h: 0.15 }

async function identifyViaOcr(canvas: HTMLCanvasElement, gameHint: Game | undefined): Promise<IdentifyOutcome> {
  // No hint: only sweep games with a cheap by-name API. Catalog-backed games
  // (Riftbound & co.) are reachable by picking them in the scan game filter.
  const games = gameHint ? [gameHint] : LIGHT_MATCH_GAMES
  const config = settings()
  const timeoutMs = games.length === 1 ? OCR_MATCH_TIMEOUT_HINTED_MS : OCR_MATCH_TIMEOUT_MS
  const tried = new Set<string>()
  let firstRead: string | undefined
  let cornerText: Promise<string> | null = null

  /** Dedupe candidates against earlier passes; remember the first plausible read. */
  const freshOf = (names: string[]): string[] => {
    const fresh = names.filter((name) => !tried.has(name.toLowerCase()))
    for (const name of fresh) tried.add(name.toLowerCase())
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
    cornerText ??= readRegionText(canvas, gameHint ? CORNER_REGION[gameHint] : CORNER_STRIP).catch(() => '')
    for (const name of fresh.slice(0, OCR_NAMES_PER_BAND)) {
      const best = await bestMatchAcrossGames(name, games, {
        pokemonKey: config.pokemonKey,
        timeoutMs,
      }).catch(() => null)
      if (!best || best.score < OCR_MATCH_THRESHOLD) continue
      // Name pinned the card; now read the printed collector line to pin
      // the exact edition, and check the surface for a foil sheen.
      const refined = await refineFromCorner(best.card, canvas, cornerText, !!gameHint, config.pokemonKey).catch(() => null)
      let card = refined?.card ?? best.card
      const foil = detectFoil(canvas)
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

  // The bands assume a standard frame, but promos, full-art specials and
  // custom cards put names in unexpected places. Before giving up, sweep the
  // whole card once with automatic layout detection and mine every line.
  try {
    const hit = await tryCandidates(freshOf(await readCardNamesAnywhere(canvas)))
    if (hit) return hit
  } catch {
    /* the band sweep's verdict below stands */
  }

  return {
    ok: false,
    reason: 'ocr-miss',
    message: firstRead ? `Read “${firstRead}” but couldn’t match it` : 'Couldn’t read the card name — more light helps',
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
async function refineFromCorner(
  card: Card,
  canvas: HTMLCanvasElement,
  cornerText: Promise<string> | null,
  cornerIsExact: boolean,
  pokemonKey?: string,
): Promise<{ card: Card; read: CornerRead } | null> {
  let read = parseCornerInfo(card.game, cornerText ? await cornerText : '')
  if (!read.setCode && !read.number) {
    if (cornerIsExact) return null
    read = parseCornerInfo(card.game, await readRegionText(canvas, CORNER_REGION[card.game]))
    if (!read.setCode && !read.number) return null
  }
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
  if (!exact || similarity(exact.name, card.name) < 0.7) return null
  return { card: exact, read }
}
