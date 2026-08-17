import { linkAbort } from './fetchJson'
import { asTreatment, type Treatment } from './scryfall'
import type { Card, Game } from './types'

export class GeminiError extends Error {}

export interface CloudCardRead {
  name: string
  number?: string
  printedTotal?: string
  setCode?: string
  game?: string
  /**
   * What the FRAME looks like — borderless, showcase, extended, retro. This is
   * the one field here that is not a transcription, and it is the reason the
   * cloud read is worth asking about a card the device already named: on-device
   * OCR can read a collector line but has no way to answer "is this the
   * full-art printing?", while a vision model answers it from the picture. It
   * feeds `pickByTraits`, and it may only ever choose BETWEEN printings of a
   * card that was identified some other way.
   */
  treatment?: Treatment
  /** The model saw holographic shine. Corroborates the on-device detector. */
  foil?: boolean
}

/** Scanning is interactive — a rescue that outlives the user's patience is a miss. */
const CLOUD_SCAN_TIMEOUT_MS = 12_000

/** A model's string field, or nothing — "unknown"/"null" are the model saying no. */
function text(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim() : ''
  return s && s.toLowerCase() !== 'unknown' && s.toLowerCase() !== 'null' ? s : undefined
}

/**
 * Coerce a model's JSON to `CloudCardRead`. One coercion for both routes, so
 * the hosted and direct paths cannot drift into disagreeing about what an
 * unreadable field means — the answer is always "the field is absent".
 */
function cloudRead(parsed: any): CloudCardRead | null {
  const name = text(parsed?.name)
  if (!name) return null
  return {
    name,
    number: text(parsed?.number),
    printedTotal: text(parsed?.printedTotal),
    setCode: text(parsed?.setCode),
    game: text(parsed?.game),
    treatment: asTreatment(parsed?.treatment),
    foil: typeof parsed?.foil === 'boolean' ? parsed.foil : undefined,
  }
}

/**
 * The HOSTED rescue: our own edge function reads the card, using a key that
 * lives on the server and never ships to the client.
 *
 * This is the path for subscribers. Entitlement and the monthly allowance are
 * checked SERVER-side — the client deliberately does not pre-check them,
 * because a client-side entitlement check is a suggestion and would only add a
 * way to be wrong about it locally.
 *
 * Every failure returns null and is indistinguishable to the caller from a
 * local miss: not signed in, not subscribed, out of allowance, function down,
 * Google down. A scanner must never explain billing to someone holding a card.
 */
export async function readCardHosted(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<CloudCardRead | null> {
  const { isSignedIn, freshToken } = await import('./authsession')
  const { SUPABASE_URL, CLOUD_AVAILABLE } = await import('./cloudconfig')
  if (!CLOUD_AVAILABLE || !isSignedIn()) return null
  const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
  if (!data) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CLOUD_SCAN_TIMEOUT_MS)
  const unlink = linkAbort(signal, controller)
  try {
    const token = await freshToken()
    const res = await fetch(`${SUPABASE_URL}/functions/v1/scan-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: data }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    // Our own server, but the answer inside it is a language model's — coerce
    // it to the contract rather than casting, exactly as a pasted link would be.
    const parsed = await res.json()
    return parsed?.name ? cloudRead(parsed) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    unlink()
  }
}

export interface BuildDecksRequest {
  game: Game
  format?: string
  style?: string
  budget?: number | null
  collectionList?: string
  useCollection?: boolean
  /** Cards the decks MUST be designed around (the "build around this" flow). */
  seedCards?: Card[]
}

export interface ParsedDeckLine {
  qty: number
  name: string
}

export interface ParsedDeck {
  title: string
  lines: ParsedDeckLine[]
}

export interface BuildDecksResult {
  markdown: string
  decks: ParsedDeck[]
}


export async function buildDecksHosted(request: BuildDecksRequest): Promise<BuildDecksResult> {
  const { isSignedIn, freshToken } = await import('./authsession')
  const { SUPABASE_URL, CLOUD_AVAILABLE } = await import('./cloudconfig')
  if (!CLOUD_AVAILABLE) throw new GeminiError('The deck builder is not switched on for this build')
  if (!isSignedIn()) throw new GeminiError('Sign in to use the deck builder')

  const { game, format, style, budget, collectionList, useCollection, seedCards } = request
  const token = await freshToken()
  const res = await fetch(`${SUPABASE_URL}/functions/v1/build-deck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      game,
      format,
      style,
      budget,
      useCollection,
      collectionList: useCollection ? collectionList : '',
      seedCards: (seedCards ?? []).map((card) => ({ name: card.name, setName: card.setName })),
    }),
  }).catch(() => null)

  if (!res) throw new GeminiError('Could not reach the deck builder — check your connection')
  if (!res.ok) {
    const code = res.status
    if (code === 401) throw new GeminiError('Sign in to use the deck builder')
    if (code === 403) throw new GeminiError('The AI deck builder is part of a subscription')
    if (code === 429) throw new GeminiError('You have used this month\u2019s deck builds')
    if (code === 503) throw new GeminiError('The deck builder is not configured yet')
    throw new GeminiError('The deck builder could not answer just now')
  }
  const payload = (await res.json().catch(() => null)) as { markdown?: string } | null
  const markdown = typeof payload?.markdown === 'string' ? payload.markdown : ''
  if (!markdown) throw new GeminiError('The deck builder returned an empty response')
  return { markdown, decks: parseDecklists(markdown) }
}

export function parseDecklists(markdown: string): ParsedDeck[] {
  const decks: ParsedDeck[] = []
  const titles = [...markdown.matchAll(/^##\s*Deck:\s*(.+)$/gim)].map((m) => ({
    title: m[1].trim(),
    index: m.index ?? 0,
  }))
  for (const [i, block] of [...markdown.matchAll(/```decklist\s*\n([\s\S]*?)```/g)].entries()) {
    const at = block.index ?? 0
    let title = `Deck ${i + 1}`
    for (const candidate of titles) if (candidate.index < at) title = candidate.title
    const lines: ParsedDeckLine[] = []
    for (const rawLine of block[1].split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('--') || line.startsWith('#') || line.startsWith('//')) continue
      const match = line.match(/^(\d+)\s*[x×]?\s+(.+)$/)
      if (match) {
        const qty = parseInt(match[1], 10)
        const name = match[2].trim()
        if (qty > 0 && qty <= 99 && name.length > 1) lines.push({ qty, name })
      }
    }
    if (lines.length) decks.push({ title, lines })
  }
  return decks
}
