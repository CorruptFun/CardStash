import { settings } from './settings'
import type {
  Card,
  Condition,
  Currency,
  Finish,
  PriceEntry,
  Prices,
} from './types'

/** Rows that price like a collection item, without needing a full item. */
export interface Priceable {
  finish: Finish
  condition: Condition
  qty: number
  card: Card
}

export function displayCurrency(): Currency {
  try {
    return settings().currency === 'EUR' ? 'EUR' : 'USD'
  } catch {
    return 'USD'
  }
}

/**
 * Pick the most trustworthy entry among `finishes`, favoring the display
 * currency: EUR display prefers Cardmarket trend; USD prefers TCGplayer market.
 */
export function pickEntry(
  entries: PriceEntry[],
  finishes: Finish[],
  currency: Currency = 'USD',
): PriceEntry | null {
  const pool = entries.filter((e) => finishes.includes(e.finish) && e.value > 0)
  if (!pool.length) return null
  const find = (fn: (e: PriceEntry) => boolean) => pool.find(fn) ?? null
  if (currency === 'EUR') {
    const eur =
      find((e) => e.source === 'cardmarket' && e.kind === 'trend' && e.currency === 'EUR') ??
      find((e) => e.currency === 'EUR' && e.kind === 'trend') ??
      find((e) => e.currency === 'EUR' && e.kind === 'market') ??
      find((e) => e.currency === 'EUR' && e.kind !== 'high') ??
      find((e) => e.currency === 'EUR')
    if (eur) return eur
  }
  return (
    find((e) => e.source === 'tcgplayer' && e.kind === 'market' && e.currency === 'USD') ??
    find((e) => e.kind === 'market' && e.currency === 'USD') ??
    find((e) => e.source === 'cardmarket' && e.kind === 'trend') ??
    find((e) => e.currency === 'USD' && e.kind !== 'high') ??
    find((e) => e.currency === 'USD') ??
    find(() => true)
  )
}

export function pickValue(
  entries: PriceEntry[],
  finishes: Finish[],
  currency: Currency = 'USD',
): number | null {
  return pickEntry(entries, finishes, currency)?.value ?? null
}

const PLAIN: Finish[] = ['nonfoil']
const PREMIUM: Finish[] = ['foil', 'holo', 'etched', 'firstEd', 'reverse']

export function bestEntry(
  prices: Prices,
  kind: 'best' | 'foil' = 'best',
  currency: Currency = displayCurrency(),
): PriceEntry | null {
  const premium = pickEntry(prices.entries, PREMIUM, currency)
  if (kind === 'foil') return premium
  return pickEntry(prices.entries, PLAIN, currency) ?? premium
}

export function priceCurrency(
  prices: Prices,
  kind: 'best' | 'foil' = 'best',
  currency: Currency = displayCurrency(),
): Currency {
  return bestEntry(prices, kind, currency)?.currency ?? 'USD'
}

export function bestFor(prices: Prices, currency: Currency): number | null {
  return currency === 'USD' ? prices.best : (bestEntry(prices, 'best', currency)?.value ?? prices.best)
}

export function bestFoilFor(prices: Prices, currency: Currency): number | null {
  return currency === 'USD' ? prices.bestFoil : (pickEntry(prices.entries, PREMIUM, currency)?.value ?? prices.bestFoil)
}

/** The finish the card's headline price refers to, clamped to `allowed`. */
export function headlineFinish(prices: Prices, allowed?: Finish[]): Finish {
  const finish = bestEntry(prices, 'best')?.finish ?? 'nonfoil'
  return allowed && !allowed.includes(finish) ? allowed[0] : finish
}

/** Derive the `best`/`bestFoil` headline numbers from a raw entry list. */
export function mergePrices(entries: PriceEntry[], updatedAt = Date.now()): Prices {
  return {
    best: pickValue(entries, PLAIN) ?? pickValue(entries, PREMIUM),
    bestFoil: pickValue(entries, PREMIUM),
    entries,
    updatedAt,
  }
}

const CONDITION_FACTOR: Record<Condition, number> = {
  M: 1,
  NM: 1,
  LP: 0.85,
  MP: 0.7,
  HP: 0.55,
  DMG: 0.4,
}

export function conditionFactor(condition: Condition): number {
  return CONDITION_FACTOR[condition] ?? 1
}

/** Per-copy value of an item: finish-specific price × condition factor. */
export function itemUnitPrice(item: Priceable, currency = displayCurrency()): number | null {
  const raw = itemRawUnitPrice(item, currency)
  if (raw == null) return null
  const factor = conditionFactor(item.condition)
  return factor === 1 ? raw : Math.round(raw * factor * 100) / 100
}

function itemRawUnitPrice(item: Priceable, currency = displayCurrency()): number | null {
  const { prices } = item.card
  return item.finish === 'nonfoil'
    ? bestFor(prices, currency)
    : (pickValue(prices.entries, [item.finish], currency) ??
        bestFoilFor(prices, currency) ??
        bestFor(prices, currency))
}

export function itemCurrency(item: Priceable, currency = displayCurrency()): Currency {
  const { prices } = item.card
  return (
    (item.finish === 'nonfoil'
      ? bestEntry(prices, 'best', currency)
      : (pickEntry(prices.entries, [item.finish], currency) ??
          bestEntry(prices, 'foil', currency) ??
          bestEntry(prices, 'best', currency)))?.currency ?? 'USD'
  )
}

export function itemValue(item: Priceable, currency = displayCurrency()): number {
  return (itemUnitPrice(item, currency) ?? 0) * item.qty
}

export interface MoneyPair {
  usd: number
  eur: number
}

export function collectionValue(items: Priceable[]): MoneyPair {
  const currency = displayCurrency()
  const total: MoneyPair = { usd: 0, eur: 0 }
  for (const item of items) {
    const value = itemValue(item, currency)
    if (value) (itemCurrency(item, currency) === 'EUR' ? (total.eur += value) : (total.usd += value))
  }
  return total
}

export function totalQty(items: { qty: number }[]): number {
  return items.reduce((sum, item) => sum + item.qty, 0)
}

export function valueByGame(items: (Priceable & { game: string })[]): Partial<Record<string, MoneyPair>> {
  const currency = displayCurrency()
  const totals: Partial<Record<string, MoneyPair>> = {}
  for (const item of items) {
    const pair = (totals[item.game] ??= { usd: 0, eur: 0 })
    const value = itemValue(item, currency)
    if (value) (itemCurrency(item, currency) === 'EUR' ? (pair.eur += value) : (pair.usd += value))
  }
  return totals
}

export interface CompRow {
  source: PriceEntry['source']
  finish: Finish
  currency: Currency
  market?: number
  low?: number
  mid?: number
  high?: number
  trend?: number
  avg30?: number
}

/** Pivot raw entries into one row per source+finish+currency for the table. */
export function groupComps(entries: PriceEntry[]): CompRow[] {
  const rows = new Map<string, CompRow>()
  for (const entry of entries) {
    const key = `${entry.source}|${entry.finish}|${entry.currency}`
    let row = rows.get(key)
    if (!row) {
      row = { source: entry.source, finish: entry.finish, currency: entry.currency }
      rows.set(key, row)
    }
    row[entry.kind] = entry.value
  }
  const sourceOrder: Record<string, number> = {
    tcgplayer: 0,
    cardmarket: 1,
    ebay: 2,
    amazon: 3,
    coolstuffinc: 4,
    cardhoarder: 5,
  }
  const finishOrder: Record<string, number> = {
    nonfoil: 0,
    holo: 1,
    reverse: 2,
    foil: 1,
    etched: 3,
    firstEd: 4,
  }
  return [...rows.values()].sort(
    (a, b) =>
      (finishOrder[a.finish] ?? 9) - (finishOrder[b.finish] ?? 9) ||
      (sourceOrder[a.source] ?? 9) - (sourceOrder[b.source] ?? 9) ||
      a.currency.localeCompare(b.currency),
  )
}

/** Rough marketplace fee share taken off a sale. */
export const FEE_PCT = 0.13

export function netProceeds(gross: number, opts: { feePct?: number; flat?: number } = {}): number {
  if (!Number.isFinite(gross) || gross <= 0) return 0
  const feePct = opts.feePct ?? FEE_PCT
  const flat = opts.flat ?? 0
  const net = gross * (1 - feePct) - flat
  return net > 0 ? Math.round(net * 100) / 100 : 0
}

/** Parse a human money string ("1.234,56", "$12.50") into a positive number. */
export function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,]/g, '')
  if (!/\d/.test(cleaned)) return null
  const lastDot = cleaned.lastIndexOf('.')
  const lastComma = cleaned.lastIndexOf(',')
  let normalized: string
  if (lastDot !== -1 && lastComma !== -1) {
    const decimalAt = Math.max(lastDot, lastComma)
    const decimal = cleaned[decimalAt]
    const thousands = decimal === '.' ? ',' : '.'
    normalized = cleaned.split(thousands).join('')
    normalized = decimal === ',' ? normalized.replace(',', '.') : normalized
  } else if (lastComma !== -1) {
    const commas = cleaned.split(',').length - 1
    const digitsAfter = cleaned.length - lastComma - 1
    normalized = commas === 1 && digitsAfter !== 3 ? cleaned.replace(',', '.') : cleaned.split(',').join('')
  } else if (lastDot !== -1 && cleaned.indexOf('.') !== lastDot) {
    normalized = cleaned.split('.').join('')
  } else {
    normalized = cleaned
  }
  const value = Number.parseFloat(normalized)
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null
}
