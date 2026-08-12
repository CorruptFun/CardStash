import { pickValue } from './prices'
import type { Card, DeckBoard, DeckCard, Game } from './types'

export const BOARD_LABEL: Record<DeckBoard, string> = {
  main: 'Main deck',
  extra: 'Extra deck',
  side: 'Sideboard',
}

export const BOARD_SHORT: Record<DeckBoard, string> = {
  main: 'Main',
  extra: 'Extra',
  side: 'Side',
}

export const GAME_BOARDS: Record<Game, DeckBoard[]> = {
  mtg: ['main', 'side'],
  pokemon: ['main'],
  yugioh: ['main', 'extra', 'side'],
  riftbound: ['main', 'side'],
  lorcana: ['main'],
  onepiece: ['main', 'side'],
  starwars: ['main', 'side'],
  digimon: ['main', 'extra'],
  gundam: ['main', 'side'],
}

/**
 * Route cards that live in a separate pile to it when adding "to the deck":
 * YGO Extra-Deck monsters, Digimon Digi-Eggs (their "extra" board).
 */
export function boardForCard(game: Game, supertype: string | undefined, board: DeckBoard): DeckBoard {
  if (board !== 'main') return board
  if (game === 'yugioh' && supertype === 'Extra Monster') return 'extra'
  if (game === 'digimon' && /digi-?egg/i.test(supertype ?? '')) return 'extra'
  return board
}

export function addedToBoardToast(name: string, board: DeckBoard): string {
  return board === 'main' ? `+1 ${name}` : `+1 ${name} · ${BOARD_LABEL[board].toLowerCase()}`
}

const PREMIUM_FINISHES = ['foil', 'holo', 'etched', 'firstEd', 'reverse'] as const

/** Deck rows price at the card's headline (NM nonfoil-ish) USD price. */
export function deckRowUnitPrice(row: DeckCard): number {
  const { prices } = row.card
  return (
    pickValue(prices.entries, ['nonfoil']) ??
    pickValue(prices.entries, [...PREMIUM_FINISHES]) ??
    (prices.entries.length ? 0 : (prices.best ?? 0))
  )
}

export interface DeckStats {
  counts: Record<DeckBoard, number>
  total: number
  value: number
  /** Main-board mana curve buckets 0..7+ (MTG, non-land). */
  curve: number[]
  colors: Record<string, number>
  types: { type: string; count: number }[]
  owned: number
  missing: { qty: number; usd: number }
  warnings: string[]
}

export function deckStats(game: Game, rows: DeckCard[], ownedByName?: Map<string, number>): DeckStats {
  const counts: Record<DeckBoard, number> = { main: 0, side: 0, extra: 0 }
  const curve = new Array<number>(8).fill(0)
  const colors: Record<string, number> = {}
  const typeCounts = new Map<string, number>()
  let valueUsd = 0
  let owned = 0
  const missing = { qty: 0, usd: 0 }
  const remaining = new Map(ownedByName ?? [])

  for (const row of rows) {
    counts[row.board] += row.qty
    valueUsd += deckRowUnitPrice(row) * row.qty

    const supertype = row.card.supertype ?? 'Other'
    typeCounts.set(supertype, (typeCounts.get(supertype) ?? 0) + row.qty)

    if (game === 'mtg') {
      const isLand = supertype === 'Land'
      if (!isLand && row.board === 'main') {
        const bucket = Math.min(7, Math.max(0, Math.round(row.card.cmc ?? 0)))
        curve[bucket] += row.qty
      }
      for (const color of row.card.colors ?? []) colors[color] = (colors[color] ?? 0) + row.qty
      if (!row.card.colors?.length && !isLand) colors.C = (colors.C ?? 0) + row.qty
    }

    {
      const key = row.card.name.toLowerCase()
      const have = remaining.get(key) ?? 0
      const claimed = ownedByName ? Math.min(have, row.qty) : 0
      owned += claimed
      remaining.set(key, have - claimed)
      const short = row.qty - claimed
      if (short > 0) {
        missing.qty += short
        missing.usd += deckRowUnitPrice(row) * short
      }
    }
  }

  const total = counts.main + counts.side + counts.extra
  const types = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
  missing.usd = Math.round(missing.usd * 100) / 100
  return {
    counts,
    total,
    value: Math.round(valueUsd * 100) / 100,
    curve,
    colors,
    types,
    owned,
    missing,
    warnings: deckWarnings(game, counts, rows),
  }
}

interface DeckRules {
  /** Main deck must reach this size (warn below it). */
  minMain?: number
  /** Main deck is exactly this size (warn on either side of it). */
  exactMain?: number
  maxMain?: number
  maxSide?: number
  maxExtra?: number
  copyLimit: number
  /** Supertypes exempt from the copy limit when "basic" (lands, energy). */
  copyExempt?: string[]
  /** Pokémon/Lorcana just say "Deck"; the rest "Main deck". */
  mainNoun?: string
}

const DECK_RULES: Record<Game, DeckRules> = {
  mtg: { minMain: 60, maxSide: 15, copyLimit: 4, copyExempt: ['Land'] },
  pokemon: { exactMain: 60, copyLimit: 4, copyExempt: ['Energy'], mainNoun: 'Deck' },
  yugioh: { minMain: 40, maxMain: 60, maxExtra: 15, copyLimit: 3 },
  riftbound: { exactMain: 40, copyLimit: 3 },
  lorcana: { minMain: 60, copyLimit: 4, mainNoun: 'Deck' },
  onepiece: { exactMain: 50, copyLimit: 4 },
  starwars: { minMain: 50, maxSide: 10, copyLimit: 3 },
  digimon: { exactMain: 50, maxExtra: 5, copyLimit: 4 },
  gundam: { exactMain: 50, maxSide: 10, copyLimit: 4 },
}

function deckWarnings(game: Game, counts: Record<DeckBoard, number>, rows: DeckCard[]): string[] {
  const rules = DECK_RULES[game]
  const warnings: string[] = []
  const noun = rules.mainNoun ?? 'Main deck'
  const floor = rules.exactMain ?? rules.minMain
  if (floor && counts.main > 0 && counts.main < floor) warnings.push(`${noun} has ${counts.main}/${floor} cards`)
  if (rules.exactMain && counts.main > rules.exactMain)
    warnings.push(`${noun} has ${counts.main}/${rules.exactMain} cards`)
  if (rules.maxMain && counts.main > rules.maxMain) warnings.push(`${noun} over ${rules.maxMain} (${counts.main})`)
  if (rules.maxSide && counts.side > rules.maxSide) warnings.push(`Sideboard over ${rules.maxSide} (${counts.side})`)
  if (rules.maxExtra && counts.extra > rules.maxExtra)
    warnings.push(`Extra deck over ${rules.maxExtra} (${counts.extra})`)
  for (const name of overCopyLimit(rows, rules.copyLimit, rules.copyExempt ?? []))
    warnings.push(`More than ${rules.copyLimit}× ${name}`)
  return warnings
}

/** Names past the copy limit, skipping basic lands/energy. Sideboard exempt. */
function overCopyLimit(rows: DeckCard[], limit: number, exemptSupertypes: string[] = []): string[] {
  const byName = new Map<string, { qty: number; supertype: string; typeLine: string }>()
  for (const row of rows) {
    if (row.board === 'side') continue
    const existing = byName.get(row.card.name)
    byName.set(row.card.name, {
      qty: (existing?.qty ?? 0) + row.qty,
      supertype: row.card.supertype ?? '',
      typeLine: row.card.typeLine ?? '',
    })
  }
  const over: string[] = []
  for (const [name, info] of byName) {
    if (info.qty <= limit) continue
    const exemptBasic =
      exemptSupertypes.includes(info.supertype) &&
      (/basic/i.test(info.typeLine) || info.supertype === 'Land' || info.supertype === 'Energy')
    if (exemptBasic) continue
    over.push(name)
  }
  return over
}

export interface BoardGroup {
  board: DeckBoard
  groups: { type: string; cards: DeckCard[] }[]
}

export function groupBoards(rows: DeckCard[]): BoardGroup[] {
  const order: DeckBoard[] = ['main', 'extra', 'side']
  const boards: BoardGroup[] = []
  for (const board of order) {
    const boardRows = rows.filter((row) => row.board === board)
    if (!boardRows.length) continue
    const byType = new Map<string, DeckCard[]>()
    for (const row of boardRows) {
      const type = row.card.supertype ?? 'Other'
      const list = byType.get(type) ?? []
      list.push(row)
      byType.set(type, list)
    }
    const groups = [...byType.entries()]
      .map(([type, cards]) => ({
        type,
        cards: cards.sort(
          (a, b) => (a.card.cmc ?? 0) - (b.card.cmc ?? 0) || a.card.name.localeCompare(b.card.name),
        ),
      }))
      .sort(
        (a, b) =>
          b.cards.reduce((sum, row) => sum + row.qty, 0) - a.cards.reduce((sum, row) => sum + row.qty, 0),
      )
    boards.push({ board, groups })
  }
  return boards
}

/** Plain-text decklist for the clipboard. */
export function decklistText(rows: DeckCard[]): string {
  const section = (board: DeckBoard, header?: string) => {
    const boardRows = rows.filter((row) => row.board === board)
    if (!boardRows.length) return ''
    const lines = boardRows
      .slice()
      .sort((a, b) => a.card.name.localeCompare(b.card.name))
      .map((row) => `${row.qty} ${row.card.name}`)
      .join('\n')
    return header ? `${header}\n${lines}` : lines
  }
  return [section('main'), section('extra', '\nExtra Deck'), section('side', '\nSideboard')]
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** Card the deck tile shows: the chosen cover, else the priciest card. */
export function deckCoverCard(rows: DeckCard[], coverCardId?: string): Card | undefined {
  return (
    rows.find((row) => row.cardId === coverCardId)?.card ??
    [...rows].sort((a, b) => deckRowUnitPrice(b) - deckRowUnitPrice(a))[0]?.card
  )
}
