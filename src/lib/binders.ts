/**
 * Binders: the physical-location half of the collection.
 *
 * A binder is a label, not a container. Cards point at it
 * (`CollectionItem.binderId`) and it holds nothing itself, so the two things
 * that can go wrong are a name that is not really a name and a link that
 * points at the wrong app. Both are decided here, purely, and tested in
 * `tests/unit/binders.test.mjs`.
 *
 * The link is the load-bearing part. A printed QR outlives the session that
 * made it — it is glued to a binder on a shelf — so it must be a plain URL to
 * THIS deployment that any phone camera can open, with no account, no server
 * and no lookup. `#/binders/<id>` is exactly that: the id is local, the route
 * is local, and a stranger who scans it gets whatever their own app has,
 * which is nothing. There is no way for it to leak a collection, because it
 * carries no collection.
 */

import type { Binder } from './types'

/** Long enough for "Pokémon rares — 2026", short enough to print on a label. */
export const BINDER_NAME_MAX = 48
/** Free text under the name on the label. */
export const BINDER_NOTE_MAX = 80
/** Nobody has a binder with a thousand pages; past this it is bad data. */
export const BINDER_PAGE_MAX = 999

/**
 * Ids ride a printed QR and get typed back by hand when a sticker is scuffed,
 * so they stay short and unambiguous: lowercase base32 without the letters
 * that misread as digits. 10 characters is ~49 bits — collision-free for a
 * person's binders forever, and it keeps a full label URL inside a small
 * symbol that still scans from across a table.
 */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const ID_LENGTH = 10

export function binderId(): string {
  const bytes = new Uint8Array(ID_LENGTH)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < ID_LENGTH; i++) bytes[i] = Math.floor(Math.random() * 256)
  let out = ''
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length]
  return out
}

/** True for an id this app could have minted — used to reject junk in a route. */
export function isBinderId(value: string): boolean {
  return /^[a-z0-9]{4,32}$/.test(value)
}

/** Control characters, DEL included, as typed or pasted in. */
const CONTROL = /[\u0000-\u001f\u007f]+/g

/**
 * A name the user typed, made safe to render and to print. Control characters
 * and newlines go (a label is one line), whitespace collapses, and the length
 * is capped rather than rejected — a long name is a slip, not an error.
 */
export function cleanBinderName(raw: string): string {
  return raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, BINDER_NAME_MAX)
}

export function cleanBinderNote(raw: string): string {
  return raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, BINDER_NOTE_MAX)
}

/** A page number off a scan or a CSV, or nothing. */
export function cleanBinderPage(raw: unknown): number | undefined {
  const page = Math.floor(Number(raw))
  return Number.isFinite(page) && page >= 1 && page <= BINDER_PAGE_MAX ? page : undefined
}

/**
 * Validate a binder off a backup, a vault pull or any other outside document.
 * Same posture as every other sanitizer here: coerce what is coercible, drop
 * what is not, never trust a field because the file claimed to be ours.
 */
export function sanitizeBinder(raw: unknown): Binder | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (!id || id.length > 64) return null
  const name = cleanBinderName(typeof row.name === 'string' ? row.name : '')
  const note = cleanBinderNote(typeof row.note === 'string' ? row.note : '')
  const createdAt = Number(row.createdAt)
  const updatedAt = Number(row.updatedAt)
  const created = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now()
  return {
    id,
    name: name || 'Untitled binder',
    note: note || undefined,
    createdAt: created,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : created,
  }
}

/**
 * The URL a binder's QR code carries.
 *
 * Built from the app's own location so a label printed from the deployed site
 * points at the deployed site, one printed from a self-hosted copy points
 * there, and neither hardcodes a domain that can move. The id rides the
 * FRAGMENT, where the router reads it — a printed label has to work offline,
 * and a fragment is never sent to a server even when one is listening.
 */
export function binderUrl(id: string, base?: string): string {
  const here = typeof location !== 'undefined' ? location.origin + location.pathname : ''
  return `${(base ?? here).replace(/[?#].*$/, '')}#/binders/${encodeURIComponent(id)}`
}

/**
 * What gets printed under the QR as a fallback: the short code, in a form a
 * person can read out or type into the app if the sticker is too scuffed to
 * scan. Grouped in fives the way a licence key is, for exactly that reason.
 */
export function binderCode(id: string): string {
  return id.toUpperCase().replace(/(.{5})(?=.)/g, '$1-')
}

/** Undo `binderCode` — what a user types back in, in whatever case. */
export function parseBinderCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Pages are 1-based, because that is how a person counts them. */
export function pageLabel(page: number | undefined): string {
  return page != null && page > 0 ? `Page ${page}` : 'Unpaged'
}

/** Group rows by binder page, in page order, with the unpaged ones last. */
export function byPage<T extends { binderPage?: number }>(rows: T[]): { page: number | undefined; rows: T[] }[] {
  const groups = new Map<number, T[]>()
  const unpaged: T[] = []
  for (const row of rows) {
    const page = cleanBinderPage(row.binderPage)
    if (page == null) unpaged.push(row)
    else groups.set(page, [...(groups.get(page) ?? []), row])
  }
  const out = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, rows]) => ({ page: page as number | undefined, rows }))
  if (unpaged.length) out.push({ page: undefined, rows: unpaged })
  return out
}
