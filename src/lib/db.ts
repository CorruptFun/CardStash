import Dexie, { type Table } from 'dexie'
import { GAMES, FINISH_LABEL } from './games'
import { ygoPrintingVariants } from './ygo'
import type {
  Card,
  CatalogCache,
  CollectionItem,
  KvCacheRow,
  Condition,
  Deck,
  DeckBoard,
  DeckCard,
  Finish,
  Game,
  PricePoint,
  ScanRecord,
} from './types'
import { CONDITIONS } from './games'
import { uid, ymd } from './util'

class CardstockDB extends Dexie {
  collection!: Table<CollectionItem, string>
  decks!: Table<Deck, string>
  deckCards!: Table<DeckCard, string>
  history!: Table<PricePoint, [string, string]>
  scans!: Table<ScanRecord, string>
  catalogs!: Table<CatalogCache, Game>
  cache!: Table<KvCacheRow, string>

  constructor() {
    super('cardstock')
    this.version(1).stores({
      collection: 'id, cardId, game, name, addedAt',
      decks: 'id, game, updatedAt',
      deckCards: 'id, deckId, cardId, [deckId+cardId+board]',
      history: '[cardId+date], cardId',
      scans: 'id, at',
    })
    this.version(2)
      .stores({ history: '[cardId+date], cardId, date' })
      .upgrade(async (tx) => {
        await tx
          .table('history')
          .toCollection()
          .modify((point: PricePoint) => {
            if (point.currency == null) point.currency = 'USD'
          })
      })
    // v3: day-cached TCGplayer catalogs (Riftbound & co. have no search API).
    this.version(3).stores({ catalogs: 'game' })
    // v4: small keyed caches (TCGplayer group lists for sealed products).
    this.version(4).stores({ cache: 'key' })
  }
}

export const db = new CardstockDB()

export async function requestPersistence(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** Quantity-weighted average of two cost bases; null-tolerant. */
function averagePrice(a: number | undefined, aQty: number, b: number | undefined, bQty: number): number | undefined {
  if (a == null) return b
  if (b == null) return a
  const total = aQty + bQty
  return total <= 0 ? a : (a * aQty + b * bQty) / total
}

export interface AddOptions {
  finish?: Finish
  condition?: Condition
  qty?: number
  purchasePrice?: number
  note?: string
  /** Sealed products: false = still sealed (the default when card.sealed). */
  opened?: boolean
}

/** Same printing = same set + collector number (YGO reprints share one card id). */
function samePrinting(a: { setCode?: string; number?: string }, b: { setCode?: string; number?: string }): boolean {
  return (a.setCode ?? '') === (b.setCode ?? '') && (a.number ?? '') === (b.number ?? '')
}

/** Sealed and opened copies of the same product must never merge. */
function sameOpened(a: { opened?: boolean }, b: { opened?: boolean }): boolean {
  return (a.opened ?? false) === (b.opened ?? false)
}

/** Add copies to the collection, merging into an existing printing+finish+condition row. */
export async function addToCollection(card: Card, opts: AddOptions = {}): Promise<CollectionItem> {
  const finish = opts.finish ?? 'nonfoil'
  const condition = opts.condition ?? 'NM'
  const qty = opts.qty ?? 1
  const opened = card.sealed ? (opts.opened ?? false) : undefined
  return db.transaction('rw', db.collection, async () => {
    const existing = await db.collection
      .where('cardId')
      .equals(card.id)
      .and(
        (item) =>
          item.finish === finish && item.condition === condition && samePrinting(item, card) && sameOpened(item, { opened }),
      )
      .first()
    if (existing) {
      const purchasePrice =
        opts.purchasePrice != null
          ? averagePrice(existing.purchasePrice, existing.qty, opts.purchasePrice, qty)
          : existing.purchasePrice
      const merged: CollectionItem = { ...existing, qty: existing.qty + qty, purchasePrice, card }
      await db.collection.put(merged)
      return merged
    }
    const item: CollectionItem = {
      id: uid(),
      cardId: card.id,
      game: card.game,
      name: card.name,
      setCode: card.setCode,
      setName: card.setName,
      number: card.number,
      rarity: card.rarity,
      finish,
      condition,
      qty,
      opened,
      purchasePrice: opts.purchasePrice,
      note: opts.note,
      addedAt: Date.now(),
      card,
    }
    await db.collection.add(item)
    return item
  })
}

export async function setItemQty(id: string, qty: number): Promise<void> {
  if (qty <= 0) await db.collection.delete(id)
  else await db.collection.update(id, { qty })
}

export async function removeCopies(id: string, count: number): Promise<void> {
  await db.transaction('rw', db.collection, async () => {
    const item = await db.collection.get(id)
    if (!item) return
    const left = item.qty - count
    if (left <= 0) await db.collection.delete(id)
    else await db.collection.update(id, { qty: left })
  })
}

/**
 * Edit a row's finish/condition/price/note. If the edit collides with another
 * row of the same card+finish+condition, the two merge (quantities add).
 * Returns the surviving row, or null if the row vanished mid-edit.
 */
export async function updateItem(
  id: string,
  patch: Partial<Pick<CollectionItem, 'finish' | 'condition' | 'opened' | 'purchasePrice' | 'note' | 'card'>>,
): Promise<CollectionItem | null> {
  return db.transaction('rw', db.collection, async () => {
    const item = await db.collection.get(id)
    if (!item) return null
    const edited: CollectionItem = { ...item, ...patch }
    const collision = await db.collection
      .where('cardId')
      .equals(item.cardId)
      .and(
        (other) =>
          other.id !== id &&
          other.finish === edited.finish &&
          other.condition === edited.condition &&
          samePrinting(other, edited) &&
          sameOpened(other, edited),
      )
      .first()
    if (!collision) {
      await db.collection.put(edited)
      return edited
    }
    const merged: CollectionItem = {
      ...collision,
      qty: collision.qty + edited.qty,
      purchasePrice: averagePrice(collision.purchasePrice, collision.qty, edited.purchasePrice, edited.qty),
      note: edited.note ?? collision.note,
      card: edited.card ?? collision.card,
    }
    await db.collection.put(merged)
    await db.collection.delete(id)
    return merged
  })
}

export async function removeItems(ids: string[]): Promise<void> {
  await db.collection.bulkDelete(ids)
}

/* Small keyed cache (TCGplayer group lists etc.). Best-effort: quota noise
 * must never break a lookup, so failures read as cache misses. */

export async function kvGet<T>(key: string, maxAgeMs: number): Promise<T | null> {
  try {
    const row = await db.cache.get(key)
    if (!row || Date.now() - row.at > maxAgeMs) return null
    return row.data as T
  } catch {
    return null
  }
}

export async function kvPut(key: string, data: unknown): Promise<void> {
  try {
    await db.cache.put({ key, at: Date.now(), data })
  } catch {
    /* cache only */
  }
}

/** name(lowercased) → total owned copies, for one game. */
export async function ownedNameCounts(game: Game): Promise<Map<string, number>> {
  const items = await db.collection.where('game').equals(game).toArray()
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = item.name.toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + item.qty)
  }
  return counts
}

/** Record today's price for a card (skips cards with no price at all). */
export async function recordPricePoint(card: Card): Promise<void> {
  if (card.prices.best == null && card.prices.bestFoil == null) return
  await db.history.put({
    cardId: card.id,
    date: ymd(),
    best: card.prices.best,
    foil: card.prices.bestFoil,
    currency: 'USD',
  })
}

/** A card's history, oldest first. Legacy EUR points are left out — one line, one currency. */
export async function priceHistory(cardId: string): Promise<PricePoint[]> {
  const points = await db.history.where('cardId').equals(cardId).toArray()
  return points.filter((p) => (p.currency ?? 'USD') === 'USD').sort((a, b) => a.date.localeCompare(b.date))
}

export async function historySince(date: string): Promise<PricePoint[]> {
  return db.history.where('date').aboveOrEqual(date).toArray()
}

export async function pruneHistory(keepDays = 400): Promise<number> {
  const cutoff = ymd(Date.now() - keepDays * 86_400_000)
  return db.history.where('date').below(cutoff).delete()
}

/**
 * Reshape a freshly fetched card to a row's chosen printing. Games where a
 * printing is its own api id always match; YGO rows re-pick their set variant
 * so a refresh doesn't revert them to the default printing.
 */
function cardForItem(card: Card, item: CollectionItem): Card {
  if (samePrinting(item, card)) return card
  const variant = card.printings?.length ? ygoPrintingVariants(card).find((v) => samePrinting(item, v)) : undefined
  return (
    variant ?? {
      ...card,
      setCode: item.setCode,
      setName: item.setName ?? card.setName,
      number: item.number,
      rarity: item.rarity ?? card.rarity,
    }
  )
}

/** Push a freshly fetched card into every collection/deck row that shows it. */
export async function applyCardUpdate(card: Card): Promise<void> {
  await db.transaction('rw', db.collection, db.deckCards, async () => {
    const items = await db.collection.where('cardId').equals(card.id).toArray()
    for (const item of items) await db.collection.update(item.id, { card: cardForItem(card, item), name: card.name })
    const deckRows = await db.deckCards.where('cardId').equals(card.id).toArray()
    for (const row of deckRows) await db.deckCards.update(row.id, { card })
  })
  await recordPricePoint(card)
}

const SCAN_TRAY_LIMIT = 30

export async function recordScan(card: Card): Promise<void> {
  // Re-scanning the card already at the head of the tray refreshes that row
  // instead of stacking a duplicate tile.
  const latest = await db.scans.orderBy('at').last()
  if (latest?.cardId === card.id) {
    await db.scans.update(latest.id, { at: Date.now(), card })
  } else {
    await db.scans.add({ id: uid(), cardId: card.id, at: Date.now(), card })
    const count = await db.scans.count()
    if (count > SCAN_TRAY_LIMIT) {
      const stale = await db.scans
        .orderBy('at')
        .limit(count - SCAN_TRAY_LIMIT)
        .toArray()
      await db.scans.bulkDelete(stale.map((scan) => scan.id))
    }
  }
  await recordPricePoint(card)
}

export async function createDeck(game: Game, name: string, format?: string): Promise<Deck> {
  const deck: Deck = {
    id: uid(),
    game,
    name,
    format,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await db.decks.add(deck)
  return deck
}

export async function updateDeck(
  id: string,
  patch: Partial<Pick<Deck, 'name' | 'format' | 'coverCardId'>> = {},
): Promise<void> {
  await db.decks.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteDeck(id: string): Promise<void> {
  await db.transaction('rw', db.decks, db.deckCards, async () => {
    await db.deckCards.where('deckId').equals(id).delete()
    await db.decks.delete(id)
  })
}

export async function addCardToDeck(deckId: string, card: Card, qty = 1, board: DeckBoard = 'main'): Promise<void> {
  await db.transaction('rw', db.deckCards, db.decks, async () => {
    const existing = await db.deckCards.where('[deckId+cardId+board]').equals([deckId, card.id, board]).first()
    if (existing) await db.deckCards.update(existing.id, { qty: existing.qty + qty, card })
    else await db.deckCards.add({ id: uid(), deckId, cardId: card.id, qty, board, card })
    await db.decks.update(deckId, { updatedAt: Date.now() })
  })
}

export async function setDeckCardQty(id: string, qty: number): Promise<void> {
  if (qty <= 0) await db.deckCards.delete(id)
  else await db.deckCards.update(id, { qty })
}

export interface Backup {
  app: 'cardstock'
  version: 1
  exportedAt: string
  collection: CollectionItem[]
  decks: Deck[]
  deckCards: DeckCard[]
  history: PricePoint[]
}

export async function exportBackup(): Promise<Backup> {
  return {
    app: 'cardstock',
    version: 1,
    exportedAt: new Date().toISOString(),
    collection: await db.collection.toArray(),
    decks: await db.decks.toArray(),
    deckCards: await db.deckCards.toArray(),
    history: await db.history.toArray(),
  }
}

const NOT_A_BACKUP = 'Not a Cardstock backup file'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown, required = false): unknown[] {
  if (value == null) {
    if (required) throw new Error(NOT_A_BACKUP)
    return []
  }
  if (!Array.isArray(value)) throw new Error(NOT_A_BACKUP)
  return value
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined
}

function asPositive(value: unknown): number | undefined {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : undefined
}

/** Validate + coerce an untrusted backup document into a clean Backup. */
export function sanitizeBackup(raw: unknown): Backup {
  if (!isRecord(raw)) throw new Error(NOT_A_BACKUP)
  if (raw.app !== 'cardstock' && raw.app !== 'loupe') throw new Error(NOT_A_BACKUP)

  const collection: CollectionItem[] = []
  for (const entry of asArray(raw.collection, true)) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    const cardId = asString(entry.cardId)
    const card = entry.card
    if (!id || !cardId || !isRecord(card)) continue
    const qty = Number(entry.qty)
    const addedAt = Number(entry.addedAt)
    const game = GAMES.includes(entry.game as Game) ? (entry.game as Game) : ((card.game as Game) ?? 'mtg')
    collection.push({
      ...(entry as object),
      id,
      cardId,
      game,
      name: asString(entry.name) ?? asString(card.name) ?? 'Unknown card',
      finish: typeof entry.finish === 'string' && entry.finish in FINISH_LABEL ? (entry.finish as Finish) : 'nonfoil',
      condition: CONDITIONS.includes(entry.condition as Condition) ? (entry.condition as Condition) : 'NM',
      qty: Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 0,
      opened: typeof entry.opened === 'boolean' ? entry.opened : undefined,
      purchasePrice: asPositive(entry.purchasePrice),
      addedAt: Number.isFinite(addedAt) && addedAt > 0 ? addedAt : Date.now(),
      card: card as unknown as Card,
    })
  }

  const decks: Deck[] = []
  for (const entry of asArray(raw.decks)) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    if (!id) continue
    decks.push({
      ...(entry as object),
      id,
      game: GAMES.includes(entry.game as Game) ? (entry.game as Game) : 'mtg',
      name: asString(entry.name) ?? 'Untitled deck',
    } as Deck)
  }

  const deckCards: DeckCard[] = []
  for (const entry of asArray(raw.deckCards)) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    const deckId = asString(entry.deckId)
    const cardId = asString(entry.cardId)
    if (!id || !deckId || !cardId || !isRecord(entry.card)) continue
    const qty = Number(entry.qty)
    deckCards.push({
      ...(entry as object),
      id,
      deckId,
      cardId,
      board: entry.board === 'side' || entry.board === 'extra' ? entry.board : 'main',
      qty: Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 0,
      card: entry.card as unknown as Card,
    })
  }

  const history: PricePoint[] = []
  for (const entry of asArray(raw.history)) {
    if (!isRecord(entry)) continue
    const cardId = asString(entry.cardId)
    const date = asString(entry.date)
    if (!cardId || !date) continue
    const point: PricePoint = {
      cardId,
      date,
      best: asPositive(entry.best) ?? null,
      foil: asPositive(entry.foil) ?? null,
    }
    if (entry.currency === 'USD' || entry.currency === 'EUR') point.currency = entry.currency
    history.push(point)
  }

  return {
    app: 'cardstock',
    version: 1,
    exportedAt: asString(raw.exportedAt) ?? new Date().toISOString(),
    collection,
    decks,
    deckCards,
    history,
  }
}

export async function importBackup(raw: unknown): Promise<void> {
  const backup = sanitizeBackup(raw)
  await db.transaction('rw', db.collection, db.decks, db.deckCards, db.history, async () => {
    await db.collection.bulkPut(backup.collection)
    await db.decks.bulkPut(backup.decks)
    await db.deckCards.bulkPut(backup.deckCards)
    await db.history.bulkPut(backup.history)
  })
}

export async function clearAllData(): Promise<void> {
  await db.transaction('rw', [db.collection, db.decks, db.deckCards, db.history, db.scans, db.catalogs], async () => {
    await Promise.all([
      db.collection.clear(),
      db.decks.clear(),
      db.deckCards.clear(),
      db.history.clear(),
      db.scans.clear(),
      db.catalogs.clear(),
    ])
  })
}
