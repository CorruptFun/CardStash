import { CONDITIONS, FINISH_LABEL, GAMES } from './games'
import { conditionFactor, itemUnitPrice, mergePrices } from './prices'
import { settings } from './settings'
import type {
  Card,
  CollectionItem,
  Condition,
  Finish,
  Friend,
  Game,
  ProfilePayload,
  ReplyPayload,
  ShareScope,
  SharedCard,
  SharedWant,
  SocialPayload,
  TradePayload,
  TradeRecord,
  TradeStatus,
  WantRow,
} from './types'
import { ebaySoldLink, normalizeName, tcgplayerSearchLink, uid } from './util'

/**
 * Friends & trades without a server. There is no backend and no account: a
 * profile is a snapshot of your binder encoded into a link or a JSON file
 * that you hand to people yourself — or host anywhere that serves raw JSON
 * with CORS (a GitHub Gist raw link works) so friends can re-fetch it.
 * Trade proposals and replies ride the same rails. This module is the pure
 * build/encode/decode/sanitize layer; every Dexie write lives in db.ts.
 */

const MARKER = 'cardstock-social'
const NOT_SOCIAL = 'Not a Cardstock share — check the link or file'

/** Rough character count past which a link stops pasting cleanly into chat apps. */
export const LONG_LINK_CHARS = 20_000

const PROFILE_CARD_CAP = 8_000
const TRADE_CARD_CAP = 400
const FINISHES = Object.keys(FINISH_LABEL) as Finish[]
const TRADE_STATUSES: TradeStatus[] = ['proposed', 'accepted', 'declined', 'completed', 'canceled']

/* --- my profile ---------------------------------------------------------- */

export interface MyProfile {
  id: string
  name: string
  note?: string
  scope: ShareScope
}

/** The stable id this device shares under — minted on first use, then kept. */
export function ensureProfileId(): string {
  const config = settings()
  if (!config.profileId) config.set({ profileId: uid() })
  return settings().profileId
}

export function myProfile(): MyProfile {
  const config = settings()
  return {
    id: ensureProfileId(),
    name: config.profileName.trim(),
    note: config.profileNote.trim() || undefined,
    scope: config.shareScope,
  }
}

/* --- building payloads --------------------------------------------------- */

/** Market unit for the row's finish with condition NOT applied (NM probe). */
function rowMarketUnit(item: CollectionItem): number | undefined {
  const value = itemUnitPrice({ finish: item.finish, condition: 'NM', qty: 1, card: item.card })
  return value != null ? Math.round(value * 100) / 100 : undefined
}

export function itemToSharedCard(item: CollectionItem, qty = item.qty, forTrade = item.forTrade ?? 0): SharedCard {
  return {
    cardId: item.cardId,
    game: item.game,
    name: item.name,
    setCode: item.setCode ?? item.card.setCode,
    setName: item.setName ?? item.card.setName,
    number: item.number ?? item.card.number,
    rarity: item.rarity ?? item.card.rarity,
    finish: item.finish,
    condition: item.condition,
    qty,
    forTrade: Math.max(0, Math.min(qty, forTrade)),
    image: item.card.imageSmall ?? item.card.imageLarge,
    price: rowMarketUnit(item),
  }
}

/** Rows a profile share includes (opened sealed products never travel). */
export function shareableItems(items: CollectionItem[], scope: ShareScope): CollectionItem[] {
  const rows = items.filter((item) => item.qty > 0 && item.opened !== true)
  return scope === 'all' ? rows : rows.filter((item) => (item.forTrade ?? 0) > 0)
}

export function buildProfilePayload(items: CollectionItem[], me: MyProfile, wants: WantRow[] = []): ProfilePayload {
  const rows = shareableItems(items, me.scope)
  // Binder-only shares expose just the copies actually up for trade.
  const cards = rows.map((item) =>
    me.scope === 'trade' ? itemToSharedCard(item, item.forTrade ?? 0, item.forTrade ?? 0) : itemToSharedCard(item),
  )
  return {
    kind: 'profile',
    id: me.id,
    name: me.name || 'A Cardstock collector',
    note: me.note,
    scope: me.scope,
    at: Date.now(),
    cards,
    wants: wants.length ? wants.map(wantToShared) : undefined,
  }
}

/* --- wants & matchmaking -------------------------------------------------- */

/** Card-level want identity: any printing of the name matches. */
export function wantKeyFor(game: Game, name: string): string {
  return `${game}|${normalizeName(name)}`
}

export function wantKeySet(rows: { game: Game; name: string }[]): Set<string> {
  return new Set(rows.map((row) => wantKeyFor(row.game, row.name)))
}

export function cardToWantRow(card: Card): WantRow {
  return {
    key: wantKeyFor(card.game, card.name),
    cardId: card.id,
    game: card.game,
    name: card.name,
    setCode: card.setCode,
    image: card.imageSmall ?? card.imageLarge,
    price: card.prices.best ?? card.prices.bestFoil ?? undefined,
    addedAt: Date.now(),
  }
}

function wantToShared(want: WantRow): SharedWant {
  return { cardId: want.cardId, game: want.game, name: want.name, image: want.image, price: want.price }
}

/** Row identity for snapshot diffing (printing+finish+condition). */
function snapshotKey(row: SharedCard): string {
  return `${row.cardId}|${row.finish}|${row.condition}|${row.setCode ?? ''}|${row.number ?? ''}`
}

export function friendFromProfile(payload: ProfilePayload, existing?: Friend, sourceUrl?: string): Friend {
  let lastDelta = existing?.lastDelta
  if (existing) {
    const before = new Set(existing.cards.map(snapshotKey))
    const after = new Set(payload.cards.map(snapshotKey))
    let added = 0
    for (const key of after) if (!before.has(key)) added++
    let removed = 0
    for (const key of before) if (!after.has(key)) removed++
    if (added || removed) lastDelta = { added, removed, at: Date.now() }
  }
  return {
    id: payload.id,
    name: payload.name,
    note: payload.note,
    scope: payload.scope,
    addedAt: existing?.addedAt ?? Date.now(),
    updatedAt: Date.now(),
    exportedAt: payload.at,
    sourceUrl: sourceUrl ?? existing?.sourceUrl,
    cards: payload.cards,
    wants: payload.wants,
    lastDelta,
  }
}

export function buildTradePayload(trade: TradeRecord, me: MyProfile): TradePayload {
  // Stored give/get are from MY perspective; on the wire, the sender's
  // offer is what they hand over.
  return {
    kind: 'trade',
    id: trade.id,
    at: Date.now(),
    from: { id: me.id, name: me.name || 'A Cardstock collector' },
    to: { id: trade.friendId || undefined, name: trade.friendName || undefined },
    note: trade.note,
    offer: trade.give,
    want: trade.get,
  }
}

/** A received proposal as a stored trade: what they want is what I give. */
export function tradeFromPayload(payload: TradePayload): TradeRecord {
  return {
    id: payload.id,
    friendId: payload.from.id,
    friendName: payload.from.name,
    direction: 'in',
    status: 'proposed',
    createdAt: payload.at,
    updatedAt: Date.now(),
    note: payload.note,
    give: payload.want,
    get: payload.offer,
  }
}

export function buildReplyPayload(
  trade: TradeRecord,
  me: MyProfile,
  status: 'accepted' | 'declined',
  note?: string,
): ReplyPayload {
  return {
    kind: 'reply',
    id: trade.id,
    at: Date.now(),
    from: { id: me.id, name: me.name || 'A Cardstock collector' },
    status,
    note: note?.trim() || undefined,
  }
}

/* --- shared-row math ----------------------------------------------------- */

/** What a shared row is worth: finish market × condition factor × qty. */
export function sharedRowValue(row: SharedCard, qty = row.qty): number {
  if (row.price == null) return 0
  return Math.round(row.price * conditionFactor(row.condition) * qty * 100) / 100
}

export function sideValue(rows: SharedCard[]): number {
  let total = 0
  for (const row of rows) total += sharedRowValue(row)
  return total
}

export function sideQty(rows: SharedCard[]): number {
  return rows.reduce((sum, row) => sum + row.qty, 0)
}

/** Rebuild a live-ish Card from a shared row so CardImg/CardSheet/add work. */
export function sharedCardToCard(row: SharedCard, pricedAt?: number): Card {
  const colon = row.cardId.indexOf(':')
  const apiId = colon > 0 ? row.cardId.slice(colon + 1) : row.cardId
  const entries =
    row.price != null
      ? [{ source: 'tcgplayer' as const, kind: 'market' as const, finish: row.finish, currency: 'USD' as const, value: row.price }]
      : []
  return {
    id: row.cardId,
    game: row.game,
    apiId,
    name: row.name,
    setCode: row.setCode,
    setName: row.setName,
    number: row.number,
    rarity: row.rarity,
    imageSmall: row.image,
    prices: mergePrices(entries, pricedAt ?? Date.now()),
    links: {
      ebaySold: ebaySoldLink({ name: row.name, setName: row.setName, game: row.game }),
      tcgplayer: tcgplayerSearchLink(row.name),
    },
  }
}

/** Same printing = same set + collector number (mirrors db.ts's matcher). */
export function samePrintingRow(a: { setCode?: string; number?: string }, b: { setCode?: string; number?: string }): boolean {
  return (a.setCode ?? '') === (b.setCode ?? '') && (a.number ?? '') === (b.number ?? '')
}

export function tradeStatusLabel(trade: TradeRecord): string {
  switch (trade.status) {
    case 'proposed':
      return trade.direction === 'in' ? 'Needs your answer' : 'Waiting on them'
    case 'accepted':
      return 'Accepted'
    case 'declined':
      return 'Declined'
    case 'completed':
      return 'Completed'
    case 'canceled':
      return 'Canceled'
  }
}

/* --- sanitizing untrusted input ------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStr(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, max)
  return trimmed.length ? trimmed : undefined
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  return Math.max(min, Math.min(max, Math.floor(num)))
}

function asTime(value: unknown): number {
  const num = Number(value)
  // Anything outside 2001..now+1y is someone's clock being creative.
  return Number.isFinite(num) && num > 1_000_000_000_000 && num < Date.now() + 366 * 86_400_000 ? num : Date.now()
}

function httpsImage(value: string | undefined): string | undefined {
  return value && /^https:\/\//i.test(value) ? value : undefined
}

export function sanitizeSharedCard(raw: unknown): SharedCard | null {
  if (!isRecord(raw)) return null
  const cardId = asStr(raw.cardId, 160)
  const name = asStr(raw.name, 200)
  if (!cardId || !name) return null
  const colon = cardId.indexOf(':')
  const game = colon > 0 ? (cardId.slice(0, colon) as Game) : null
  if (!game || !GAMES.includes(game)) return null
  const qty = clampInt(raw.qty, 1, 9_999) ?? 1
  const price = Number(raw.price)
  return {
    cardId,
    game,
    name,
    setCode: asStr(raw.setCode, 80),
    setName: asStr(raw.setName, 120),
    number: asStr(raw.number, 32),
    rarity: asStr(raw.rarity, 40),
    finish: FINISHES.includes(raw.finish as Finish) ? (raw.finish as Finish) : 'nonfoil',
    condition: CONDITIONS.includes(raw.condition as Condition) ? (raw.condition as Condition) : 'NM',
    qty,
    forTrade: Math.min(qty, clampInt(raw.forTrade, 0, 9_999) ?? 0),
    image: httpsImage(asStr(raw.image, 500)),
    price: Number.isFinite(price) && price > 0 && price < 1_000_000 ? Math.round(price * 100) / 100 : undefined,
  }
}

function sanitizeSharedCards(raw: unknown, cap: number): SharedCard[] {
  if (!Array.isArray(raw)) return []
  const rows: SharedCard[] = []
  for (const entry of raw) {
    if (rows.length >= cap) break
    const row = sanitizeSharedCard(entry)
    if (row) rows.push(row)
  }
  return rows
}

const WANT_CAP = 2_000

function sanitizeSharedWant(raw: unknown): SharedWant | null {
  if (!isRecord(raw)) return null
  const cardId = asStr(raw.cardId, 160)
  const name = asStr(raw.name, 200)
  if (!cardId || !name) return null
  const colon = cardId.indexOf(':')
  const game = colon > 0 ? (cardId.slice(0, colon) as Game) : null
  if (!game || !GAMES.includes(game)) return null
  const price = Number(raw.price)
  return {
    cardId,
    game,
    name,
    image: httpsImage(asStr(raw.image, 500)),
    price: Number.isFinite(price) && price > 0 && price < 1_000_000 ? Math.round(price * 100) / 100 : undefined,
  }
}

function sanitizeSharedWants(raw: unknown): SharedWant[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const rows: SharedWant[] = []
  for (const entry of raw) {
    if (rows.length >= WANT_CAP) break
    const row = sanitizeSharedWant(entry)
    if (row) rows.push(row)
  }
  return rows.length ? rows : undefined
}

/** Backup round-trip: validate a stored want-list row. */
export function sanitizeWantRecord(raw: unknown): WantRow | null {
  const shared = sanitizeSharedWant(raw)
  if (!shared) return null
  const record = raw as Record<string, unknown>
  return {
    ...shared,
    key: wantKeyFor(shared.game, shared.name),
    setCode: asStr(record.setCode, 80),
    addedAt: asTime(record.addedAt),
  }
}

function sanitizeParty(raw: unknown): { id: string; name: string } | null {
  if (!isRecord(raw)) return null
  const id = asStr(raw.id, 64)
  const name = asStr(raw.name, 60)
  return id ? { id, name: name ?? 'A Cardstock collector' } : null
}

/** Validate + coerce a decoded share of any kind; throws on garbage. */
export function sanitizePayload(raw: unknown): SocialPayload {
  if (!isRecord(raw)) throw new Error(NOT_SOCIAL)
  if (raw.app != null && raw.app !== MARKER) throw new Error(NOT_SOCIAL)
  const kind = raw.kind
  if (kind === 'profile') {
    const id = asStr(raw.id, 64)
    if (!id) throw new Error(NOT_SOCIAL)
    return {
      kind,
      id,
      name: asStr(raw.name, 60) ?? 'A Cardstock collector',
      note: asStr(raw.note, 400),
      scope: raw.scope === 'all' ? 'all' : 'trade',
      at: asTime(raw.at),
      cards: sanitizeSharedCards(raw.cards, PROFILE_CARD_CAP),
      wants: sanitizeSharedWants(raw.wants),
    }
  }
  if (kind === 'trade') {
    const id = asStr(raw.id, 64)
    const from = sanitizeParty(raw.from)
    if (!id || !from) throw new Error(NOT_SOCIAL)
    const offer = sanitizeSharedCards(raw.offer, TRADE_CARD_CAP)
    const want = sanitizeSharedCards(raw.want, TRADE_CARD_CAP)
    if (!offer.length && !want.length) throw new Error(NOT_SOCIAL)
    const to = isRecord(raw.to) ? { id: asStr(raw.to.id, 64), name: asStr(raw.to.name, 60) } : undefined
    return { kind, id, at: asTime(raw.at), from, to, note: asStr(raw.note, 400), offer, want }
  }
  if (kind === 'reply') {
    const id = asStr(raw.id, 64)
    const from = sanitizeParty(raw.from)
    if (!id || !from) throw new Error(NOT_SOCIAL)
    return {
      kind,
      id,
      at: asTime(raw.at),
      from,
      status: raw.status === 'accepted' ? 'accepted' : 'declined',
      note: asStr(raw.note, 400),
    }
  }
  throw new Error(NOT_SOCIAL)
}

/** Backup round-trip: validate a stored friend row. */
export function sanitizeFriendRecord(raw: unknown): Friend | null {
  if (!isRecord(raw)) return null
  const id = asStr(raw.id, 64)
  const name = asStr(raw.name, 60)
  if (!id || !name) return null
  const sourceUrl = asStr(raw.sourceUrl, 600)
  const delta = isRecord(raw.lastDelta) ? raw.lastDelta : null
  const added = delta ? clampInt(delta.added, 0, 99_999) : undefined
  const removed = delta ? clampInt(delta.removed, 0, 99_999) : undefined
  return {
    id,
    name,
    note: asStr(raw.note, 400),
    scope: raw.scope === 'all' ? 'all' : 'trade',
    addedAt: asTime(raw.addedAt),
    updatedAt: asTime(raw.updatedAt),
    exportedAt: asTime(raw.exportedAt),
    sourceUrl: sourceUrl && /^https?:\/\//i.test(sourceUrl) ? sourceUrl : undefined,
    cards: sanitizeSharedCards(raw.cards, PROFILE_CARD_CAP),
    wants: sanitizeSharedWants(raw.wants),
    lastDelta: delta && (added || removed) ? { added: added ?? 0, removed: removed ?? 0, at: asTime(delta.at) } : undefined,
  }
}

/** Backup round-trip: validate a stored trade row. */
export function sanitizeTradeRecord(raw: unknown): TradeRecord | null {
  if (!isRecord(raw)) return null
  const id = asStr(raw.id, 64)
  const friendName = asStr(raw.friendName, 60)
  if (!id || !friendName) return null
  const give = sanitizeSharedCards(raw.give, TRADE_CARD_CAP)
  const get = sanitizeSharedCards(raw.get, TRADE_CARD_CAP)
  if (!give.length && !get.length) return null
  const appliedAt = Number(raw.appliedAt)
  return {
    id,
    friendId: asStr(raw.friendId, 64) ?? '',
    friendName,
    direction: raw.direction === 'out' ? 'out' : 'in',
    status: TRADE_STATUSES.includes(raw.status as TradeStatus) ? (raw.status as TradeStatus) : 'proposed',
    createdAt: asTime(raw.createdAt),
    updatedAt: asTime(raw.updatedAt),
    note: asStr(raw.note, 400),
    give,
    get,
    appliedAt: Number.isFinite(appliedAt) && appliedAt > 0 ? appliedAt : undefined,
  }
}

/* --- encoding: link blobs & files ---------------------------------------- */

function wireEnvelope(payload: SocialPayload): Record<string, unknown> {
  return { app: MARKER, v: 1, ...payload }
}

/** Pretty JSON for file exports — the same document decodeShareText reads back. */
export function payloadFileText(payload: SocialPayload): string {
  return JSON.stringify(wireEnvelope(payload), null, 1)
}

async function deflate(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

function toB64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
  const bin = atob(b64 + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Encode a payload for a link: `D` + base64url(deflate) — `J` = plain fallback. */
export async function encodeBlob(payload: SocialPayload): Promise<string> {
  const json = JSON.stringify(wireEnvelope(payload))
  const deflated = await deflate(json)
  if (deflated) return `D${toB64url(deflated)}`
  return `J${toB64url(new TextEncoder().encode(json))}`
}

/** The app URL that carries a blob — opening it lands on the import screen. */
export function shareUrl(blob: string): string {
  return `${location.origin}${location.pathname}#/x?d=${blob}`
}

export async function decodeBlob(blob: string): Promise<SocialPayload> {
  const mode = blob[0]
  if (mode !== 'D' && mode !== 'J') throw new Error(NOT_SOCIAL)
  let json: string
  try {
    const bytes = fromB64url(blob.slice(1))
    json = mode === 'D' ? await inflate(bytes) : new TextDecoder().decode(bytes)
  } catch {
    throw new Error(NOT_SOCIAL)
  }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error(NOT_SOCIAL)
  }
  return sanitizePayload(raw)
}

/** Decode whatever a user pasted/opened: full link, bare blob, or file JSON. */
export async function decodeShareText(text: string): Promise<SocialPayload> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error(NOT_SOCIAL)
  if (trimmed.startsWith('{')) {
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      throw new Error(NOT_SOCIAL)
    }
    // A sync server wraps the payload ({updatedAt, payload}) — unwrap it so a
    // binder endpoint can be pasted in like any other link.
    if (isRecord(raw) && raw.kind == null && isRecord(raw.payload)) raw = raw.payload
    return sanitizePayload(raw)
  }
  const fromParam = /[?&]d=([A-Za-z0-9_-]+)/.exec(trimmed)?.[1]
  if (fromParam) return decodeBlob(fromParam)
  if (/^[DJ][A-Za-z0-9_-]+$/.test(trimmed)) return decodeBlob(trimmed)
  throw new Error(NOT_SOCIAL)
}

/** A pasted string that's a hosted-file URL rather than a share link. */
export function looksLikeHostedUrl(text: string): boolean {
  const trimmed = text.trim()
  return /^https?:\/\//i.test(trimmed) && !/[?&]d=/.test(trimmed)
}

/** Fetch a hosted snapshot (gist raw URL etc.) and decode it as a profile. */
export async function fetchSharedProfile(url: string): Promise<ProfilePayload> {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('Enter a full link (https://…)')
  let text: string
  try {
    const res = await fetch(trimmed, { credentials: 'omit', cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } catch {
    throw new Error('Could not fetch that link — the host must allow cross-site reads (a GitHub Gist raw link works)')
  }
  const payload = await decodeShareText(text)
  if (payload.kind !== 'profile') throw new Error('That link holds a trade, not a binder')
  return payload
}
