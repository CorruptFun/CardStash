import type { Game } from './types'

export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** YYYY-MM-DD in UTC. */
export function ymd(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10)
}

export function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  return abs >= 1000 ? `${sign}$${Math.round(abs).toLocaleString('en-US')}` : `${sign}$${abs.toFixed(2)}`
}

export function dateTime(at: number): string {
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Compact age: "5m", "3h", "12d". */
export function relativeAge(at: number): string {
  const ms = Math.max(0, Date.now() - at)
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = new Array<number>(b.length + 1)
  let next = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    next[0] = i
    const code = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = code === b.charCodeAt(j - 1) ? 0 : 1
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, next] = [next, prev]
  }
  return prev[b.length]
}

/** 0..1 name similarity, accent/punctuation-insensitive. */
export function similarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na.length || !nb.length) return 0
  return 1 - levenshtein(na, nb) / Math.max(na.length, nb.length)
}

/**
 * How well an OCR read matches a card name, forgiving a missing epithet:
 * the card prints "JINX" over "Loose Cannon" but the catalog says
 * "Jinx, Loose Cannon" (Lorcana's "Elsa - Snow Queen" splits the same way),
 * so the name's leading segment counts almost as much as the whole. The
 * small penalty keeps a full-name read ranked above a partial one.
 */
export function nameScore(read: string, cardName: string): number {
  let score = similarity(read, cardName)
  const lead = cardName.split(/,|:|\s[-–—]\s/)[0]?.trim()
  if (lead && lead.length >= 3 && lead.length < cardName.length) {
    score = Math.max(score, similarity(read, lead) - 0.05)
  }
  return score
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const EBAY_GAME_WORD: Record<Game, string> = {
  mtg: 'mtg',
  pokemon: 'pokemon',
  yugioh: 'yugioh',
  riftbound: 'riftbound',
  lorcana: 'lorcana',
  onepiece: 'one piece card game',
  starwars: 'star wars unlimited',
  digimon: 'digimon tcg',
  gundam: 'gundam card game',
}

export function ebaySoldLink(card: { name: string; setName?: string; game: Game }): string {
  const query = [card.name, card.setName ?? '', EBAY_GAME_WORD[card.game]].join(' ').trim()
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1&_sop=13`
}

export function tcgplayerSearchLink(name: string): string {
  return `https://www.tcgplayer.com/search/all/product?q=${encodeURIComponent(name)}&view=grid`
}

export function haptic(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* not supported */
  }
}
