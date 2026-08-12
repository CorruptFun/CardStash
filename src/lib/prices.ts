import type {
  Card,
  Condition,
  Finish,
  PriceEntry,
  Prices,
} from './types'

/** Rows that price like a collection item, without needing a full item. */
export interface Priceable {
  finish: Finish
  condition: Condition
  qty: number
  /** Sealed products: true once cracked — the sealed market price no longer applies. */
  opened?: boolean
  card: Card
}

/**
 * The app prices in USD only. Cards stored by older versions still carry EUR
 * (Cardmarket) entries in IndexedDB, so every picker filters them out — a
 * legacy €-value must never surface labeled as dollars.
 */
function usdOnly(entries: PriceEntry[]): PriceEntry[] {
  return entries.filter((e) => (e.currency ?? 'USD') !== 'EUR')
}

/** Pick the most trustworthy USD entry among `finishes`. */
export function pickEntry(entries: PriceEntry[], finishes: Finish[]): PriceEntry | null {
  const pool = usdOnly(entries).filter((e) => finishes.includes(e.finish) && e.value > 0)
  if (!pool.length) return null
  const find = (fn: (e: PriceEntry) => boolean) => pool.find(fn) ?? null
  return (
    find((e) => e.source === 'tcgplayer' && e.kind === 'market') ??
    find((e) => e.kind === 'market') ??
    find((e) => e.kind !== 'high') ??
    find(() => true)
  )
}

export function pickValue(entries: PriceEntry[], finishes: Finish[]): number | null {
  return pickEntry(entries, finishes)?.value ?? null
}

const PLAIN: Finish[] = ['nonfoil']
const PREMIUM: Finish[] = ['foil', 'holo', 'etched', 'firstEd', 'reverse']

export function bestEntry(prices: Prices, kind: 'best' | 'foil' = 'best'): PriceEntry | null {
  const premium = pickEntry(prices.entries, PREMIUM)
  if (kind === 'foil') return premium
  return pickEntry(prices.entries, PLAIN) ?? premium
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
export function itemUnitPrice(item: Priceable): number | null {
  const raw = itemRawUnitPrice(item)
  if (raw == null) return null
  const factor = conditionFactor(item.condition)
  return factor === 1 ? raw : Math.round(raw * factor * 100) / 100
}

function itemRawUnitPrice(item: Priceable): number | null {
  // An opened box/pack isn't the sealed product anymore — its pulls get
  // scanned in as singles, so the row itself stops counting.
  if (item.opened) return null
  const { prices } = item.card
  // Recomputed from entries (not the stored headline) so a legacy EUR-only
  // card reads as unpriced instead of showing its euro figure as dollars.
  const value =
    item.finish === 'nonfoil'
      ? (pickValue(prices.entries, PLAIN) ?? pickValue(prices.entries, PREMIUM))
      : (pickValue(prices.entries, [item.finish]) ??
        pickValue(prices.entries, PREMIUM) ??
        pickValue(prices.entries, PLAIN))
  if (value != null) return value
  // Entry-less card objects (hand-rolled imports): trust the stored headline.
  if (!prices.entries.length) return item.finish === 'nonfoil' ? prices.best : (prices.bestFoil ?? prices.best)
  return null
}

export function itemValue(item: Priceable): number {
  return (itemUnitPrice(item) ?? 0) * item.qty
}

export function collectionValue(items: Priceable[]): number {
  let total = 0
  for (const item of items) total += itemValue(item)
  return total
}

export function totalQty(items: { qty: number }[]): number {
  return items.reduce((sum, item) => sum + item.qty, 0)
}

export function valueByGame(items: (Priceable & { game: string })[]): Partial<Record<string, number>> {
  const totals: Partial<Record<string, number>> = {}
  for (const item of items) {
    totals[item.game] = (totals[item.game] ?? 0) + itemValue(item)
  }
  return totals
}

export interface CompRow {
  source: PriceEntry['source']
  finish: Finish
  market?: number
  low?: number
  mid?: number
  high?: number
  trend?: number
  avg30?: number
}

/** Pivot USD entries into one row per source+finish for the comps table. */
export function groupComps(entries: PriceEntry[]): CompRow[] {
  const rows = new Map<string, CompRow>()
  for (const entry of usdOnly(entries)) {
    const key = `${entry.source}|${entry.finish}`
    let row = rows.get(key)
    if (!row) {
      row = { source: entry.source, finish: entry.finish }
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
      (sourceOrder[a.source] ?? 9) - (sourceOrder[b.source] ?? 9),
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
