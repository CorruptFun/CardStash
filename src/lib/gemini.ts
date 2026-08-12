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
