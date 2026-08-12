import { conditionFactor, itemCurrency, itemUnitPrice } from './prices'
import type { Card, CollectionItem, PricePoint } from './types'
import { ymd } from './util'

/**
 * Collection-value time series and movers, reconstructed from per-card price
 * history. USD-priced rows only — mixing currencies into one line would lie.
 */

const DAY_MS = 86_400_000

export function valueSeries(
  items: CollectionItem[],
  points: PricePoint[],
  days = 30,
  today = ymd(),
): { date: string; value: number }[] {
  const dates = dateRange(today, days)
  const usdItems = usdOnly(items)
  if (!dates.length || !usdItems.length) return []
  const byCard = groupPoints(points)
  const totals = new Array<number>(dates.length).fill(0)
  const seriesCache = new Map<string, number[]>()
  for (const item of usdItems) {
    if (item.qty <= 0) continue
    const premium = isPremium(item)
    const key = `${item.cardId}|${premium ? 'foil' : 'best'}`
    let series = seriesCache.get(key)
    if (!series) {
      series = sampleSeries(byCard.get(item.cardId) ?? [], dates, premium, fallbackPrice(item))
      seriesCache.set(key, series)
    }
    const weight = item.qty * conditionFactor(item.condition)
    for (let i = 0; i < dates.length; i++) totals[i] += series[i] * weight
  }
  return dates.map((date, i) => ({ date, value: round2(totals[i]) }))
}

export interface ValueWindow {
  series: { date: string; value: number }[]
  snapshots: number
  first: number
  last: number
  delta: number
  deltaPct: number
  /** Enough distinct data days to draw an honest line. */
  ready: boolean
}

export function valueWindow(items: CollectionItem[], points: PricePoint[], days = 30, today = ymd()): ValueWindow {
  const series = valueSeries(items, points, days, today)
  const snapshots = snapshotDays(items, points, days, today)
  const first = series[0]?.value ?? 0
  const last = series[series.length - 1]?.value ?? 0
  const delta = round2(last - first)
  return {
    series,
    snapshots,
    first,
    last,
    delta,
    deltaPct: first > 0 ? (delta / first) * 100 : 0,
    ready: series.length >= 2 && snapshots >= 2,
  }
}

export interface CostBasis {
  cost: number
  value: number
  profit: number
  profitPct: number
  /** Copies with cost data. */
  covered: number
  uncovered: number
}

export function costBasis(items: CollectionItem[]): CostBasis {
  let cost = 0
  let value = 0
  let covered = 0
  let uncovered = 0
  for (const item of items) {
    if (item.qty <= 0) continue
    const unit = itemUnitPrice(item)
    const usable = item.purchasePrice != null && item.purchasePrice > 0 && unit != null && itemCurrency(item) === 'USD'
    if (!usable) {
      uncovered += item.qty
      continue
    }
    covered += item.qty
    cost += item.purchasePrice! * item.qty
    value += unit! * item.qty
  }
  cost = round2(cost)
  value = round2(value)
  const profit = round2(value - cost)
  return { cost, value, profit, profitPct: cost > 0 ? (profit / cost) * 100 : 0, covered, uncovered }
}

export interface Mover {
  card: Card
  qty: number
  delta: number
  deltaPct: number
}

export function movers(
  items: CollectionItem[],
  points: PricePoint[],
  days = 30,
  today = ymd(),
): { gainers: Mover[]; losers: Mover[] } {
  const dates = dateRange(today, days)
  const usdItems = usdOnly(items)
  if (!dates.length || !usdItems.length) return { gainers: [], losers: [] }
  const first = dates[0]
  const last = dates[dates.length - 1]
  const byCard = groupPoints(points)
  const rows: Mover[] = []
  for (const [cardId, cardItems] of groupItems(usdItems)) {
    const window = (byCard.get(cardId) ?? []).filter((p) => p.date >= first && p.date <= last)
    if (window.length < 2) continue
    let delta = 0
    let base = 0
    let qty = 0
    let any = false
    for (const item of cardItems) {
      qty += item.qty
      const endpoints = seriesEndpoints(window, isPremium(item))
      if (!endpoints) continue
      any = true
      const weight = item.qty * conditionFactor(item.condition)
      delta += (endpoints.last - endpoints.first) * weight
      base += endpoints.first * weight
    }
    if (!any || delta === 0) continue
    rows.push({
      card: cardItems[0].card,
      qty,
      delta: round2(delta),
      deltaPct: base > 0 ? (delta / base) * 100 : 0,
    })
  }
  const order = (a: Mover, b: Mover) =>
    Math.abs(b.delta) - Math.abs(a.delta) || Math.abs(b.deltaPct) - Math.abs(a.deltaPct) || a.card.name.localeCompare(b.card.name)
  return {
    gainers: rows.filter((r) => r.delta > 0).sort(order),
    losers: rows.filter((r) => r.delta < 0).sort(order),
  }
}

/** How many distinct days in the window have a price snapshot for owned cards. */
function snapshotDays(items: CollectionItem[], points: PricePoint[], days: number, today: string): number {
  const dates = dateRange(today, days)
  if (!dates.length || !items.length) return 0
  const first = dates[0]
  const last = dates[dates.length - 1]
  const owned = new Set(
    usdOnly(items)
      .filter((item) => item.qty > 0)
      .map((item) => item.cardId),
  )
  const seen = new Set<string>()
  for (const point of points) {
    if (!owned.has(point.cardId) || point.date < first || point.date > last) continue
    if (!isUsdPoint(point)) continue
    if (positive(point.best) == null && positive(point.foil) == null) continue
    seen.add(point.date)
  }
  return seen.size
}

function dateRange(today: string, days: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`)
  if (!Number.isFinite(end) || days < 1) return []
  const dates: string[] = []
  for (let back = days - 1; back >= 0; back--) dates.push(new Date(end - back * DAY_MS).toISOString().slice(0, 10))
  return dates
}

function groupPoints(points: PricePoint[]): Map<string, PricePoint[]> {
  const map = new Map<string, PricePoint[]>()
  for (const point of points) {
    const list = map.get(point.cardId)
    if (list) list.push(point)
    else map.set(point.cardId, [point])
  }
  for (const list of map.values()) list.sort((a, b) => a.date.localeCompare(b.date))
  return map
}

function groupItems(items: CollectionItem[]): Map<string, CollectionItem[]> {
  const map = new Map<string, CollectionItem[]>()
  for (const item of items) {
    if (item.qty <= 0) continue
    const list = map.get(item.cardId)
    if (list) list.push(item)
    else map.set(item.cardId, [item])
  }
  return map
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null
}

function usdOnly(items: CollectionItem[]): CollectionItem[] {
  return items.filter((item) => itemCurrency(item) === 'USD')
}

function isPremium(item: CollectionItem): boolean {
  return item.finish !== 'nonfoil'
}

function isUsdPoint(point: PricePoint): boolean {
  return (point.currency ?? 'USD') === 'USD'
}

function pointValue(point: PricePoint, premium: boolean): number | null {
  if (!isUsdPoint(point)) return null
  return premium ? (positive(point.foil) ?? positive(point.best)) : positive(point.best)
}

function fallbackPrice(item: CollectionItem): number {
  const { best, bestFoil } = item.card.prices
  return (isPremium(item) ? (positive(bestFoil) ?? positive(best)) : positive(best)) ?? 0
}

/** Step-interpolate a card's history onto the window's dates. */
function sampleSeries(points: PricePoint[], dates: string[], premium: boolean, fallback: number): number[] {
  const usable: { date: string; value: number }[] = []
  for (const point of points) {
    const value = pointValue(point, premium)
    if (value != null) usable.push({ date: point.date, value })
  }
  if (!usable.length) return new Array(dates.length).fill(fallback)
  let current = usable[0].value
  let cursor = 0
  const series: number[] = []
  for (const date of dates) {
    while (cursor < usable.length && usable[cursor].date <= date) current = usable[cursor++].value
    series.push(current)
  }
  return series
}

function seriesEndpoints(points: PricePoint[], premium: boolean): { first: number; last: number } | null {
  let first: number | null = null
  let last: number | null = null
  let count = 0
  for (const point of points) {
    const value = pointValue(point, premium)
    if (value != null) {
      if (first == null) first = value
      last = value
      count++
    }
  }
  return count >= 2 && first != null && last != null ? { first, last } : null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 30-day trend for one card's sheet header. */
export function cardTrend(points: PricePoint[]): { abs: number; days: number } | null {
  const priced = points.filter((p) => p.best != null)
  if (priced.length < 2) return null
  const cutoff = ymd(Date.now() - 30 * DAY_MS)
  const recent = priced.filter((p) => p.date >= cutoff)
  const window = recent.length >= 2 ? recent : priced
  const first = window[0]
  const last = window[window.length - 1]
  const abs = last.best! - first.best!
  if (Math.abs(abs) < 0.005) return null
  const days = Math.max(1, Math.round((Date.parse(last.date) - Date.parse(first.date)) / DAY_MS))
  return { abs, days }
}
