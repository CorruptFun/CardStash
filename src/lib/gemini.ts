import { linkAbort } from './fetchJson'
import { GAME_FULL_NAME } from './games'
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
let lastServedModel: string | null = null

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
      lastServedModel = candidate
      return res
    } catch (err) {
      lastError = err
      if (!(err instanceof GeminiError && err.status === 404)) throw err
    }
  }
  throw lastError
}

export async function testGeminiKey(
  apiKey: string,
  model: string,
): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
  try {
    await callWithFallback(
      model,
      apiKey,
      {
        contents: [{ parts: [{ text: 'Reply with the single word OK.' }] }],
        generationConfig: { maxOutputTokens: 16, temperature: 0 },
      },
      12_000,
    )
    return { ok: true, model: lastServedModel ?? model }
  } catch (err: any) {
    return { ok: false, error: err.message?.slice(0, 200) ?? 'Unknown error' }
  }
}

/* --- Cloud scan rescue -----------------------------------------------------
 * A LAST RESORT for the scan pipeline, not a replacement for it. Identification
 * is on-device by design (decisions.md 2) — it works offline, on first launch,
 * with no key and no account, and no image leaves the device. That path is
 * unchanged and still the default.
 *
 * What it cannot do is read a name that Tesseract cannot see: a foil sheen
 * riding the glyphs, gold script on full art, a two-letter suffix lost to a
 * moving highlight. Measured, that last one is not merely a miss but the
 * WORST failure class — dropping "ex" leaves a bare species that matches a
 * real, cheaper card EXACTLY, so no threshold can reject it (lesson 29/47).
 *
 * So this runs ONLY after every local pass has failed, ONLY when the user
 * supplied their own key AND opted in, and its answer is never trusted on its
 * own: `identify.ts` requires the returned collector number to agree with a
 * catalog row before accepting it. A cloud model returns confident wrong
 * answers too — it just loses the intermediate evidence (band text, collector
 * line) the local guards bite on, which is exactly why the number is asked for
 * alongside the name.
 */

/** What the model is asked to read off the card — printed values only. */
export interface CloudCardRead {
  name: string
  number?: string
  printedTotal?: string
  setCode?: string
  game?: string
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
  },
  required: ['name'],
}

const CARD_PROMPT =
  'You are reading a trading card photograph for a collection app. ' +
  'Return the card NAME exactly as printed, including any suffix that is part of the name ' +
  '(ex, GX, V, VMAX, VSTAR) and any possessive prefix ("Iono\'s", "Team Rocket\'s"). ' +
  'Also return the collector number and printed set total from the small collector line ' +
  '(for "055/086": number "055", printedTotal "086"), and the printed set code if visible. ' +
  'CRITICAL: omit any field you cannot actually read on the card. Never guess a number. ' +
  'An omitted field is correct; an invented one is not.'

/** Scanning is interactive — a rescue that outlives the user's patience is a miss. */
const CLOUD_SCAN_TIMEOUT_MS = 12_000

/**
 * The model the scan rescue uses, pinned SEPARATELY from `geminiModel`.
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
    const parsed = await res.json()
    return parsed?.name ? (parsed as CloudCardRead) : null
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
    const text = (value: unknown): string | undefined => {
      const s = typeof value === 'string' ? value.trim() : ''
      return s && s.toLowerCase() !== 'unknown' && s.toLowerCase() !== 'null' ? s : undefined
    }
    const name = text(parsed?.name)
    if (!name) return null
    return {
      name,
      number: text(parsed?.number),
      printedTotal: text(parsed?.printedTotal),
      setCode: text(parsed?.setCode),
      game: text(parsed?.game),
    }
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

/** What goes inside the ```decklist fence, per game. */
const DECKLIST_SPEC: Record<Game, string> = {
  mtg: ' (main deck, 60 cards, include lands).',
  pokemon: ' (60 cards including energy).',
  yugioh: ' (Main Deck 40-60; then a line `-- Extra Deck --` and extra deck monsters).',
  riftbound: ' (main deck, exactly 40 cards; name the Legend, runes and battlefields outside the code block).',
  lorcana: ' (60 cards, at most two inks).',
  onepiece: ' (exactly 50 cards; name the Leader outside the code block).',
  starwars: ' (50+ cards; name the Leader and Base outside the code block).',
  digimon: ' (main deck, exactly 50 cards; then a line `-- Egg Deck --` and up to 5 Digi-Eggs).',
  gundam: ' (exactly 50 cards; resource deck is fixed, skip it).',
}

export async function buildDecks(request: BuildDecksRequest, apiKey: string, model: string): Promise<BuildDecksResult> {
  const { game, format, style, budget, collectionList, useCollection, seedCards } = request
  const seedList = (seedCards ?? [])
    .map((card) => `- ${card.name}${card.setName ? ` (${card.setName})` : ''}`)
    .join('\n')
  const prompt = [
    `You are an expert ${GAME_FULL_NAME[game]} deck builder. Use Google Search to check the CURRENT competitive metagame (tier lists, recent tournament results) before answering.`,
    format ? `Format: ${format}.` : '',
    style ? `The player wants: ${style}.` : '',
    seedList
      ? `Build every deck AROUND these specific cards — each proposal must include them and make them central to the game plan:\n${seedList}`
      : '',
    budget != null ? `Budget for cards they still need to buy: about $${budget} USD.` : '',
    useCollection && collectionList
      ? `The player's collection (name ×qty):\n${collectionList}\n\nBuild primarily from these cards; only add cards to buy when they matter.`
      : 'Assume the player is starting from scratch.',
    '',
    'Reply in markdown with exactly this structure:',
    '1. `## Meta snapshot` — 3-5 bullets on the current meta with dates/sources.',
    '2. Then 2 deck proposals. Each one:',
    '   - `## Deck: <deck name>` — one line on the game plan and why it fits.',
    '   - A fenced code block starting with ```decklist containing ONLY lines of the form `<qty> <exact card name>`' +
      DECKLIST_SPEC[game],
    '   - `**To buy:**` bullets of the key cards they lack, with rough per-card prices.',
    'Keep total response under 900 words. Card names must be exact printed names.',
  ]
    .filter(Boolean)
    .join('\n')

  const res = await callWithFallback(
    model,
    apiKey,
    {
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.6, maxOutputTokens: 4096 },
    },
    60_000,
  )
  const markdown = responseText(res)
  if (!markdown) throw new GeminiError('Gemini returned an empty response')
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
