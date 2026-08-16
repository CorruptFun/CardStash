/**
 * Binders the user builds by hand, and what they become on the wire.
 *
 * A `CustomBinder` is a named selection of copies the user owns, with its own
 * audience: private, friends, or any signed-in collector. The whole-collection
 * binder (`shareScope` on the Friends screen) is untouched and still does what
 * it always did — these sit beside it. Read decision 26 before changing what
 * a visibility means.
 *
 * **Rows point at collection rows, not at cards.** `resolveBinderRows` is where
 * that is paid off: finish, condition, grade and price all come off the
 * `CollectionItem`, so a binder always shows the copy the user actually owns
 * and a card patch that fixes a picture fixes it here too, with no fourth
 * denormalized `Card` to keep in step. A row whose item is gone is dropped —
 * `pruneBinderCards` removes them for good, this just refuses to render one.
 *
 * Pure: no Dexie, no network. The writes are in `db.ts`, the transport is in
 * `socialcloud.ts`.
 */

import { itemToSharedCard } from './social'
import { itemUnitPrice } from './prices'
import type { BinderCard, BinderVisibility, CollectionItem, CustomBinder, SharedCard } from './types'

/** One binder row joined to the copy it refers to. */
export interface BinderRow {
  row: BinderCard
  item: CollectionItem
}

/**
 * Join a binder's rows to the collection, dropping the orphans.
 *
 * Quantities are clamped to what the collection still holds: a user who put
 * four copies in a binder and then traded three away must not publish a claim
 * to four. The clamp is here as well as in `addToBinder` because the
 * collection can shrink long after the binder row was written, and a friend
 * acting on a stale claim is the failure this prevents.
 */
export function resolveBinderRows(rows: BinderCard[], items: CollectionItem[]): BinderRow[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const out: BinderRow[] = []
  for (const row of rows) {
    const item = byId.get(row.itemId)
    if (!item || item.qty <= 0) continue
    out.push({ row: { ...row, qty: Math.min(row.qty, item.qty) }, item })
  }
  return out
}

/** The cards a binder share carries. Opened sealed products never travel. */
export function binderSharedCards(rows: BinderRow[], tradeable: boolean): SharedCard[] {
  return rows
    .filter(({ item }) => item.opened !== true)
    .map(({ row, item }) =>
      // `forTrade` on the wire is what the binder says is available, not what
      // the collection row happens to be flagged as: a tradeable binder is the
      // user saying "these copies, these many". An untradeable one publishes
      // zero, so a viewer sees the cards and no offer.
      itemToSharedCard(item, row.qty, tradeable ? row.qty : 0),
    )
}

export function binderQty(rows: BinderRow[]): number {
  return rows.reduce((sum, { row }) => sum + row.qty, 0)
}

export function binderValue(rows: BinderRow[]): number {
  let total = 0
  for (const { row, item } of rows) total += (itemUnitPrice(item) ?? 0) * row.qty
  return Math.round(total * 100) / 100
}

/* --- what a visibility means, in the words the UI uses -------------------- */

export const VISIBILITY_LABEL: Record<BinderVisibility, string> = {
  private: 'Private',
  friends: 'Friends',
  public: 'Public',
}

/**
 * The sentence under the control. Each one names the actual audience rather
 * than describing privacy in the abstract — the same standard the audience
 * banner in `SocialPanel` is held to, and for the same reason: someone
 * flipping this must know which thing they just did.
 */
export const VISIBILITY_BLURB: Record<BinderVisibility, string> = {
  private: 'Only you. Nothing is uploaded — you can still hand someone a link or a file yourself.',
  friends: 'Collectors you have accepted as friends. Never strangers.',
  public: 'Any signed-in collector can find and read it. Not the open web — nobody signed out sees anything.',
}

/** A binder at this visibility is uploaded at all. */
export const isPublished = (binder: Pick<CustomBinder, 'visibility'>): boolean => binder.visibility !== 'private'

/**
 * A binder at this visibility enters the GLOBAL want index.
 *
 * Both halves are required, and keeping them separate is the point: a
 * friends-only binder is never globally matchable (the invariant migration
 * 0003 states for the main binder, applied here), and a public binder that is
 * not marked tradeable is a display case rather than an offer.
 */
export const isDiscoverable = (binder: Pick<CustomBinder, 'visibility' | 'tradeable'>): boolean =>
  binder.visibility === 'public' && binder.tradeable

/** "12 cards · $340 · public, for trade" — the one-line summary in lists. */
export function binderSummary(binder: CustomBinder, cards: number): string {
  const parts = [`${cards} ${cards === 1 ? 'card' : 'cards'}`, VISIBILITY_LABEL[binder.visibility].toLowerCase()]
  if (binder.tradeable && binder.visibility !== 'private') parts.push('for trade')
  return parts.join(' · ')
}

/* --- the physical half: pages, and the label you stick on the cover -------- */

/**
 * A binder is a selection of copies; for most people it is also an *object*,
 * on a shelf, with pages. These are the two things that follow from that: a
 * page number a scan can record, and a printed label that leads back here.
 *
 * The link is the load-bearing part. A printed QR outlives the session that
 * made it — it is glued to a binder on a shelf — so it must be a plain URL to
 * THIS deployment that any phone camera can open, with no account, no server
 * and no lookup. `#/binders/<id>` is exactly that: the id is local, the route
 * is local, and a stranger who scans it gets whatever their own app has, which
 * is nothing. There is no way for it to leak a collection, because it carries
 * no collection — not even for a `public` binder, whose contents still travel
 * only through the paths in `socialcloud.ts`.
 */

/** Name cap, matching what `createBinder` stores. */
export const BINDER_NAME_MAX = 60
/** Nobody has a binder with a thousand pages; past this it is bad data. */
export const BINDER_PAGE_MAX = 999

/** A page number off a scan, a CSV or a backup, or nothing. */
export function cleanBinderPage(raw: unknown): number | undefined {
  const page = Math.floor(Number(raw))
  return Number.isFinite(page) && page >= 1 && page <= BINDER_PAGE_MAX ? page : undefined
}

/** Pages are 1-based, because that is how a person counts them. */
export function pageLabel(page: number | undefined): string {
  return page != null && page > 0 ? `Page ${page}` : 'Unpaged'
}

/** Group rows by binder page, in page order, with the unpaged ones last. */
export function byPage<T>(
  rows: T[],
  pageOf: (row: T) => number | undefined,
): { page: number | undefined; rows: T[] }[] {
  const groups = new Map<number, T[]>()
  const unpaged: T[] = []
  for (const row of rows) {
    const page = cleanBinderPage(pageOf(row))
    if (page == null) unpaged.push(row)
    else groups.set(page, [...(groups.get(page) ?? []), row])
  }
  const out = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, rows]) => ({ page: page as number | undefined, rows }))
  if (unpaged.length) out.push({ page: undefined, rows: unpaged })
  return out
}

/**
 * The URL a binder's QR label carries.
 *
 * Built from the app's own location so a label printed from the deployed site
 * points at the deployed site, one printed from a self-hosted copy points
 * there, and neither hardcodes a domain that can move. The id rides the
 * FRAGMENT, where the router reads it — a printed label has to work offline,
 * and a fragment is never sent to a server even where one is listening. Any
 * query the current URL happens to carry (`?via=` from a referral link, say)
 * is stripped: it is not part of this binder.
 */
export function binderUrl(id: string, base?: string): string {
  const here = typeof location !== 'undefined' ? location.origin + location.pathname : ''
  return `${(base ?? here).replace(/[?#].*$/, '')}#/binders/${encodeURIComponent(id)}`
}

/**
 * The short code printed under the QR.
 *
 * A FINGERPRINT, not a typing target: binder ids are UUIDs, and nobody is
 * keying 36 characters off a sticker. What this is for is the moment the QR
 * will not scan and you are holding two binders — the name is printed above
 * it, and this tells two binders with the same name apart. Eight hex digits in
 * two groups is enough for that and short enough to read out loud.
 */
export function binderCode(id: string): string {
  const flat = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()
  return flat.replace(/(.{4})(?=.)/g, '$1-')
}
