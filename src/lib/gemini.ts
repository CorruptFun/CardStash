import { linkAbort } from './fetchJson'
import { GAME_FULL_NAME, GAMES } from './games'
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

/** Models to fall back to when the configured one 404s (renamed/retired). */
const FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-2.5-flash']
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

/** MTG frame treatments the scanner can distinguish (full-art variants etc.). */
export const MTG_TREATMENTS = ['regular', 'borderless', 'extended', 'showcase', 'retro'] as const
export type MtgTreatment = (typeof MTG_TREATMENTS)[number]

export interface Identification {
  game: Game | 'other'
  name: string
  set_code: string | null
  collector_number: string | null
  confidence: number
  /** True/false when the foil sheen is clearly visible/absent; null when unsure. */
  foil: boolean | null
  /** MTG only: the frame treatment in view, null when unsure or another game. */
  treatment: MtgTreatment | null
}

export async function identifyCardPhoto(
  base64Jpeg: string,
  apiKey: string,
  model: string,
  gameHint?: Game,
  signal?: AbortSignal,
): Promise<Identification | null> {
  const hint = gameHint != null ? `The user says this is a ${GAME_FULL_NAME[gameHint]} card.` : ''
  const res = await callWithFallback(
    model,
    apiKey,
    {
      contents: [
        {
          parts: [
            {
              text: `Identify the trading card in this photo. ${hint}
Rules:
- "game": ${GAMES.join(', ')} — or other (not a TCG card / unreadable). riftbound is the League of Legends TCG, starwars is Star Wars: Unlimited, onepiece is the One Piece Card Game, gundam is the Gundam Card Game.
- "name": the exact printed card name, nothing else (for Lorcana include the version after " - ", e.g. "Elsa - Snow Queen").
- "set_code": the set/expansion code if legible (e.g. "MH3", "PAL", "LOB", "OGN", "OP01"), else null.
- "collector_number": the collector number if legible (e.g. "182/193", "0123"), digits/slash only, else null. Read it carefully — it distinguishes alternate-art versions.
- "confidence": 0 to 1, how sure you are of game+name.
- "foil": true if the surface shows a foil/holographic rainbow sheen, false if plainly matte, null if unsure.
- "treatment": Magic only — the frame: "regular", "borderless" (art fills the card edge to edge / full art), "extended" (art stretched into the side borders), "showcase" (special stylized frame), "retro" (old-style beveled frame). Null for other games or when unsure.
Respond with JSON only.`,
            },
            { inline_data: { mime_type: 'image/jpeg', data: base64Jpeg } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            game: { type: 'STRING', enum: [...GAMES, 'other'] },
            name: { type: 'STRING' },
            set_code: { type: 'STRING', nullable: true },
            collector_number: { type: 'STRING', nullable: true },
            confidence: { type: 'NUMBER' },
            foil: { type: 'BOOLEAN', nullable: true },
            treatment: { type: 'STRING', enum: [...MTG_TREATMENTS], nullable: true },
          },
          required: ['game', 'name', 'confidence'],
        },
        temperature: 0.1,
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
    20_000,
    signal,
  )
  const text = responseText(res)
  if (!text) return null
  try {
    return sanitizeIdentification(JSON.parse(text))
  } catch {
    return null
  }
}

const KNOWN_GAMES = new Set<string>([...GAMES, 'other'])

function sanitizeIdentification(raw: unknown): Identification | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!name || typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence)) return null
  const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  const number = str(obj.collector_number)?.split('/')[0].replace(/^0+(?=\d)/, '') ?? null
  return {
    game: typeof obj.game === 'string' && KNOWN_GAMES.has(obj.game) ? (obj.game as Identification['game']) : 'other',
    name,
    set_code: str(obj.set_code),
    collector_number: number,
    confidence: Math.max(0, Math.min(1, obj.confidence)),
    foil: typeof obj.foil === 'boolean' ? obj.foil : null,
    treatment: MTG_TREATMENTS.includes(obj.treatment as MtgTreatment) ? (obj.treatment as MtgTreatment) : null,
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
