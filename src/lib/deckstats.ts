import { displayCurrency, priceCurrency, bestFor, pickValue } from './prices'
import type { Card, Currency, DeckBoard, DeckCard, Game } from './types'

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
}

/** Route Extra-Deck monsters to the extra board when adding to a YGO deck. */
export function boardForCard(game: Game, supertype: string | undefined, board: DeckBoard): DeckBoard {
  return board === 'main' && game === 'yugioh' && supertype === 'Extra Monster' ? 'extra' : board
}

export function addedToBoardToast(name: string, board: DeckBoard): string {
  return board === 'main' ? `+1 ${name}` : `+1 ${name} · ${BOARD_LABEL[board].toLowerCase()}`
}

const PREMIUM_FINISHES = ['foil', 'holo', 'etched', 'firstEd', 'reverse'] as const

/** Deck rows price at the card's headline (NM nonfoil-ish) price. */
export function deckRowUnitPrice(row: DeckCard, currency: Currency = displayCurrency()): number {
  const { prices } = row.card
  return (
    (currency === 'USD' ? prices.best : (bestFor(prices, currency) ?? prices.best)) ??
    pickValue(prices.entries, [...PREMIUM_FINISHES], currency) ??
    0
  )
}

export function deckRowCurrency(row: DeckCard, currency: Currency = displayCurrency()): Currency {
  return priceCurrency(row.card.prices, 'best', currency)
}

export interface DeckStats {
  counts: Record<DeckBoard, number>
  total: number
  value: number
  valueEur: number
  /** Main-board mana curve buckets 0..7+ (MTG, non-land). */
  curve: number[]
  colors: Record<string, number>
  types: { type: string; count: number }[]
  owned: number
  missing: { qty: number; usd: number; eur: number }
  warnings: string[]
}

export function deckStats(game: Game, rows: DeckCard[], ownedByName?: Map<string, number>): DeckStats {
  const currency = displayCurrency()
  const counts: Record<DeckBoard, number> = { main: 0, side: 0, extra: 0 }
  const curve = new Array<number>(8).fill(0)
  const colors: Record<string, number> = {}
  const typeCounts = new Map<string, number>()
  let valueUsd = 0
  let valueEur = 0
  let owned = 0
  const missing = { qty: 0, usd: 0, eur: 0 }
  const remaining = new Map(ownedByName ?? [])

  for (const row of rows) {
    counts[row.board] += row.qty
    const rowValue = deckRowUnitPrice(row, currency) * row.qty
    if (rowValue > 0) (deckRowCurrency(row, currency) === 'EUR' ? (valueEur += rowValue) : (valueUsd += rowValue))

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
        const shortValue = deckRowUnitPrice(row, currency) * short
        if (shortValue > 0) (deckRowCurrency(row, currency) === 'EUR' ? (missing.eur += shortValue) : (missing.usd += shortValue))
      }
    }
  }

  const total = counts.main + counts.side + counts.extra
  const types = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
  missing.usd = Math.round(missing.usd * 100) / 100
  missing.eur = Math.round(missing.eur * 100) / 100
  return {
    counts,
    total,
    value: Math.round(valueUsd * 100) / 100,
    valueEur: Math.round(valueEur * 100) / 100,
    curve,
    colors,
    types,
    owned,
    missing,
    warnings: deckWarnings(game, counts, rows),
  }
}

function deckWarnings(game: Game, counts: Record<DeckBoard, number>, rows: DeckCard[]): string[] {
  const warnings: string[] = []
  if (game === 'mtg') {
    if (counts.main > 0 && counts.main < 60) warnings.push(`Main deck has ${counts.main}/60 cards`)
    if (counts.side > 15) warnings.push(`Sideboard over 15 (${counts.side})`)
    for (const name of overCopyLimit(rows, 4, ['Land'])) warnings.push(`More than 4× ${name}`)
  } else if (game === 'pokemon') {
    if (counts.main > 0 && counts.main !== 60) warnings.push(`Deck has ${counts.main}/60 cards`)
    for (const name of overCopyLimit(rows, 4, ['Energy'])) warnings.push(`More than 4× ${name}`)
  } else {
    if (counts.main > 0 && counts.main < 40) warnings.push(`Main deck has ${counts.main}/40 cards`)
    if (counts.main > 60) warnings.push(`Main deck over 60 (${counts.main})`)
    if (counts.extra > 15) warnings.push(`Extra deck over 15 (${counts.extra})`)
    for (const name of overCopyLimit(rows, 3)) warnings.push(`More than 3× ${name}`)
  }
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

export interface DeckMoney {
  usd: string
  eur: string | null
}

/** Card the deck tile shows: the chosen cover, else the priciest card. */
export function deckCoverCard(rows: DeckCard[], coverCardId?: string): Card | undefined {
  return (
    rows.find((row) => row.cardId === coverCardId)?.card ??
    [...rows].sort((a, b) => deckRowUnitPrice(b) - deckRowUnitPrice(a))[0]?.card
  )
}
