import { blobToBase64, type FrameCapture } from './camera'
import { bestMatchAcrossGames, matchGame } from './cardsearch'
import { isAbort } from './fetchJson'
import { GeminiError, identifyCardPhoto, type Identification } from './gemini'
import { LIGHT_MATCH_GAMES } from './games'
import { OCR_BANDS, readCardNames } from './ocr'
import { mtgMatchTraits } from './scryfall'
import { settings } from './settings'
import type { Card, Game } from './types'
import { hammingDistance } from './vision'
import { similarity } from './util'

/* Frame-hash cache: skip re-identifying the same card sitting on the table. */

interface CacheEntry {
  hash: string
  card: Card | null
  /** Foil sheen read off the physical copy — kept so cached hits price right. */
  foil?: boolean
  at: number
}

const cache: CacheEntry[] = []
const CACHE_LIMIT = 60
const MISS_TTL_MS = 15_000
const HASH_TOLERANCE = 10

function cacheLookup(hash: string): CacheEntry | null {
  const now = Date.now()
  for (const entry of cache) {
    if (hammingDistance(entry.hash, hash) <= HASH_TOLERANCE) {
      return entry.card === null && now - entry.at > MISS_TTL_MS ? null : entry
    }
  }
  return null
}

function cacheStore(hash: string, card: Card | null, foil?: boolean): void {
  cache.unshift({ hash, card, foil, at: Date.now() })
  if (cache.length > CACHE_LIMIT) cache.length = CACHE_LIMIT
}

export function clearScanCache(): void {
  cache.length = 0
  resetGeminiRejection()
}

/** Forget that Gemini rejected the key (key edited/re-tested, cache reset). */
export function resetGeminiRejection(): void {
  rejectedKey = null
}

export class ScannerConfigError extends Error {}

export type IdentifyOutcome =
  | { ok: true; card: Card; identification: IdentificationMeta }
  | {
      ok: false
      reason: 'no-card' | 'not-found' | 'ocr-miss' | 'cached-miss' | 'api'
      message: string
      status?: number
      readName?: string
      readGame?: Game
      /** True when the Gemini call itself failed (as opposed to the card-data lookup). */
      geminiFailed?: boolean
    }

export interface IdentificationMeta {
  game: Game
  name: string
  setCode?: string | null
  number?: string | null
  confidence: number
  via: 'gemini' | 'ocr' | 'cache'
  /** The physical copy showed a foil/holo sheen (Gemini vision only). */
  foil?: boolean
  /** MTG frame treatment seen on the copy (borderless, extended, …). */
  treatment?: string
}

export async function identifyFrame(
  capture: FrameCapture,
  hash: string,
  opts: { ignoreMisses?: boolean; signal?: AbortSignal } = {},
): Promise<IdentifyOutcome> {
  const config = settings()
  const gameHint = config.gameFilter === 'auto' ? undefined : config.gameFilter
  const cached = cacheLookup(hash)
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

  let outcome: IdentifyOutcome
  const skipGemini = rejectedKey === config.geminiKey && config.ocrFallback
  if (config.geminiKey && !skipGemini) {
    outcome = await identifyViaGemini(capture, gameHint, config.geminiKey, config.geminiModel, opts.signal)
    if (!outcome.ok && outcome.geminiFailed) {
      if (isKeyProblem(outcome.status)) rejectedKey = config.geminiKey
      // Gemini is down, over quota, or the key is bad — don't waste the frame:
      // run the on-device engine in the same attempt when it's enabled.
      if (config.ocrFallback) {
        const fallback = await identifyViaOcr(capture.canvas, gameHint)
        if (fallback.ok) outcome = fallback
      }
    }
  } else if (config.ocrFallback) {
    outcome = await identifyViaOcr(capture.canvas, gameHint)
  } else {
    throw new ScannerConfigError('Add a Gemini API key or enable OCR fallback in Settings')
  }

  if (outcome.ok) cacheStore(hash, outcome.card, outcome.identification.foil)
  else if (outcome.reason === 'no-card' || outcome.reason === 'not-found') cacheStore(hash, null)
  return outcome
}

/* Once Gemini rejects a key (bad/unauthorized), skip the doomed upload on
 * every following frame and go straight to OCR (when it's enabled). Editing
 * the key, re-testing it in Settings, or resetting the scan cache re-arms it. */
let rejectedKey: string | null = null

function isKeyProblem(status?: number): boolean {
  return status === 400 || status === 401 || status === 403
}

/** True when scans are currently running on-device because Gemini rejected the key. */
export function usingOcrBecauseKeyRejected(): boolean {
  const config = settings()
  return !!config.geminiKey && rejectedKey === config.geminiKey && config.ocrFallback
}

async function identifyViaGemini(
  capture: FrameCapture,
  gameHint: Game | undefined,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<IdentifyOutcome> {
  const blob = await capture.blob
  if (!blob) return { ok: false, reason: 'no-card', message: 'Could not capture a frame' }
  const base64 = await blobToBase64(blob)
  let identified
  try {
    identified = await identifyCardPhoto(base64, apiKey, model, gameHint, signal)
  } catch (err: any) {
    if (isAbort(err)) throw err
    const message = err instanceof GeminiError ? err.message : 'Network error reaching Gemini'
    return {
      ok: false,
      reason: 'api',
      status: err instanceof GeminiError ? err.status : undefined,
      message: `Gemini: ${message.slice(0, 140)}`,
      geminiFailed: true,
    }
  }
  if (!identified || identified.game === 'other' || !(typeof identified.confidence === 'number' && identified.confidence >= 0.35)) {
    return { ok: false, reason: 'no-card', message: 'Couldn’t read a card — fill the frame, avoid glare' }
  }
  const game = gameHint ?? (identified.game as Game)
  const config = settings()
  let card: Card | null = null
  try {
    card = await matchGame(game, identified.name, identified.set_code, identified.collector_number, {
      pokemonKey: config.pokemonKey,
    })
  } catch (err) {
    if (isAbort(err)) throw err
    return {
      ok: false,
      reason: 'api',
      message: `Couldn’t reach the card data for “${identified.name}”`,
      readName: identified.name,
      readGame: game,
    }
  }
  if (!card || similarity(identified.name, card.name) < 0.5) {
    return {
      ok: false,
      reason: 'not-found',
      message: `Read “${identified.name}” but couldn’t match it`,
      readName: identified.name,
      readGame: game,
    }
  }
  if (game === 'mtg') card = await refineMtgMatch(card, identified, signal)
  return {
    ok: true,
    card,
    identification: {
      game,
      name: identified.name,
      setCode: identified.set_code,
      number: identified.collector_number,
      confidence: identified.confidence,
      via: 'gemini',
      foil: identified.foil ?? undefined,
      treatment: identified.treatment ?? undefined,
    },
  }
}

function collectorEq(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  const norm = (value: string) => value.toLowerCase().replace(/^0+(?=\d)/, '')
  return norm(a) === norm(b)
}

/**
 * A legible collector number pins the exact version. Without one, a fuzzy
 * match lands on the base printing — so when the camera saw a special frame
 * (borderless/full art, extended, showcase, retro) or a foil sheen the match
 * can't carry, re-pick the printing that actually has those traits.
 */
async function refineMtgMatch(card: Card, identified: Identification, signal?: AbortSignal): Promise<Card> {
  if (collectorEq(identified.collector_number, card.number)) return card
  const wantsTreatment = identified.treatment != null && identified.treatment !== 'regular'
  const foilConflict = identified.foil === true && !!card.finishes?.length && !card.finishes.some((f) => f !== 'nonfoil')
  if (!wantsTreatment && !foilConflict) return card
  const better = await mtgMatchTraits(
    card.name,
    identified.set_code,
    { treatment: identified.treatment, foil: identified.foil },
    signal,
  ).catch(() => null)
  return better ?? card
}

const OCR_MATCH_THRESHOLD = 0.62
/** Per-game budget for a name lookup: one slow card API mustn't stall the frame. */
const OCR_MATCH_TIMEOUT_MS = 6_000
/** Names tried per band — the card name is almost always the first clean line. */
const OCR_NAMES_PER_BAND = 3

async function identifyViaOcr(canvas: HTMLCanvasElement, gameHint: Game | undefined): Promise<IdentifyOutcome> {
  // No hint: only sweep games with a cheap by-name API. Catalog-backed games
  // (Riftbound & co.) are reachable by picking them in the scan game filter.
  const games = gameHint ? [gameHint] : LIGHT_MATCH_GAMES
  const config = settings()
  const tried = new Set<string>()
  let firstRead: string | undefined
  // Bands are OCR'd one at a time so a hit in the cheap top band skips the
  // rest of the work entirely.
  for (const share of OCR_BANDS) {
    let names: string[]
    try {
      names = await readCardNames(canvas, share)
    } catch {
      if (tried.size || firstRead) break
      return { ok: false, reason: 'api', message: 'OCR engine failed to load — check connection' }
    }
    const fresh = names.filter((name) => !tried.has(name.toLowerCase()))
    for (const name of fresh) tried.add(name.toLowerCase())
    firstRead ??= fresh[0]
    for (const name of fresh.slice(0, OCR_NAMES_PER_BAND)) {
      const best = await bestMatchAcrossGames(name, games, {
        pokemonKey: config.pokemonKey,
        timeoutMs: OCR_MATCH_TIMEOUT_MS,
      }).catch(() => null)
      if (best && best.score >= OCR_MATCH_THRESHOLD) {
        return {
          ok: true,
          card: best.card,
          identification: { game: best.card.game, name, confidence: best.score, via: 'ocr' },
        }
      }
    }
  }
  return {
    ok: false,
    reason: 'ocr-miss',
    message: firstRead ? `Read “${firstRead}” but couldn’t match it` : 'Couldn’t read the card name — more light helps',
    readName: firstRead,
  }
}
