import { fetchJson, isAbort } from './fetchJson'
import { mergePrices } from './prices'
import type { Card, Finish, PriceEntry } from './types'
import { ebaySoldLink, normalizeName, similarity, tcgplayerSearchLink } from './util'

/**
 * Lorcast (lorcast.com) — the Scryfall-alike for Disney Lorcana. Free, no
 * key, daily TCGplayer-derived USD prices.
 */

const API = 'https://api.lorcast.com/v0'

function num(value: unknown): number | null {
  const parsed = typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** Lorcana's printed names are "Name - Version" (e.g. "Elsa - Snow Queen"). */
function fullName(raw: any): string {
  return raw.version ? `${raw.name} - ${raw.version}` : (raw.name ?? 'Unknown card')
}

function toCard(raw: any): Card {
  const entries: PriceEntry[] = []
  const usd = num(raw.prices?.usd)
  const usdFoil = num(raw.prices?.usd_foil)
  if (usd) entries.push({ source: 'tcgplayer', kind: 'market', finish: 'nonfoil', currency: 'USD', value: usd })
  if (usdFoil) entries.push({ source: 'tcgplayer', kind: 'market', finish: 'foil', currency: 'USD', value: usdFoil })

  const name = fullName(raw)
  const types: string[] = Array.isArray(raw.type) ? raw.type : raw.type ? [String(raw.type)] : []
  const classifications: string[] = Array.isArray(raw.classifications) ? raw.classifications : []
  const inks: string[] = Array.isArray(raw.inks) ? raw.inks : raw.ink ? [String(raw.ink)] : []
  const images = raw.image_uris?.digital ?? raw.image_uris ?? {}
  // Which prices exist tells us which finishes exist (Enchanted = foil-only).
  const finishes: Finish[] = [...(usd ? (['nonfoil'] as const) : []), ...(usdFoil ? (['foil'] as const) : [])]
  const releasedAt = raw.set?.released_at ?? raw.released_at

  return {
    id: `lorcana:${raw.id}`,
    game: 'lorcana',
    apiId: String(raw.id),
    name,
    setCode: raw.set?.code ? String(raw.set.code).toUpperCase() : undefined,
    setName: raw.set?.name,
    number: raw.collector_number != null ? String(raw.collector_number) : undefined,
    rarity: typeof raw.rarity === 'string' ? raw.rarity.replace(/_/g, ' ') : undefined,
    releasedAt: typeof releasedAt === 'string' ? releasedAt.slice(0, 10) : undefined,
    finishes: finishes.length ? finishes : undefined,
    imageSmall: images.small ?? images.normal,
    imageLarge: images.large ?? images.normal ?? images.small,
    typeLine: [types.join(' · '), classifications.join(' · ')].filter(Boolean).join(' — ') || undefined,
    subtext: raw.text || undefined,
    cmc: typeof raw.cost === 'number' ? raw.cost : undefined,
    colors: inks,
    supertype: types[0],
    prices: mergePrices(entries),
    links: {
      tcgplayer: tcgplayerSearchLink(name),
      ebaySold: ebaySoldLink({ name, setName: raw.set?.name, game: 'lorcana' }),
      source: `https://lorcast.com/search?q=${encodeURIComponent(name)}`,
    },
  }
}

async function runSearch(query: string, signal?: AbortSignal): Promise<any[]> {
  try {
    const res = await fetchJson(`${API}/cards/search?q=${encodeURIComponent(query)}`, { signal, timeoutMs: 15_000 })
    const rows = res?.results ?? res?.data ?? res
    return Array.isArray(rows) ? rows : []
  } catch (err: any) {
    if (isAbort(err)) throw err
    // Lorcast answers an empty search with 404 — that's "no cards", not an outage.
    if (/HTTP 404/.test(err?.message ?? '')) return []
    throw err
  }
}

export async function searchLorcana(query: string, signal?: AbortSignal): Promise<Card[]> {
  return (await runSearch(query, signal)).slice(0, 30).map(toCard)
}

export async function matchLorcana(name: string, setCode?: string | null, number?: string | null): Promise<Card | null> {
  const results = await runSearch(name).catch(() => [])
  if (!results.length) return null
  let best: { raw: any; score: number } | null = null
  for (const raw of results.slice(0, 25)) {
    let score = Math.max(similarity(name, fullName(raw)), similarity(name, raw.name ?? ''))
    if (number && String(raw.collector_number ?? '') === String(number)) score += 0.15
    if (setCode && String(raw.set?.code ?? '').toLowerCase() === setCode.toLowerCase()) score += 0.1
    if (!best || score > best.score) best = { raw, score }
  }
  return best ? toCard(best.raw) : null
}

/** Every printing of an exact card name (base set, promos, Enchanted). */
export async function lorcanaPrintings(name: string, signal?: AbortSignal): Promise<Card[]> {
  const rows = await runSearch(name, signal).catch(() => [])
  const target = normalizeName(name)
  return rows
    .filter((raw: any) => normalizeName(fullName(raw)) === target)
    .slice(0, 60)
    .map(toCard)
}

export async function lorcanaById(id: string): Promise<Card | null> {
  try {
    const res = await fetchJson(`${API}/cards/${encodeURIComponent(id)}`, { timeoutMs: 15_000 })
    const raw = res?.id ? res : (res?.data ?? null)
    return raw ? toCard(raw) : null
  } catch {
    return null
  }
}
