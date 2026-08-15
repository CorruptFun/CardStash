import { linkAbort } from './fetchJson'
import { asTreatment, type Treatment } from './scryfall'
import type { Card, Game } from './types'

const API = 'https://generativelanguage.googleapis.com/v1beta/models'

export class GeminiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

async function callGemini(
  model: string,
  apiKey: string,
  body: unknown,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const unlink = linkAbort(signal, controller)
  try {
    const res = await fetch(`${API}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GeminiError(errorMessage(text) ?? `Gemini HTTP ${res.status}`, res.status)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
    unlink()
  }
}

function errorMessage(body: string): string | null {
  try {
    return JSON.parse(body).error?.message ?? null
  } catch {
    return null
  }
}

function responseText(res: any): string {
  return (res.candidates?.[0]?.content?.parts ?? [])
    .map((part: any) => part.text ?? '')
    .join('')
    .trim()
}

/**
 * Models to fall back to when the configured one 404s (renamed/retired).
 * Cheapest first: every use here (deck building, the scan rescue) is a small
 * bounded prompt, so the lite tier is the right default and the flash tier is
 * only insurance. Keep these CURRENT — the whole `gemini-2.5-*` family was
 * retired, and a deprecated id in this list is a silent 404 for every user
 * whose configured model also went away.
 */
const FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.7-flash']

async function callWithFallback(
  model: string,
  apiKey: string,
  body: unknown,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<any> {
  const models = [model, ...FALLBACK_MODELS.filter((m) => m !== model)]
  let lastError: unknown
  for (const candidate of models) {
    try {
      const res = await callGemini(candidate, apiKey, body, timeoutMs, signal)
      return res
    } catch (err) {
      lastError = err
      if (!(err instanceof GeminiError && err.status === 404)) throw err
    }
  }
  throw lastError
}

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

/**
 * Ask for the printed values, not for an opinion. The schema is the guard's
 * raw material: a name alone cannot be cross-checked, so the collector number
 * is requested every time and the prompt is explicit that unread fields must
 * be omitted rather than guessed — a hallucinated number that happens to hit a
 * catalog row would defeat the very check it exists to feed.
 */
const CARD_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    number: { type: 'STRING' },
    printedTotal: { type: 'STRING' },
    setCode: { type: 'STRING' },
    game: { type: 'STRING' },
    // Deliberately a plain STRING rather than a schema `enum`: the vocabulary
    // is enforced by `asTreatment` on the way in, where an unrecognised answer
    // costs nothing, instead of by a schema field whose rejection would take
    // the whole call — name and collector line included — down with it.
    treatment: { type: 'STRING' },
    foil: { type: 'BOOLEAN' },
  },
  required: ['name'],
}

const CARD_PROMPT =
  'You are reading a trading card photograph for a collection app. ' +
  'Return the card NAME exactly as printed, including any suffix that is part of the name ' +
  '(ex, GX, V, VMAX, VSTAR) and any possessive prefix ("Iono\'s", "Team Rocket\'s"). ' +
  'Also return the collector number and printed set total from the small collector line ' +
  '(for "055/086": number "055", printedTotal "086"), and the printed set code if visible. ' +
  'Magic cards print that line as two rows in a bottom corner — "0321 U" over "MSH★EN" — ' +
  'giving number "0321" and setCode "MSH", with no printed total to return. Its separator ' +
  'is sometimes a star (★) rather than a dot (•), and its number is sometimes higher than the set ' +
  'actually holds; both mark a special printing, so transcribe the digits exactly as they ' +
  'appear and do not normalise them. On full-art and borderless cards this line is printed ' +
  'over the artwork in small light or dark type close to the card edge — look for it there too. ' +
  'Then judge the FRAME and return treatment: "borderless" when the artwork runs to the card ' +
  'edges with no border at all, "extended" when a thin border remains but the art reaches the ' +
  'sides, "showcase" for an alternate stylised frame, "retro" for an old-style frame, ' +
  '"regular" for the ordinary modern frame; and foil: true only when the surface clearly ' +
  'shows holographic shine. Those two describe the printing rather than transcribe it, so ' +
  'answer them only when the card is clearly enough visible to judge. ' +
  'CRITICAL: omit any field you cannot actually read on the card. Never guess a number. ' +
  'An omitted field is correct; an invented one is not.'

/** Scanning is interactive — a rescue that outlives the user's patience is a miss. */
const CLOUD_SCAN_TIMEOUT_MS = 12_000

/**
 * The model the scan rescue uses, pinned SEPARATELY from the builder's.
 *
 * The two Gemini uses in this app want different things. The deck builder
 * reasons over a whole collection and the user may reasonably point it at
 * something large; the scan rescue transcribes one card and wants accuracy on
 * small printed type at the lowest sane cost. Sharing one setting would mean a
 * user tuning their deck builder silently changing what every scan costs.
 *
 * Measured on six real cards (Krookodile ex, a bare Pikachu, Leafeon VSTAR, a
 * possessive-prefix Crobat ex, a Trainer and a Deoxys), flash-lite and the
 * newest flash both scored 6/6 — identical answers, including the small
 * collector line — at $0.00038 and $0.00194 a call. Reading printed text off a
 * card is not a reasoning task, so the reasoning tier buys nothing here and
 * costs 5x. Re-measure with `modelcmp` before changing this on vibes.
 */
export const CLOUD_SCAN_MODEL = 'gemini-3.1-flash-lite'

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
 * This is the path for subscribers, and it is tried before the BYO-key one.
 * Entitlement and the monthly allowance are checked SERVER-side — the client
 * deliberately does not pre-check them, because a client-side entitlement check
 * is a suggestion and would only add a way to be wrong about it locally.
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

/**
 * Read one captured frame through Gemini. Returns null on anything unusable —
 * the caller treats that exactly like a local miss.
 */
export async function readCardViaGemini(
  canvas: HTMLCanvasElement,
  apiKey: string,
  model = CLOUD_SCAN_MODEL,
  signal?: AbortSignal,
): Promise<CloudCardRead | null> {
  if (!apiKey) return null
  // The capture is already capped at CAPTURE_MAX_EDGE (1600); at that size the
  // image bills ~1.1k tokens, so a rescue costs a fraction of a cent. Sending
  // it smaller would save nothing that matters and can cost the collector line,
  // which is the half of the answer the guard actually needs.
  const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
  if (!data) return null
  try {
    const res = await callWithFallback(
      model,
      apiKey,
      {
        contents: [{ parts: [{ text: CARD_PROMPT }, { inline_data: { mime_type: 'image/jpeg', data } }] }],
        generationConfig: {
          temperature: 0,
          // The answer is ~50 tokens, but a THINKING model spends its output
          // budget on reasoning tokens first and emits nothing if the cap is
          // reached — measured, gemini-3.5-flash burned ~380 thinking tokens
          // against a 200 cap and returned `finishReason: MAX_TOKENS` with an
          // empty body, i.e. a silent null at full price on every call. The
          // pinned model does not think, but this must not become a trap for
          // anyone who overrides `cloudScanModel` with one that does.
          maxOutputTokens: 2000,
          responseMimeType: 'application/json',
          responseSchema: CARD_SCHEMA,
        },
      },
      CLOUD_SCAN_TIMEOUT_MS,
      signal,
    )
    const parsed = JSON.parse(responseText(res))
    if (!text(parsed?.name)) return null
    return cloudRead(parsed)
  } catch {
    // A rescue that throws is just a miss — never surface it as a scan error.
    return null
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
