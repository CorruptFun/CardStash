import { blobToBase64, type FrameCapture } from './camera'
import { bestMatchAcrossGames, matchGame } from './cardsearch'
import { isAbort } from './fetchJson'
import { GeminiError, identifyCardPhoto } from './gemini'
import { LIGHT_MATCH_GAMES } from './games'
import { readCardNames } from './ocr'
import { settings } from './settings'
import type { Card, Game } from './types'
import { hammingDistance } from './vision'
import { similarity } from './util'

/* Frame-hash cache: skip re-identifying the same card sitting on the table. */

interface CacheEntry {
  hash: string
  card: Card | null
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

function cacheStore(hash: string, card: Card | null): void {
  cache.unshift({ hash, card, at: Date.now() })
  if (cache.length > CACHE_LIMIT) cache.length = CACHE_LIMIT
}

export function clearScanCache(): void {
  cache.length = 0
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
    }

export interface IdentificationMeta {
  game: Game
  name: string
  setCode?: string | null
  number?: string | null
  confidence: number
  via: 'gemini' | 'ocr' | 'cache'
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
      },
    }
  }
  if (cacheUsable && !opts.ignoreMisses) {
    return { ok: false, reason: 'cached-miss', message: 'Same frame as a recent miss' }
  }

  let outcome: IdentifyOutcome
  if (config.geminiKey) {
    outcome = await identifyViaGemini(capture, gameHint, config.geminiKey, config.geminiModel, opts.signal)
  } else if (config.ocrFallback) {
    outcome = await identifyViaOcr(capture.canvas, gameHint)
  } else {
    throw new ScannerConfigError('Add a Gemini API key or enable OCR fallback in Settings')
  }

  if (outcome.ok) cacheStore(hash, outcome.card)
  else if (outcome.reason === 'no-card' || outcome.reason === 'not-found') cacheStore(hash, null)
  return outcome
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
    },
  }
}

const OCR_MATCH_THRESHOLD = 0.62

async function identifyViaOcr(canvas: HTMLCanvasElement, gameHint: Game | undefined): Promise<IdentifyOutcome> {
  let names: string[]
  try {
    names = await readCardNames(canvas)
  } catch {
    return { ok: false, reason: 'api', message: 'OCR engine failed to load — check connection' }
  }
  // No hint: only sweep games with a cheap by-name API. Catalog-backed games
  // (Riftbound & co.) are reachable by picking them in the scan game filter.
  const games = gameHint ? [gameHint] : LIGHT_MATCH_GAMES
  const config = settings()
  for (const name of names) {
    const best = await bestMatchAcrossGames(name, games, { pokemonKey: config.pokemonKey }).catch(() => null)
    if (best && best.score >= OCR_MATCH_THRESHOLD) {
      return {
        ok: true,
        card: best.card,
        identification: { game: best.card.game, name, confidence: best.score, via: 'ocr' },
      }
    }
  }
  return {
    ok: false,
    reason: 'ocr-miss',
    message: names.length ? `Read “${names[0]}” but couldn’t match it` : 'Couldn’t read the card name — more light helps',
    readName: names[0],
  }
}
