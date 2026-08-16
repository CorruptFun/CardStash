import Dexie, { type Table } from 'dexie'
import { sanitizeGrade } from './slab'
import { cleanBinderPage } from './binders'
import { customCard, mergePatch, mergePatches, sanitizePatch, unmergePatch } from './cardpatch'
import { GAMES, FINISH_LABEL } from './games'
import { ygoPrintingVariants } from './ygo'
import type {
  BinderCard,
  BinderPayload,
  BinderVisibility,
  Card,
  CardPatch,
  CatalogCache,
  CollectionItem,
  CustomBinder,
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
  SharedBinder,
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
  sharedBinderFromPayload,
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
  patches!: Table<CardPatch, string>
  binders!: Table<CustomBinder, string>
  binderCards!: Table<BinderCard, string>

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
     * v8: user-authored card data — the picture a catalog never had, and the
     * fields the user filled in for a card no catalog lists (`cardpatch.ts`).
     *
     * Keyed by the card id it patches rather than by a row id of its own,
     * because there is exactly one answer per card and an upsert must not be
     * able to produce two. `custom` is deliberately NOT indexed: it is a
     * boolean, IndexedDB has no boolean key type, and an index on one silently
     * stores nothing — a query against it would look like "no custom cards"
     * rather than fail. The whole table is small enough to filter.
     */
    this.version(8).stores({ patches: 'cardId, game, updatedAt' })

    /**
     * v9: binders the user builds by hand — a named selection of copies they
     * own, each with its own audience.
     *
     * `binderCards` is keyed on the COLLECTION ROW (`itemId`), not the card, so
     * a binder holds the copy the user actually owns — its finish, condition
     * and grade come from the row rather than from a fourth denormalized
     * `Card` that a patch would have to chase (see `savePatch`). The compound
     * `[binderId+itemId]` index is what makes "already in this binder?" one
     * lookup instead of a scan.
     *
     * `visibility` is deliberately NOT indexed: it is one of three strings on
     * a table that will hold tens of rows, and an index would be a promise
     * about scale this table does not need.
     */
    this.version(9).stores({
      binders: 'id, updatedAt',
      binderCards: 'id, binderId, itemId, cardId, [binderId+itemId]',
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
      | 'finish'
      | 'condition'
      | 'opened'
      | 'purchasePrice'
      | 'note'
      | 'card'
      | 'forTrade'
      | 'grade'
      | 'marketValue'
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

/**
 * File a custom binder somebody shared under the collector it came from.
 *
 * **It never touches their card list**, which is the whole reason a binder is
 * its own payload kind: a binder is a subset, and merging one into the main
 * snapshot would replace "everything Rae owns" with "Rae's four Charizards".
 * An unfollowed sender gets a stub record with no cards — enough to hang the
 * binder on and to show a name — rather than the binder being refused.
 */
export async function upsertFriendBinder(
  payload: BinderPayload,
): Promise<{ friend: Friend; binder: SharedBinder; created: boolean }> {
  return db.transaction('rw', db.friends, async () => {
    const existing = await db.friends.get(payload.from.id)
    const binder = sharedBinderFromPayload(payload)
    const others = (existing?.binders ?? []).filter((row) => row.id !== binder.id)
    const friend: Friend = {
      ...(existing ?? {
        id: payload.from.id,
        name: payload.from.name,
        scope: 'trade',
        addedAt: Date.now(),
        exportedAt: payload.at,
        cards: [],
      }),
      updatedAt: Date.now(),
      binders: [...others, binder].sort((a, b) => b.at - a.at),
    }
    await db.friends.put(friend)
    return { friend, binder, created: !existing }
  })
}

/** Replace every hosted binder a friend publishes, in one write. */
export async function replaceFriendBinders(friendId: string, binders: SharedBinder[]): Promise<void> {
  await db.transaction('rw', db.friends, async () => {
    const existing = await db.friends.get(friendId)
    if (!existing) return
    await db.friends.update(friendId, { binders: binders.length ? binders : undefined, updatedAt: Date.now() })
  })
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

/**
 * Push a freshly fetched card into every collection/deck row that shows it.
 *
 * The fetch is re-patched on the way in. A price refresh is the one thing that
 * routinely overwrites a stored card wholesale, so without this the user's own
 * photo would survive right up until prices went stale and then silently
 * revert to the catalog's missing one.
 */
export async function applyCardUpdate(fresh: Card): Promise<void> {
  const card = patched(fresh)
  await db.transaction('rw', db.collection, db.deckCards, async () => {
    const items = await db.collection.where('cardId').equals(card.id).toArray()
    for (const item of items) await db.collection.update(item.id, { card: cardForItem(card, item), name: card.name })
    const deckRows = await db.deckCards.where('cardId').equals(card.id).toArray()
    for (const row of deckRows) await db.deckCards.update(row.id, { card })
  })
  await recordPricePoint(card)
}

/* ------------------------------------------------ user-authored card data */

/**
 * The patch index, held in memory for the whole session.
 *
 * Patches have to be readable SYNCHRONOUSLY. `CardImg` renders in a hundred
 * places and cannot await a Dexie round trip to decide whether the user
 * already supplied the picture the catalog is missing — an async lookup there
 * would flash the grey fallback on every scroll. The table is one row per card
 * the user has personally touched, so it is small by construction; the cost is
 * one read at boot and a map write per edit.
 *
 * `loadPatches()` is awaited by boot before the first render. Until then the
 * map is empty, which degrades to exactly today's behaviour rather than to
 * anything wrong.
 */
const patchIndex = new Map<string, CardPatch>()
const patchListeners = new Set<() => void>()
/** Bumped on every index change, so `useSyncExternalStore` has a snapshot. */
let patchRevision = 0

function notifyPatches(): void {
  patchRevision++
  for (const listener of patchListeners) listener()
}

export function subscribePatches(listener: () => void): () => void {
  patchListeners.add(listener)
  return () => patchListeners.delete(listener)
}

export function patchRevisionSnapshot(): number {
  return patchRevision
}

/** Fill the in-memory index from Dexie. Called once at boot. */
export async function loadPatches(): Promise<void> {
  const rows = await db.patches.toArray()
  patchIndex.clear()
  for (const row of rows) {
    const clean = sanitizePatch(row)
    if (clean) patchIndex.set(clean.cardId, clean)
  }
  notifyPatches()
}

/** The patch for one card, if the user (or the shared index) has one. */
export function patchFor(cardId: string): CardPatch | undefined {
  return patchIndex.get(cardId)
}

/** Lay any local patch over a card. The one call every read path should use. */
export function patched(card: Card): Card {
  return mergePatch(card, patchIndex.get(card.id))
}

/** Lay patches over a list of cards. */
export function patchedAll(cards: Card[]): Card[] {
  return mergePatches(cards, patchIndex)
}

/**
 * Write a patch and push it through everything already holding a copy of the
 * card.
 *
 * The second half is not optional. `Card` is denormalized into collection
 * rows, deck rows and the scan tray (see `applyCardUpdate`), so a patch that
 * only updated the index would fix the card sheet and leave the collection
 * grid showing the same grey rectangle the user just fixed. One write, every
 * surface — the same contract a price refresh has.
 */
export async function savePatch(raw: CardPatch): Promise<CardPatch | null> {
  const patch = sanitizePatch(raw)
  if (!patch) {
    await deletePatch(raw?.cardId)
    return null
  }
  const previous = patchIndex.get(patch.cardId)
  await db.patches.put(patch)
  patchIndex.set(patch.cardId, patch)
  notifyPatches()
  await repatchStoredCard(patch.cardId, previous)
  return patch
}

/** Drop a patch: the card goes back to whatever its catalog says. */
export async function deletePatch(cardId: string | undefined): Promise<void> {
  if (!cardId) return
  // Read the outgoing patch BEFORE dropping it: the stored copies of the card
  // carry its image baked in, and peeling that back off needs to know what it
  // was. Deleting first is how an undo leaves the picture it was undoing.
  const previous = patchIndex.get(cardId)
  patchIndex.delete(cardId)
  await db.patches.delete(cardId)
  if (previous) {
    notifyPatches()
    await repatchStoredCard(cardId, previous)
  }
}

/**
 * Re-stamp the stored copies of one card after its patch changed.
 *
 * Deliberately re-derives from the row's own card rather than from a catalog
 * fetch: this runs offline, and the point is to apply an edit the user just
 * made, not to spend a network request confirming it.
 */
async function repatchStoredCard(cardId: string, previous?: CardPatch): Promise<void> {
  await db.transaction('rw', db.collection, db.deckCards, db.scans, async () => {
    const items = await db.collection.where('cardId').equals(cardId).toArray()
    for (const item of items) {
      const card = patched(basePatchTarget(item.card, previous))
      await db.collection.update(item.id, { card: cardForItem(card, item), name: card.name })
    }
    const deckRows = await db.deckCards.where('cardId').equals(cardId).toArray()
    for (const row of deckRows) await db.deckCards.update(row.id, { card: patched(basePatchTarget(row.card, previous)) })
    // The scan tray is not indexed by cardId and does not need to be: it is
    // capped at 30 rows (SCAN_TRAY_LIMIT), so a filter is cheaper than the
    // schema version an index would cost.
    const scans = await db.scans.filter((scan) => scan.cardId === cardId).toArray()
    for (const scan of scans) await db.scans.update(scan.id, { card: patched(basePatchTarget(scan.card, previous)) })
  })
}

/**
 * A stored card with any PREVIOUS patch peeled back off.
 *
 * Without this, removing a patch would leave the old edit frozen into every
 * stored copy: `mergePatch` overwrites in place, so the catalog's own values
 * are gone from the denormalized copy the moment a patch is written over it.
 * `unmergePatch` puts back exactly what the patch remembers covering, which is
 * why `CardPatch.base` exists.
 */
function basePatchTarget(card: Card, previous?: CardPatch): Card {
  if (!card.patched) return card
  return unmergePatch(card, previous)
}

/**
 * Cards that exist only because the user described them — the local catalog.
 *
 * Same idea as sports' "local recall is the catalog": with no upstream to
 * search, the cards this user typed in ARE the search index for them, and it
 * needs no network.
 */
export async function customCards(game?: Game): Promise<Card[]> {
  const rows = await db.patches.toArray()
  return rows
    .filter((row) => row.custom && (!game || row.game === game))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((row) => customCard(row.game, row.fields, row.image))
}

const CUSTOM_SEARCH_LIMIT = 20

/** Free-text search over the user's own cards, merged into normal results. */
export async function searchCustomCards(game: Game, query: string): Promise<Card[]> {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  const cards = await customCards(game)
  return cards
    .filter((card) =>
      [card.name, card.setName, card.setCode, card.number, card.typeLine]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
    .slice(0, CUSTOM_SEARCH_LIMIT)
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

/* --- custom binders ------------------------------------------------------ */

/**
 * A binder starts **private**, always, whatever the caller passes.
 *
 * Publishing is a deliberate act (the `socialConfigured` / `socialPublishing`
 * split, decision 16, applied one level down). A binder that arrived public
 * because a picker defaulted that way is exactly the accident this feature
 * must not have: the user named it, filled it, and only then chose who sees it.
 */
export async function createBinder(name: string, note?: string): Promise<CustomBinder> {
  const binder: CustomBinder = {
    id: uid(),
    name: name.trim().slice(0, 60) || 'Untitled binder',
    note: note?.trim().slice(0, 400) || undefined,
    visibility: 'private',
    tradeable: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await db.binders.add(binder)
  return binder
}

export async function updateBinder(
  id: string,
  patch: Partial<Pick<CustomBinder, 'name' | 'note' | 'coverCardId' | 'visibility' | 'tradeable'>>,
): Promise<void> {
  const clean: Partial<CustomBinder> = { ...patch, updatedAt: Date.now() }
  if (clean.name != null) clean.name = clean.name.trim().slice(0, 60) || 'Untitled binder'
  if (clean.note != null) clean.note = clean.note.trim().slice(0, 400) || undefined
  await db.binders.update(id, clean)
}

export async function deleteBinder(id: string): Promise<void> {
  await db.transaction('rw', db.binders, db.binderCards, async () => {
    await db.binderCards.where('binderId').equals(id).delete()
    await db.binders.delete(id)
  })
}

/**
 * Put copies of a collection row into a binder.
 *
 * Clamped to the copies that actually exist: a binder is a claim about
 * physical cards, and one saying you have four of something you own two of is
 * a claim a friend will act on. Re-adding tops up rather than duplicating.
 */
export async function addToBinder(binderId: string, itemId: string, qty = 1, page?: number): Promise<void> {
  const cleanPage = cleanBinderPage(page)
  await db.transaction('rw', db.binders, db.binderCards, db.collection, async () => {
    const item = await db.collection.get(itemId)
    if (!item) return
    const existing = await db.binderCards.where('[binderId+itemId]').equals([binderId, itemId]).first()
    const next = Math.max(1, Math.min(item.qty, (existing?.qty ?? 0) + qty))
    if (existing) {
      // The first page a copy was seen on wins: re-reading page 7 must not
      // move a card that page 3 already accounted for.
      await db.binderCards.update(existing.id, { qty: next, page: existing.page ?? cleanPage })
    } else {
      await db.binderCards.add({
        id: uid(),
        binderId,
        itemId,
        cardId: item.cardId,
        qty: next,
        page: cleanPage,
        addedAt: Date.now(),
      })
    }
    await db.binders.update(binderId, { updatedAt: Date.now() })
  })
}

export async function setBinderCardQty(id: string, qty: number): Promise<void> {
  await db.transaction('rw', db.binders, db.binderCards, db.collection, async () => {
    const row = await db.binderCards.get(id)
    if (!row) return
    if (qty <= 0) {
      await db.binderCards.delete(id)
    } else {
      const item = await db.collection.get(row.itemId)
      await db.binderCards.update(id, { qty: Math.min(qty, item?.qty ?? qty) })
    }
    await db.binders.update(row.binderId, { updatedAt: Date.now() })
  })
}

export async function removeFromBinder(id: string): Promise<void> {
  await setBinderCardQty(id, 0)
}

/** Which binders already hold a given collection row — for the picker's ticks. */
export async function bindersHolding(itemId: string): Promise<Set<string>> {
  const rows = await db.binderCards.where('itemId').equals(itemId).toArray()
  return new Set(rows.map((row) => row.binderId))
}

/**
 * Drop binder rows whose collection row is gone.
 *
 * Called after a collection delete rather than cascading from one, because a
 * collection row can disappear down several paths (`applyTradeToCollection`,
 * an edit to zero, an erase) and a sweep cannot be forgotten by the next one
 * somebody adds — the same reasoning as the `updatedAt` hook above.
 */
export async function pruneBinderCards(): Promise<number> {
  return db.transaction('rw', db.binderCards, db.collection, async () => {
    const rows = await db.binderCards.toArray()
    if (!rows.length) return 0
    const ids = new Set((await db.collection.toArray()).map((item) => item.id))
    const dead = rows.filter((row) => !ids.has(row.itemId)).map((row) => row.id)
    if (dead.length) await db.binderCards.bulkDelete(dead)
    return dead.length
  })
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
  /**
   * User-authored card data. Optional on the way IN — every backup written
   * before v8 lacks it and must still restore — but always written on the way
   * out. A photo the user took of their own card exists nowhere else in the
   * world, so leaving it out of the backup would make "restore" quietly lossy.
   */
  patches?: CardPatch[]
  /**
   * Binders the user built by hand. Optional on the way IN — every backup
   * written before v9 lacks them and must still restore — and always written
   * on the way out. A binder is arrangement work that exists nowhere else: the
   * cards are in the collection, the *grouping* is not.
   */
  binders?: CustomBinder[]
  binderCards?: BinderCard[]
}

export interface ExportOptions {
  /**
   * Cap the total characters of patch imagery this backup may carry.
   *
   * Only the **vault** passes one. A card picture is by far the heaviest thing
   * in a backup (~57 KB of base64 each), and the vault is a single Postgres
   * text column written on every sync — a user who has fixed a few hundred
   * cards would otherwise turn their automatic backup into a multi-megabyte
   * round trip and eventually into one that simply fails, which is the exact
   * failure decision 15b exists to prevent. The JSON export and the Drive
   * backup are real file writes and pass no budget, so the complete set always
   * has somewhere to live.
   */
  imageBudget?: number
}

export interface ExportStats {
  /** Patches left out because the image budget ran out. */
  patchesOmitted: number
}

/**
 * Which patches fit the budget, newest first.
 *
 * Rows past the budget are omitted ENTIRELY rather than stripped of their
 * image, and the difference is data loss. `mergeBackups` is a union: a row
 * absent from one side is kept from the other, so an omitted patch costs
 * nothing. A row that arrived image-less could WIN on `updatedAt` and delete a
 * photo that only existed on the receiving device. Never send a gutted patch.
 */
export function patchesWithinBudget(rows: CardPatch[], budget: number): { kept: CardPatch[]; omitted: number } {
  const ordered = [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
  const kept: CardPatch[] = []
  let spent = 0
  let omitted = 0
  for (const row of ordered) {
    const cost = row.image?.length ?? 0
    // A patch that is only text is effectively free and always travels.
    if (cost && spent + cost > budget) {
      omitted++
      continue
    }
    spent += cost
    kept.push(row)
  }
  return { kept, omitted }
}

export async function exportBackup(options: ExportOptions = {}): Promise<Backup> {
  const patches = await db.patches.toArray()
  const budgeted = options.imageBudget != null ? patchesWithinBudget(patches, options.imageBudget).kept : patches
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
    binders: await db.binders.toArray(),
    binderCards: await db.binderCards.toArray(),
    patches: budgeted,
  }
}

/** How much room the user's own card pictures are taking, for the UI. */
export async function patchStorage(): Promise<{ count: number; withImage: number; chars: number }> {
  const rows = await db.patches.toArray()
  let chars = 0
  let withImage = 0
  for (const row of rows) {
    if (!row.image) continue
    withImage++
    chars += row.image.length
  }
  return { count: rows.length, withImage, chars }
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

  const binders: CustomBinder[] = []
  for (const entry of asArray(raw.binders)) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    if (!id) continue
    const visibility = entry.visibility
    binders.push({
      ...(entry as object),
      id,
      name: asString(entry.name)?.slice(0, 60) ?? 'Untitled binder',
      note: asString(entry.note)?.slice(0, 400),
      // Anything the file does not clearly say is PRIVATE. A restore must
      // never be the thing that publishes a binder — an unrecognised value in
      // a backup someone edited by hand is not consent to share.
      visibility: visibility === 'public' || visibility === 'friends' ? (visibility as BinderVisibility) : 'private',
      tradeable: entry.tradeable === true,
      createdAt: asPositive(entry.createdAt) ?? Date.now(),
      updatedAt: asPositive(entry.updatedAt) ?? Date.now(),
    } as CustomBinder)
  }

  const binderCards: BinderCard[] = []
  for (const entry of asArray(raw.binderCards)) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    const binderId = asString(entry.binderId)
    const itemId = asString(entry.itemId)
    const cardId = asString(entry.cardId)
    if (!id || !binderId || !itemId || !cardId) continue
    binderCards.push({
      id,
      binderId,
      itemId,
      cardId,
      qty: Math.max(1, Math.min(9_999, Math.floor(asPositive(entry.qty) ?? 1))),
      page: cleanBinderPage(entry.page),
      addedAt: asPositive(entry.addedAt) ?? Date.now(),
    })
  }

  const patches: CardPatch[] = []
  for (const entry of asArray(raw.patches)) {
    // Same sanitizer a pasted link and the shared index go through: a backup
    // is an outside document, and an image in one is a URL the app will render.
    const patch = sanitizePatch(entry)
    if (patch) patches.push(patch)
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
    binders,
    binderCards,
    patches,
  }
}

export async function importBackup(raw: unknown): Promise<void> {
  const backup = sanitizeBackup(raw)
  await db.transaction(
    'rw',
    [
      db.collection,
      db.decks,
      db.deckCards,
      db.history,
      db.friends,
      db.trades,
      db.wants,
      db.tombstones,
      db.patches,
      db.binders,
      db.binderCards,
    ],
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
      if (backup.patches?.length) await db.patches.bulkPut(backup.patches)
      if (backup.binders?.length) await db.binders.bulkPut(backup.binders)
      if (backup.binderCards?.length) await db.binderCards.bulkPut(backup.binderCards)
    },
  )
  // A binder row whose collection row did not come back is a hollow entry;
  // the restore is the moment to notice, not the next publish.
  await pruneBinderCards()
  // The in-memory index is now behind the table it mirrors.
  if (backup.patches?.length) await loadPatches()
}

export async function clearAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.collection,
      db.decks,
      db.deckCards,
      db.history,
      db.scans,
      db.catalogs,
      db.friends,
      db.trades,
      db.wants,
      db.binders,
      db.tombstones,
      db.patches,
      db.binders,
      db.binderCards,
    ],
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
        db.binders.clear(),
        db.patches.clear(),
        db.binders.clear(),
        db.binderCards.clear(),
      ])
    },
  )
  await loadPatches()
}
