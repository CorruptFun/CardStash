/**
 * Cards the catalogs got wrong, and cards the catalogs never had.
 *
 * Every other module in this folder assumes a card exists somewhere upstream:
 * Scryfall knows every Magic card, TCGplayer knows every Riftbound product.
 * Two things break that assumption constantly, and neither is exotic:
 *
 *   * **A card with no picture.** TCGCSV rows ship without an image more often
 *     than not, promos and Japanese prints frequently have none, and a card
 *     with no art is the one thing users read as "this app is broken" — the
 *     name is right there, but a binder of grey rectangles is not a binder.
 *   * **A card in no catalog at all.** Regional promos, prereleases before the
 *     API catches up, error prints, playtest cards, anything sealed nobody
 *     listed. Today the scan fails, search finds nothing, and the collection
 *     simply cannot hold the card the user is holding.
 *
 * So the user gets to fill the gap: attach a photo, type what the card is, and
 * keep it. A patch is an OVERLAY, never a replacement — `mergePatch` lays the
 * user's fields over whatever the catalog said, so tomorrow's price refresh
 * still updates prices and the user's photo still wins. Only the keys they
 * actually filled in are stored; an empty string means "I did not say", not
 * "blank it".
 *
 * Two rules run through everything here, both borrowed from `sports.ts`, which
 * has been synthesizing cards from the card itself since it shipped:
 *
 *   1. **The id is the contract.** A patch keys on `${game}:${apiId}`. For a
 *      card that exists upstream that is the catalog's own id and nothing here
 *      invents anything. For a card that exists nowhere, `customSlug` computes
 *      an id from the printed facts, so two devices that describe the same card
 *      the same way agree on what it is called — which is what makes trades,
 *      dedup and the shared index below possible at all.
 *   2. **Refusing to invent.** A custom card carries NO prices, ever. There is
 *      no feed for a card no catalog lists, and a made-up number about
 *      somebody's money is worse than an empty one. Value comes from
 *      `CollectionItem.marketValue`, exactly as it does for sports.
 *
 * Everything here is pure and node-tested (`tests/unit/cardpatch.test.mjs`).
 * The Dexie side lives in `db.ts`, the image encoder in `cardimage.ts`, and the
 * shared index client in `cardsource.ts`.
 */

import type { Card, CardFields, CardPatch, Game, Prices } from './types'
import { GAMES } from './games'

/** Marks an apiId as locally authored rather than a catalog's. */
export const CUSTOM_PREFIX = 'custom-'

/**
 * Field length caps. These are not defensive trivia: a patch travels to the
 * shared index and comes back from it, so every string is untrusted on the way
 * in (decision 7) and must not be able to bloat a row or a payload.
 */
const MAX_NAME = 160
const MAX_SHORT = 40
const MAX_TEXT = 1200

/** A data URL big enough for a legible card, small enough to sync. */
export const MAX_IMAGE_BYTES = 220_000

/** Which `Card` keys a patch may overlay, and how long each may be. */
const FIELD_CAPS: Record<keyof CardFields, number> = {
  name: MAX_NAME,
  setName: MAX_NAME,
  setCode: MAX_SHORT,
  number: MAX_SHORT,
  rarity: MAX_SHORT,
  releasedAt: 10,
  typeLine: MAX_NAME,
  subtext: MAX_TEXT,
}

const FIELD_KEYS = Object.keys(FIELD_CAPS) as (keyof CardFields)[]

function str(value: unknown, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined
  // Collapse whitespace before capping, so a padded string is not stored as a
  // different value from the same text typed normally.
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, cap)
  return clean || undefined
}

/** YYYY-MM-DD, or just a year the user typed — anything else is dropped. */
function releaseDate(value: unknown): string | undefined {
  const text = str(value, 10)
  if (!text) return undefined
  if (/^\d{4}$/.test(text)) return `${text}-01-01`
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined
}

/**
 * Clean a set of user- or server-supplied fields down to what may be stored.
 * Unknown keys are dropped rather than passed through: this is the one place
 * that decides what a patch is allowed to say about a card.
 */
export function sanitizeFields(raw: unknown): CardFields {
  const input = (raw ?? {}) as Record<string, unknown>
  const out: CardFields = {}
  for (const key of FIELD_KEYS) {
    const value = key === 'releasedAt' ? releaseDate(input[key]) : str(input[key], FIELD_CAPS[key])
    if (value != null) out[key] = value
  }
  return out
}

/** Is there anything in this patch worth keeping? */
export function patchIsEmpty(patch: Pick<CardPatch, 'image' | 'fields'>): boolean {
  return !patch.image && !Object.keys(patch.fields ?? {}).length
}

/**
 * Accept an image only if it is an inline data URL of a raster format.
 *
 * A patch's image is rendered by `<img src>` wherever a card is shown, so
 * anything that could be a remote fetch or a script carrier is refused here
 * rather than at the twelve places that render one. `data:` keeps the app
 * local-first — a patched card works offline like every other card does — and
 * excludes `javascript:`, `blob:` (revoked on reload) and SVG (which can carry
 * script) in one rule.
 */
export function sanitizeImage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return undefined
  return value.length > MAX_IMAGE_BYTES ? undefined : value
}

/**
 * A catalog's own image URL, remembered so undo can put it back.
 *
 * `https:` only, and deliberately a different rule from `sanitizeImage`: this
 * value is written straight back into a card's `imageSmall` when a patch is
 * removed, so it is every bit as much an `<img src>` as the patch image is —
 * it just comes from the other direction, and a catalog URL is exactly what
 * `sanitizeImage` is built to refuse.
 */
function catalogImage(raw: unknown): string | undefined {
  const value = str(raw, 2000)
  return value && /^https:\/\//.test(value) ? value : undefined
}

function isGame(value: unknown): value is Game {
  return typeof value === 'string' && (GAMES as readonly string[]).includes(value)
}

/**
 * A whole patch from anywhere untrusted — an import, a backup, the shared
 * index. Returns null when there is nothing usable left, so a caller can treat
 * "garbage" and "empty" the same way.
 */
export function sanitizePatch(raw: unknown): CardPatch | null {
  const input = (raw ?? {}) as Record<string, unknown>
  const cardId = str(input.cardId, 120)
  const game = isGame(input.game) ? input.game : undefined
  if (!cardId || !game) return null
  // The id carries the game, so a row claiming otherwise is malformed rather
  // than merely odd — trusting it would file the card under the wrong game.
  if (!cardId.startsWith(`${game}:`)) return null
  const patch: CardPatch = {
    cardId,
    game,
    image: sanitizeImage(input.image),
    imageHash: str(input.imageHash, 64),
    fields: sanitizeFields(input.fields),
    base: sanitizeFields(input.base),
    baseImage: catalogImage(input.baseImage),
    baseImageLarge: catalogImage(input.baseImageLarge),
    custom: input.custom === true || undefined,
    origin: input.origin === 'community' ? 'community' : 'local',
    shared: input.shared === true || undefined,
    sharedAt: typeof input.sharedAt === 'number' && input.sharedAt > 0 ? input.sharedAt : undefined,
    updatedAt: typeof input.updatedAt === 'number' && input.updatedAt > 0 ? input.updatedAt : Date.now(),
  }
  if (!patch.image) delete patch.imageHash
  return patchIsEmpty(patch) ? null : patch
}

/**
 * Lay a patch over a card.
 *
 * Field order matters and is the whole point: the patch wins on anything the
 * user filled in, the catalog keeps everything else, and prices are never
 * touched. `imageLarge` and `imageSmall` both become the user's photo — there
 * is only one of it, and a thumbnail that differs from the picture the sheet
 * shows would look like two different cards.
 */
export function mergePatch(card: Card, patch: CardPatch | undefined): Card {
  if (!patch) return card
  const fields = patch.fields ?? {}
  const merged: Card = { ...card, ...fields }
  if (patch.image) {
    merged.imageSmall = patch.image
    merged.imageLarge = patch.image
  }
  merged.patched = true
  return merged
}

/**
 * Peel a patch back off a card.
 *
 * The counterpart to `mergePatch`, and the reason `CardPatch.base` exists at
 * all. A stored `Card` is denormalized — a collection row carries its own copy
 * — so once a patch is written over one, the catalog's original values are
 * gone from that copy. "Refresh it from the source" is not an answer: undo has
 * to work on a plane, and a card no catalog lists has no source to ask.
 *
 * So a patch remembers what it covered, and undo puts exactly that back. Keys
 * the catalog never had come back as `undefined`, which is the honest restore:
 * the field was blank before the user typed in it.
 */
export function unmergePatch(card: Card, patch: CardPatch | undefined): Card {
  if (!patch) return card
  const bare: Card = { ...card }
  delete bare.patched
  for (const key of Object.keys(patch.fields ?? {}) as (keyof CardFields)[]) {
    const original = patch.base?.[key]
    if (original == null) delete bare[key]
    else bare[key] = original
  }
  if (patch.image && bare.imageSmall === patch.image) {
    bare.imageSmall = patch.baseImage
    bare.imageLarge = patch.baseImageLarge ?? patch.baseImage
  }
  return bare
}

/**
 * What the card said before an edit, for exactly the keys the edit touches.
 *
 * Only those keys: storing the whole card would freeze today's catalog into
 * the patch and make undo restore a stale set name months later.
 */
export function baseFields(card: Card, diff: CardFields): CardFields {
  const base: CardFields = {}
  const current = fieldsFromCard(card)
  for (const key of Object.keys(diff) as (keyof CardFields)[]) {
    const value = current[key]
    if (value != null) base[key] = value
  }
  return base
}

/** Apply patches to a list, leaving unpatched cards untouched. */
export function mergePatches(cards: Card[], index: Map<string, CardPatch>): Card[] {
  if (!index.size) return cards
  return cards.map((card) => mergePatch(card, index.get(card.id)))
}

/** A card whose id was minted here rather than by a catalog. */
export function isCustomCard(card: Pick<Card, 'apiId'>): boolean {
  return card.apiId.startsWith(CUSTOM_PREFIX)
}

function slugPart(value: string | number | undefined): string {
  if (value == null) return ''
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
}

/**
 * The id for a card that exists in no catalog.
 *
 * Same reasoning as `sportsSlug`, and the same warning: changing this renames
 * every custom card anyone owns. Set and number come first because they are
 * what actually identifies a printing; the name is included because a custom
 * card often has neither, and two different cards from the same unlisted set
 * must not collide into one row.
 */
export function customSlug(fields: CardFields): string {
  const parts = [
    slugPart(fields.setCode ?? fields.setName) || 'noset',
    slugPart(fields.number) || 'nn',
    slugPart(fields.name) || 'unnamed',
  ]
  return `${CUSTOM_PREFIX}${parts.join('-')}`
}

/** A card id for a locally authored card. */
export function customCardId(game: Game, fields: CardFields): string {
  return `${game}:${customSlug(fields)}`
}

const NO_PRICES = (): Prices => ({ best: null, bestFoil: null, entries: [], updatedAt: Date.now() })

/**
 * Synthesize the `Card` for a card the user described themselves.
 *
 * It carries no prices for the reason in the module header, and it is marked
 * `patched` so the UI can say where it came from instead of implying a catalog
 * stands behind it.
 */
export function customCard(game: Game, fields: CardFields, image?: string): Card {
  const clean = sanitizeFields(fields)
  const apiId = customSlug(clean)
  return {
    id: `${game}:${apiId}`,
    game,
    apiId,
    name: clean.name ?? 'Untitled card',
    setCode: clean.setCode,
    setName: clean.setName,
    number: clean.number,
    rarity: clean.rarity,
    releasedAt: clean.releasedAt,
    typeLine: clean.typeLine,
    subtext: clean.subtext,
    imageSmall: image,
    imageLarge: image,
    prices: NO_PRICES(),
    links: {},
    patched: true,
  }
}

/** The patch that records a custom card, so the card survives as data. */
export function customPatch(game: Game, fields: CardFields, image?: string): CardPatch {
  const clean = sanitizeFields(fields)
  return {
    cardId: customCardId(game, clean),
    game,
    image,
    fields: clean,
    custom: true,
    origin: 'local',
    updatedAt: Date.now(),
  }
}

/** The fields a card already has, as the editor's starting point. */
export function fieldsFromCard(card: Card): CardFields {
  return sanitizeFields({
    name: card.name,
    setName: card.setName,
    setCode: card.setCode,
    number: card.number,
    rarity: card.rarity,
    releasedAt: card.releasedAt,
    typeLine: card.typeLine,
    subtext: card.subtext,
  })
}

/**
 * Only the fields that actually differ from what the card already says.
 *
 * Storing the rest would freeze today's catalog values into the patch: the set
 * name would stop tracking a correction upstream, and a re-print's rarity fix
 * would never arrive. A patch should be as small as the user's actual edit.
 */
export function fieldsDiff(card: Card, edited: CardFields): CardFields {
  const clean = sanitizeFields(edited)
  const base = fieldsFromCard(card)
  const out: CardFields = {}
  for (const key of FIELD_KEYS) {
    const value = clean[key]
    if (value != null && value !== base[key]) out[key] = value
  }
  return out
}

/**
 * Does this card need help? True when there is no picture to show.
 *
 * The scan, search and sheet all ask this to decide whether to offer the
 * editor, so "missing" is defined once: no image URL at all. A URL that
 * 404s at render time is handled by `CardImg`'s own error state.
 */
export function needsImage(card: Pick<Card, 'imageSmall' | 'imageLarge'>): boolean {
  return !card.imageSmall && !card.imageLarge
}

/**
 * A stable fingerprint of image bytes — FNV-1a over the base64 body.
 *
 * Used to dedupe submissions to the shared index (the same photo re-sent from
 * two devices is one contribution) and to skip re-uploading an unchanged
 * image. Not a cryptographic hash and nothing depends on it being one.
 */
export function imageHash(dataUrl: string): string {
  const body = dataUrl.slice(dataUrl.indexOf(',') + 1)
  let hash = 0x811c9dc5
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}${body.length.toString(16)}`
}
