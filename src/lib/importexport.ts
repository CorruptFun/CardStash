import type { ImportRow } from './cardsearch'
import { parseCsv, csvField } from './csv'
import { FINISH_LABEL, GAMES } from './games'
import { itemUnitPrice, parseMoney } from './prices'
import type { CollectionItem, Condition, Finish, Game } from './types'

/** Header-flexible collection CSV import (ManaBox/Dragon Shield-ish exports). */

const CONDITION_ALIASES: Record<string, Condition> = {
  mint: 'M',
  near_mint: 'NM',
  excellent: 'NM',
  good: 'LP',
  lightly_played: 'LP',
  light_played: 'LP',
  played: 'MP',
  moderately_played: 'MP',
  poor: 'HP',
  heavily_played: 'HP',
  damaged: 'DMG',
}

export function normalizeCondition(raw: string): Condition {
  const key = raw.trim().toLowerCase().replace(/\s+/g, '_')
  if (CONDITION_ALIASES[key]) return CONDITION_ALIASES[key]
  const upper = raw.trim().toUpperCase()
  return (['M', 'NM', 'LP', 'MP', 'HP', 'DMG'] as Condition[]).includes(upper as Condition)
    ? (upper as Condition)
    : 'NM'
}

const GAME_ALIASES: Record<string, Game> = {
  mtg: 'mtg',
  magic: 'mtg',
  'magic: the gathering': 'mtg',
  'magic the gathering': 'mtg',
  pokemon: 'pokemon',
  pokémon: 'pokemon',
  pkm: 'pokemon',
  ptcg: 'pokemon',
  yugioh: 'yugioh',
  ygo: 'yugioh',
  'yu-gi-oh': 'yugioh',
  'yu-gi-oh!': 'yugioh',
  'yugi-oh': 'yugioh',
  riftbound: 'riftbound',
  rift: 'riftbound',
  'riftbound: league of legends tcg': 'riftbound',
  'league of legends': 'riftbound',
  'lol tcg': 'riftbound',
  lorcana: 'lorcana',
  'disney lorcana': 'lorcana',
  lor: 'lorcana',
  onepiece: 'onepiece',
  'one piece': 'onepiece',
  'one piece card game': 'onepiece',
  op: 'onepiece',
  optcg: 'onepiece',
  starwars: 'starwars',
  'star wars': 'starwars',
  'star wars unlimited': 'starwars',
  'star wars: unlimited': 'starwars',
  swu: 'starwars',
  digimon: 'digimon',
  'digimon card game': 'digimon',
  digi: 'digimon',
  gundam: 'gundam',
  'gundam card game': 'gundam',
  gcg: 'gundam',
}

export function normalizeGame(raw: string | undefined): Game | undefined {
  const key = raw?.trim().toLowerCase()
  if (!key) return undefined
  return GAMES.includes(key as Game) ? (key as Game) : GAME_ALIASES[key]
}

const FINISH_ALIASES: Record<string, Finish> = {
  '': 'nonfoil',
  nonfoil: 'nonfoil',
  'non-foil': 'nonfoil',
  normal: 'nonfoil',
  regular: 'nonfoil',
  none: 'nonfoil',
  no: 'nonfoil',
  false: 'nonfoil',
  '0': 'nonfoil',
  foil: 'foil',
  true: 'foil',
  yes: 'foil',
  y: 'foil',
  '1': 'foil',
  etched: 'etched',
  'etched foil': 'etched',
  holo: 'holo',
  'holo foil': 'holo',
  holographic: 'holo',
  holofoil: 'holo',
  unlimitedholofoil: 'holo',
  reverse: 'reverse',
  'reverse holo': 'reverse',
  'reverse holofoil': 'reverse',
  reverseholofoil: 'reverse',
  firsted: 'firstEd',
  '1st edition': 'firstEd',
  '1stedition': 'firstEd',
  'first edition': 'firstEd',
  '1steditionholofoil': 'firstEd',
  '1steditionnormal': 'firstEd',
}

export function normalizeFinish(raw: string | undefined): Finish {
  const key = (raw ?? '').trim().toLowerCase()
  const byLabel = Object.entries(FINISH_LABEL).find(([, label]) => label.toLowerCase() === key)
  return FINISH_ALIASES[key] ?? (byLabel?.[0] as Finish | undefined) ?? 'nonfoil'
}

export interface CsvImportRow extends ImportRow {
  finish: Finish
  foil: boolean
  condition: Condition
  language?: string
  purchasePrice?: number
  scryfallId?: string
  forTrade?: number
}

/** "2" → 2, "yes"/"all" → the row's qty, junk → none. */
function parseForTrade(raw: string | undefined, qty: number): number | undefined {
  const key = raw?.trim().toLowerCase()
  if (!key) return undefined
  if (['yes', 'y', 'true', 'all'].includes(key)) return qty
  const count = Number.parseInt(key, 10)
  return Number.isFinite(count) && count > 0 ? Math.min(count, qty) : undefined
}

export function parseCollectionCsv(text: string): CsvImportRow[] {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new Error('CSV has no data rows')
  const header = rows[0].map((cell) => cell.trim().toLowerCase())
  const col = (...names: string[]) => {
    for (const name of names) {
      const at = header.indexOf(name)
      if (at !== -1) return at
    }
    return -1
  }
  const name = col('name', 'card name')
  const game = col('game', 'tcg')
  const setCode = col('set code', 'set', 'edition')
  const number = col('collector number', 'card number', 'number')
  const apiId = col('api id', 'api_id', 'scryfall id', 'scryfall_id')
  const qty = col('quantity', 'qty', 'count')
  const finish = col('finish', 'foil', 'printing')
  const condition = col('condition')
  const language = col('language', 'lang')
  const price = col('purchase price', 'price paid', 'cost')
  const forTrade = col('for trade', 'trade', 'for_trade', 'trade quantity')
  if (name === -1) throw new Error('No "Name" column found — is this a collection CSV export?')

  const parsed: CsvImportRow[] = []
  for (const cells of rows.slice(1)) {
    const cardName = cells[name]?.trim()
    if (!cardName) continue
    const rowGame = game === -1 ? undefined : normalizeGame(cells[game])
    const rowApiId = apiId === -1 ? undefined : cells[apiId]?.trim() || undefined
    const rowFinish = normalizeFinish(finish === -1 ? '' : cells[finish])
    const rowQty = Math.max(1, parseInt(qty === -1 ? '1' : cells[qty] || '1', 10) || 1)
    parsed.push({
      name: cardName,
      game: rowGame,
      setCode: setCode === -1 ? undefined : cells[setCode]?.trim() || undefined,
      number: number === -1 ? undefined : cells[number]?.trim() || undefined,
      apiId: rowApiId,
      scryfallId: rowGame == null || rowGame === 'mtg' ? rowApiId : undefined,
      qty: rowQty,
      finish: rowFinish,
      foil: rowFinish !== 'nonfoil',
      condition: normalizeCondition(condition === -1 ? 'NM' : cells[condition] || 'NM'),
      language: language === -1 ? undefined : cells[language]?.trim() || undefined,
      purchasePrice: parsePurchasePrice(price === -1 ? undefined : cells[price]),
      forTrade: parseForTrade(forTrade === -1 ? undefined : cells[forTrade], rowQty),
    })
  }
  if (!parsed.length) throw new Error('No importable rows found')
  return parsed
}

function parsePurchasePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  // Ranges and parenthesized (negative) figures are not a unit cost basis.
  if (trimmed.includes('-') || /^\(.*\)$/.test(trimmed)) return undefined
  return parseMoney(trimmed) ?? undefined
}

const EXPORT_HEADER = [
  'Game',
  'Name',
  'Set code',
  'Set name',
  'Collector number',
  'Rarity',
  'Quantity',
  'Finish',
  'Condition',
  'For trade',
  'Sealed',
  'Unit price (USD)',
  'Purchase price',
  'API id',
  'Added',
]

export function collectionToCsv(items: CollectionItem[]): string {
  const lines = [EXPORT_HEADER.join(',')]
  for (const item of items) {
    lines.push(
      [
        item.game,
        item.name,
        item.setCode ?? '',
        item.setName ?? item.card.setName ?? '',
        item.number ?? '',
        item.rarity ?? item.card.rarity ?? '',
        item.qty,
        item.finish === 'nonfoil' ? '' : item.finish,
        item.condition,
        item.forTrade ?? '',
        item.opened == null ? '' : item.opened ? 'opened' : 'sealed',
        itemUnitPrice(item)?.toFixed(2) ?? '',
        item.purchasePrice?.toFixed(2) ?? '',
        item.card.apiId,
        new Date(item.addedAt).toISOString().slice(0, 10),
      ]
        .map(csvField)
        .join(','),
    )
  }
  return lines.join('\n')
}
