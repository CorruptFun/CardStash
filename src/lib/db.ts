import Dexie, { type Table } from 'dexie'
import { sanitizeGrade } from './slab'
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
  Friend,
  Game,
  GradeInfo,
  PricePoint,
  ProfilePayload,
  ReplyPayload,
  ScanRecord,
  Tombstone,
  TradeRecord,
  TradeStatus,
  WantRow,
} from './types'
import { CONDITIONS } from './games'
import {
  cardToWantRow,
  friendFromProfile,
  sanitizeFriendRecord,
  sanitizeTradeRecord,
  sanitizeWantRecord,
  sharedCardToCard,
} from './social'
import { uid, ymd } from './util'

class CardstockDB extends Dexie {
  collection!: Table<CollectionItem, string>
  decks!: Table<Deck, string>
  deckCards!: Table<DeckCard, string>
  history!: Table<PricePoint, [string, string]>
  scans!: Table<ScanRecord, string>
  catalogs!: Table<CatalogCache, Game>
  cache!: Table<KvCacheRow, string>
  friends!: Table<Friend, string>
  trades!: Table<TradeRecord, string>
  wants!: Table<WantRow, string>
  tombstones!: Table<Tombstone, string>

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
    // v5: social — followed friends (imported binder snapshots) and trades.
    this.version(5).stores({
      friends: 'id, addedAt',
      trades: 'id, friendId, status, createdAt',
    })
    // v6: want list (card-level, keyed by game+normalized name).
    this.version(6).stores({ wants: 'key, game, addedAt' })
    /**
     * v7: the two things a future merge cannot be built without — when a row
     * last changed, and the fact that a row was deleted rather than never
     * existing.
     *
     * This lands well before hosted sync (docs/roadmap.md round 3) on purpose.
     * `updatedAt` backfills from `addedAt` here, which is a sane lower bound —
     * but every edit made between today and the day sync ships is an edit a
     * three-way merge cannot see, so the window is worth closing early rather
     * than cheaply.
     *
     * Tombstones exist because absence is ambiguous. Without them a device
     * that deleted a row and a device that never had it look identical, and a
     * union merge — which is what first-sync must be, see the first-sync
     * footgun in the roadmap — silently resurrects everything the user threw
     * away.
     */
    this.version(7)
      .stores({
        collection: 'id, cardId, game, name, addedAt, updatedAt',
        tombstones: 'id, at',
      })
      .upgrade(async (tx) => {
        await tx
          .table('collection')
          .toCollection()
          .modify((item: CollectionItem) => {
            if (item.updatedAt == null) item.updatedAt = item.addedAt
          })
      })

    /**
     * Stamped by hook rather than at the ~14 call sites that write collection
     * rows. A hook cannot be forgotten by the next write path somebody adds,
     * which is the entire difference between a seam and a game of whack-a-mole.
     * Both hooks are same-table, so they never widen a transaction's scope.
     */
    this.collection.hook('creating', (_id, item) => {
      const row = item as CollectionItem
      if (row.updatedAt == null) row.updatedAt = row.addedAt ?? Date.now()
    })
    this.collection.hook('updating', (mods) => {
      // A no-op update shouldn't bump the clock — it would make an untouched
      // row look newer than the device that genuinely changed it.
      if (!mods || typeof mods !== 'object' || !Object.keys(mods).length) return
      if ('updatedAt' in (mods as Record<string, unknown>)) return
      return { updatedAt: Date.now() }
    })
  }
}

/**
 * Record that rows were deliberately deleted. Callers pass the ids they just
 * removed, inside the same transaction, so a rolled-back delete cannot leave a
 * tombstone claiming otherwise.
 *
 * Deliberately NOT written by `clearAllData()`: "erase everything on this
 * device" is a local act, and turning it into 8,000 tombstones would make the
 * next sync delete the user's collection everywhere else too. Erasing a device
 * must never be a remote-wipe button nobody asked for.
 */
export async function tombstone(ids: string[]): Promise<void> {
  if (!ids.length) return
  const at = Date.now()
  await db.tombstones.bulkPut(ids.map((id) => ({ id, at })))
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
  /** Copies of the new row offered for trade. */
  forTrade?: number
  /** Slab details when the copy being added is graded. */
  grade?: GradeInfo
  /** Collector-set value per copy, USD. */
  marketValue?: number
}

/** Normalize a for-trade count against a row's qty (0 stores as absent). */
function tradeCount(forTrade: number | undefined, qty: number): number | undefined {
  const clamped = Math.max(0, Math.min(qty, Math.floor(forTrade ?? 0)))
  return clamped > 0 ? clamped : undefined
}

/** Same printing = same set + collector number (YGO reprints share one card id). */
function samePrinting(a: { setCode?: string; number?: string }, b: { setCode?: string; number?: string }): boolean {
  return (a.setCode ?? '') === (b.setCode ?? '') && (a.number ?? '') === (b.number ?? '')
}

/**
 * Graded copies never merge into the raw row, or into a differently graded
 * one. A PSA 10 and a raw NM are the same printing but not the same holding:
 * different value, different thing to trade. The cert is deliberately NOT
 * part of this — two PSA 10s of the same card are interchangeable, and a row
 * per cert would fragment the collection for no gain.
 */
function sameGrade(a: { grade?: GradeInfo }, b: { grade?: GradeInfo }): boolean {
  if (!a.grade && !b.grade) return true
  if (!a.grade || !b.grade) return false
  return a.grade.company === b.grade.company && a.grade.grade === b.grade.grade && a.grade.qualifier === b.grade.qualifier
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
          item.finish === finish &&
          item.condition === condition &&
          samePrinting(item, card) &&
          sameOpened(item, { opened }) &&
          sameGrade(item, { grade: opts.grade }),
      )
      .first()
    if (existing) {
      const purchasePrice =
        opts.purchasePrice != null
          ? averagePrice(existing.purchasePrice, existing.qty, opts.purchasePrice, qty)
          : existing.purchasePrice
      const merged: CollectionItem = {
        ...existing,
        qty: existing.qty + qty,
        forTrade: tradeCount((existing.forTrade ?? 0) + (opts.forTrade ?? 0), existing.qty + qty),
        purchasePrice,
        card,
      }
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
      forTrade: tradeCount(opts.forTrade, qty),
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
  if (qty <= 0) {
    await db.transaction('rw', [db.collection, db.tombstones], async () => {
      await db.collection.delete(id)
      await tombstone([id])
    })
    return
  }
  await db.transaction('rw', db.collection, async () => {
    const item = await db.collection.get(id)
    if (!item) return
    await db.collection.update(id, { qty, forTrade: tradeCount(item.forTrade, qty) })
  })
}

/** Set how many copies of a row are up for trade (clamped to its qty). */
export async function setItemForTrade(id: string, forTrade: number): Promise<void> {
  await db.transaction('rw', db.collection, async () => {
    const item = await db.collection.get(id)
    if (!item) return
    await db.collection.update(id, { forTrade: tradeCount(forTrade, item.qty) })
  })
}

export async function removeCopies(id: string, count: number): Promise<void> {
  await db.transaction('rw', [db.collection, db.tombstones], async () => {
    const item = await db.collection.get(id)
    if (!item) return
    const left = item.qty - count
    if (left <= 0) {
      await db.collection.delete(id)
      await tombstone([id])
    } else await db.collection.update(id, { qty: left, forTrade: tradeCount(item.forTrade, left) })
  })
}

/**
 * Edit a row's finish/condition/price/note. If the edit collides with another
 * row of the same card+finish+condition, the two merge (quantities add).
 * Returns the surviving row, or null if the row vanished mid-edit.
 */
export async function updateItem(
  id: string,
  patch: Partial<
    Pick<
      CollectionItem,
      'finish' | 'condition' | 'opened' | 'purchasePrice' | 'note' | 'card' | 'forTrade' | 'grade' | 'marketValue'
    >
  >,
): Promise<CollectionItem | null> {
  return db.transaction('rw', [db.collection, db.tombstones], async () => {
    const item = await db.collection.get(id)
    if (!item) return null
    const edited: CollectionItem = { ...item, ...patch }
    edited.forTrade = tradeCount(edited.forTrade, edited.qty)
    const collision = await db.collection
      .where('cardId')
      .equals(item.cardId)
      .and(
        (other) =>
          other.id !== id &&
          other.finish === edited.finish &&
          other.condition === edited.condition &&
          samePrinting(other, edited) &&
          sameOpened(other, edited) &&
          sameGrade(other, edited),
      )
      .first()
    if (!collision) {
      await db.collection.put(edited)
      return edited
    }
    const merged: CollectionItem = {
      ...collision,
      qty: collision.qty + edited.qty,
      forTrade: tradeCount((collision.forTrade ?? 0) + (edited.forTrade ?? 0), collision.qty + edited.qty),
      purchasePrice: averagePrice(collision.purchasePrice, collision.qty, edited.purchasePrice, edited.qty),
      note: edited.note ?? collision.note,
      card: edited.card ?? collision.card,
    }
    await db.collection.put(merged)
    await db.collection.delete(id)
    // A row absorbed into another is genuinely gone from this device, so it
    // tombstones like any other delete — otherwise a merge re-creates it and
    // the user's quantities double.
    await tombstone([id])
    return merged
  })
}

export async function removeItems(ids: string[]): Promise<void> {
  await db.transaction('rw', [db.collection, db.tombstones], async () => {
    await db.collection.bulkDelete(ids)
    await tombstone(ids)
  })
}

/* --- friends & trades (social) ------------------------------------------- */

/** Import/refresh a friend from a profile snapshot; keeps addedAt + sourceUrl. */
export async function upsertFriendFromProfile(
  payload: ProfilePayload,
  sourceUrl?: string,
  remoteRev?: number,
): Promise<{ friend: Friend; created: boolean }> {
  return db.transaction('rw', db.friends, async () => {
    const existing = await db.friends.get(payload.id)
    const friend = friendFromProfile(payload, existing, sourceUrl, remoteRev)
    await db.friends.put(friend)
    return { friend, created: !existing }
  })
}

export async function removeFriend(id: string): Promise<void> {
  // Trades keep their own copy of the name/cards, so they survive the friend.
  await db.friends.delete(id)
}

/** Add/remove a card from the want list. Returns the new state. */
export async function toggleWant(card: Card): Promise<boolean> {
  const row = cardToWantRow(card)
  return db.transaction('rw', db.wants, async () => {
    const existing = await db.wants.get(row.key)
    if (existing) {
      await db.wants.delete(row.key)
      return false
    }
    await db.wants.add(row)
    return true
  })
}

export async function saveTrade(trade: TradeRecord): Promise<void> {
  await db.trades.put(trade)
}

/** Store an incoming proposal; a copy that was already answered stays put. */
export async function recordIncomingTrade(trade: TradeRecord): Promise<'saved' | 'kept'> {
  return db.transaction('rw', db.trades, async () => {
    const existing = await db.trades.get(trade.id)
    if (existing && existing.status !== 'proposed') return 'kept'
    await db.trades.put(existing ? { ...trade, createdAt: existing.createdAt } : trade)
    return 'saved'
  })
}

export async function setTradeStatus(id: string, status: TradeStatus): Promise<TradeRecord | null> {
  return db.transaction('rw', db.trades, async () => {
    const trade = await db.trades.get(id)
    if (!trade) return null
    const next: TradeRecord = { ...trade, status, updatedAt: Date.now() }
    await db.trades.put(next)
    return next
  })
}

export async function deleteTrade(id: string): Promise<void> {
  await db.trades.delete(id)
}

/** Apply a reply link; null when no matching trade exists on this device. */
export async function applyTradeReply(reply: ReplyPayload): Promise<TradeRecord | null> {
  return db.transaction('rw', db.trades, async () => {
    const trade = await db.trades.get(reply.id)
    if (!trade) return null
    // A settled trade doesn't reopen because a stale link got tapped twice.
    if (trade.status === 'completed' || trade.status === 'canceled') return trade
    const next: TradeRecord = { ...trade, status: reply.status, updatedAt: Date.now() }
    await db.trades.put(next)
    return next
  })
}

export interface TradeApplyResult {
  added: number
  removed: number
  /** Given copies the collection no longer held (left untouched, not blocked on). */
  short: number
}

/**
 * Book a settled trade into the collection: given copies leave (matching
 * rows decremented — exact printing and for-trade rows first), received
 * copies arrive as normal rows. The trade flips to completed.
 */
export async function applyTradeToCollection(trade: TradeRecord): Promise<TradeApplyResult> {
  const result: TradeApplyResult = { added: 0, removed: 0, short: 0 }
  await db.transaction('rw', db.collection, db.trades, db.tombstones, async () => {
    for (const row of trade.give) {
      let left = row.qty
      const candidates = (await db.collection.where('cardId').equals(row.cardId).toArray())
        .filter((item) => item.finish === row.finish && item.condition === row.condition)
        .sort(
          (a, b) =>
            Number(samePrinting(b, row)) - Number(samePrinting(a, row)) ||
            (b.forTrade ?? 0) - (a.forTrade ?? 0),
        )
      for (const item of candidates) {
        if (left <= 0) break
        const take = Math.min(left, item.qty)
        const qty = item.qty - take
        if (qty <= 0) {
          await db.collection.delete(item.id)
          await tombstone([item.id])
        } else await db.collection.update(item.id, { qty, forTrade: tradeCount((item.forTrade ?? 0) - take, qty) })
        left -= take
        result.removed += take
      }
      result.short += left
    }
    for (const row of trade.get) {
      await addToCollection(sharedCardToCard(row), { finish: row.finish, condition: row.condition, qty: row.qty })
      result.added += row.qty
    }
    await db.trades.put({ ...trade, status: 'completed', updatedAt: Date.now(), appliedAt: Date.now() })
  })
  return result
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

/**
 * File a scan in the tray, returning the row's id so the caller can mark it
 * added once the copy actually lands in the collection.
 *
 * `read` is what the scanner saw on the physical copy — the finish it detected
 * and a slab's grade. It rides along so the batch-add screen files the copy in
 * frame rather than the printing's default; a re-scan that reads a finish
 * replaces a previous blank one, but never clears a reading with nothing.
 */
export async function recordScan(card: Card, read: { finish?: Finish; grade?: GradeInfo } = {}): Promise<string> {
  // Re-scanning the card already at the head of the tray refreshes that row
  // instead of stacking a duplicate tile.
  const latest = await db.scans.orderBy('at').last()
  let id: string
  if (latest?.cardId === card.id) {
    id = latest.id
    await db.scans.update(id, {
      at: Date.now(),
      card,
      finish: read.finish ?? latest.finish,
      grade: read.grade ?? latest.grade,
    })
  } else {
    id = uid()
    await db.scans.add({ id, cardId: card.id, at: Date.now(), card, finish: read.finish, grade: read.grade })
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
  return id
}

/**
 * Mark tray rows as filed into the collection (or unmark them, which is what
 * an undo of a batch add does). Best-effort by design: a row the tray has
 * already aged out is simply not there to mark, and that must not fail the add
 * that prompted it.
 */
export async function markScansAdded(ids: string[], added = true): Promise<void> {
  if (!ids.length) return
  await db.transaction('rw', db.scans, async () => {
    for (const id of ids) await db.scans.update(id, { added })
  })
}

/**
 * Drop one scan from the tray. Returns the removed row so the caller can put
 * it back verbatim — an undo has to restore the original `at`, or the tile
 * would reappear at the head of the tray instead of where it was.
 */
export async function removeScan(id: string): Promise<ScanRecord | null> {
  const scan = await db.scans.get(id)
  if (!scan) return null
  await db.scans.delete(id)
  return scan
}

/** Empty the tray, returning what was in it so the undo can restore it. */
export async function clearScans(): Promise<ScanRecord[]> {
  const scans = await db.scans.toArray()
  await db.scans.clear()
  return scans
}

/** Put removed scans back exactly as they were (the undo side of both above). */
export async function restoreScans(scans: ScanRecord[]): Promise<void> {
  await db.scans.bulkPut(scans)
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
  friends: Friend[]
  trades: TradeRecord[]
  wants: WantRow[]
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
    friends: await db.friends.toArray(),
    trades: await db.trades.toArray(),
    wants: await db.wants.toArray(),
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
    const cleanQty = Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 0
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
      qty: cleanQty,
      opened: typeof entry.opened === 'boolean' ? entry.opened : undefined,
      forTrade: tradeCount(asPositive(entry.forTrade), cleanQty),
      purchasePrice: asPositive(entry.purchasePrice),
      grade: sanitizeGrade(entry.grade),
      marketValue: asPositive(entry.marketValue),
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

  const friends: Friend[] = []
  for (const entry of asArray(raw.friends)) {
    const friend = sanitizeFriendRecord(entry)
    if (friend) friends.push(friend)
  }

  const trades: TradeRecord[] = []
  for (const entry of asArray(raw.trades)) {
    const trade = sanitizeTradeRecord(entry)
    if (trade) trades.push(trade)
  }

  const wants: WantRow[] = []
  for (const entry of asArray(raw.wants)) {
    const want = sanitizeWantRecord(entry)
    if (want) wants.push(want)
  }

  return {
    app: 'cardstock',
    version: 1,
    exportedAt: asString(raw.exportedAt) ?? new Date().toISOString(),
    collection,
    decks,
    deckCards,
    history,
    friends,
    trades,
    wants,
  }
}

export async function importBackup(raw: unknown): Promise<void> {
  const backup = sanitizeBackup(raw)
  await db.transaction(
    'rw',
    [db.collection, db.decks, db.deckCards, db.history, db.friends, db.trades, db.wants, db.tombstones],
    async () => {
      await db.collection.bulkPut(backup.collection)
      // Restoring a row is the user un-deleting it. Leave the tombstone in
      // place and the next sync would dutifully delete it again — the restore
      // would appear to work and then quietly undo itself.
      await db.tombstones.bulkDelete(backup.collection.map((item) => item.id))
      await db.decks.bulkPut(backup.decks)
      await db.deckCards.bulkPut(backup.deckCards)
      await db.history.bulkPut(backup.history)
      await db.friends.bulkPut(backup.friends)
      await db.trades.bulkPut(backup.trades)
      await db.wants.bulkPut(backup.wants)
    },
  )
}

export async function clearAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.collection, db.decks, db.deckCards, db.history, db.scans, db.catalogs, db.friends, db.trades, db.wants, db.tombstones],
    async () => {
      await Promise.all([
        // Tombstones are cleared, never written, by an erase — see tombstone().
        // "Erase this device" must not become a remote wipe.
        db.tombstones.clear(),
        db.collection.clear(),
        db.decks.clear(),
        db.deckCards.clear(),
        db.history.clear(),
        db.scans.clear(),
        db.catalogs.clear(),
        db.friends.clear(),
        db.trades.clear(),
        db.wants.clear(),
      ])
    },
  )
}
