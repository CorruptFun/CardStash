/**
 * The shared card index: what this app knows about cards that no catalog does.
 *
 * `cardpatch.ts` lets one user fix one card on one device. This module is the
 * other half — the fixes people choose to contribute become the answer the
 * next person gets automatically, which is the difference between a private
 * workaround and Cardstock being a source of card data in its own right.
 * Schema, grants and the reasoning behind both: `supabase/migrations/0013`.
 *
 * FOUR RULES, all load-bearing:
 *
 * 1. **Lookups are anonymous and stay that way.** They go out with the
 *    publishable key as `anon` and NEVER the session JWT, exactly as
 *    diagnostics do (decision 20). What card someone is looking at is not
 *    something this app should be able to tie to an account, and the lookup
 *    must work signed out because the entire free path is signed out.
 * 2. **Contributing is opt-in, per install and per card.** `cardSourceShare`
 *    is off by default and the editor asks again on the card itself. A photo
 *    of a card is a photo the user took; publishing it is a decision, not a
 *    side effect of fixing their own binder. Compare `socialConfigured()` vs
 *    `socialPublishing()` — same shape, same reason.
 * 3. **Everything that comes back is untrusted.** It is a stranger's text and
 *    a stranger's image, so it goes through `sanitizePatch` — the same door a
 *    pasted link goes through (decision 7). Nothing from here is stored, shown
 *    or re-shared without it.
 * 4. **A local patch always beats a fetched one.** If the user has said what a
 *    card is, no download may overwrite it. Community rows land as
 *    `origin: 'community'` and are skipped whenever a local row exists.
 *
 * Dormant with no project configured, like every other cloud feature here:
 * with `CLOUD_AVAILABLE` false nothing in this file makes a request and the
 * app behaves exactly as it did before it existed.
 */

import { track } from './analytics'
import { authHeaders, CloudError, freshToken, isSignedIn, readError } from './authsession'
import { customCard, imageHash, needsImage, sanitizePatch } from './cardpatch'
import { CLOUD_AVAILABLE, SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'
import { db, deletePatch, kvGet, kvPut, patchFor, savePatch } from './db'
import { settings } from './settings'
import type { Card, CardPatch, Game } from './types'

/** One request may ask about this many cards; the SQL caps at the same number. */
const LOOKUP_BATCH = 100

/**
 * How long a "nobody has this card either" answer is trusted.
 *
 * Long enough that scrolling a collection of imageless cards does not re-ask
 * on every screen, short enough that a card someone fixed today shows up for
 * everyone else this week. Misses are what get cached; a hit becomes a local
 * patch row and is never asked about again.
 */
const MISS_TTL_MS = 3 * 24 * 3_600_000
const MISS_KEY = 'cardsource:misses'

/**
 * Consecutive lookup failures before the index is stood down for the session.
 *
 * Without this, "the index is unreachable" costs one failed request per
 * imageless card, on every screen, forever — a collection of uncatalogued
 * promos would quietly hammer a server that is down, or one that has not been
 * migrated yet. `psa.ts` stands down on a 429 for the same reason.
 *
 * Two failures rather than one, because a single request can lose a race with
 * a phone changing networks; two in a row is a server, not a tunnel.
 */
const FAILURES_BEFORE_STANDDOWN = 2
let lookupFailures = 0
let stoodDown = false

/**
 * A stand-down lasts the session and is never persisted.
 *
 * The recovery story is "open the app again", which is the honest one for a
 * feature nobody is waiting on: the alternative — a timer that retries — spends
 * a user's battery re-asking a question whose answer changes on our schedule,
 * not theirs.
 */
function noteLookupFailure(fatal: boolean): void {
  lookupFailures++
  if (fatal || lookupFailures >= FAILURES_BEFORE_STANDDOWN) stoodDown = true
}

function noteLookupSuccess(): void {
  lookupFailures = 0
}

/** A build with no Supabase project never contacts anything. */
export function cardSourceAvailable(): boolean {
  return CLOUD_AVAILABLE
}

/** Are we allowed to ask the index about cards, and is it worth asking? */
export function cardSourceLookupOn(): boolean {
  return CLOUD_AVAILABLE && settings().cardSourceLookup && !stoodDown
}

/** Is this device set up to contribute — opted in, and signed in to attribute it? */
export function cardSourceSharing(): boolean {
  return CLOUD_AVAILABLE && settings().cardSourceShare && isSignedIn()
}

/* ------------------------------------------------------------------ transport */

/**
 * An anonymous RPC call: publishable key, no Authorization header.
 *
 * The missing header is the point — see rule 1. Do not "fix" this by reusing
 * `authHeaders()` because a signed-in user happens to have a token handy.
 */
class MissingFunction extends CloudError {}

async function anonRpc<T>(fn: string, body: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const message = await readError(res, 'The card index did not answer')
    // 404 from PostgREST means the RPC is not in the schema — a project that
    // has not had `0013_card_source.sql` applied, which is the state every
    // client is in on the day this ships. That is not a transient failure and
    // must not be retried card after card, so it stands the index down at once.
    if (res.status === 404) throw new MissingFunction(message)
    throw new CloudError(message)
  }
  return (await res.json()) as T
}

/** An attributed RPC call — contributing and flagging only. */
async function authedRpc<T>(fn: string, body: unknown): Promise<T> {
  const token = await freshToken()
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new CloudError(explain(await readError(res, 'The card index refused that')))
  return (await res.json()) as T
}

/** Turn the SQL's raise-exception names into something a person can act on. */
function explain(message: string): string {
  if (/not_signed_in/.test(message)) return 'Sign in to contribute card data'
  if (/rate_limited/.test(message)) return "You've contributed a lot today — try again tomorrow"
  if (/empty_submission/.test(message)) return 'Add a picture or some details first'
  if (/bad_card_id/.test(message)) return 'That card could not be identified'
  return message
}

/* --------------------------------------------------------------------- reads */

interface RemoteRow {
  card_id?: unknown
  game?: unknown
  fields?: unknown
  image?: unknown
  image_hash?: unknown
  custom?: unknown
  updated_at?: unknown
}

/** A server row, through the same sanitizer a pasted link goes through. */
function rowToPatch(row: RemoteRow): CardPatch | null {
  return sanitizePatch({
    cardId: row.card_id,
    game: row.game,
    fields: row.fields,
    image: row.image,
    imageHash: row.image_hash,
    custom: row.custom === true,
    origin: 'community',
    updatedAt: Date.parse(String(row.updated_at ?? '')) || Date.now(),
  })
}

async function loadMisses(): Promise<Set<string>> {
  const cached = await kvGet<string[]>(MISS_KEY, MISS_TTL_MS)
  return new Set(cached ?? [])
}

/**
 * Ask the index about cards that have no picture, and keep what comes back.
 *
 * Answers are stored as local patch rows rather than held in memory: a card
 * the index knew about must still have its picture on the next flight, in the
 * next tunnel, and after a reload. This is a cache that makes the app MORE
 * offline-capable, not less.
 *
 * Returns the cards it managed to fill, already merged.
 */
export async function fillMissingImages(cards: Card[]): Promise<Card[]> {
  if (!cardSourceLookupOn() || !cards.length) return []
  const misses = await loadMisses()
  const wanted = cards.filter((card) => needsImage(card) && !patchFor(card.id) && !misses.has(card.id)).slice(0, LOOKUP_BATCH)
  if (!wanted.length) return []

  let rows: RemoteRow[]
  try {
    rows = await anonRpc<RemoteRow[]>('lookup_card_data', { p_ids: wanted.map((card) => card.id) })
    noteLookupSuccess()
  } catch (err) {
    // A card index that is down is not an error the user needs to hear about:
    // the card still shows, just without the picture it never had. It IS a
    // reason to stop asking — see noteLookupFailure.
    noteLookupFailure(err instanceof MissingFunction)
    return []
  }

  const filled: Card[] = []
  const found = new Set<string>()
  for (const row of Array.isArray(rows) ? rows : []) {
    const patch = rowToPatch(row)
    if (!patch) continue
    // Rule 4: never overwrite what this user said themselves.
    if (patchFor(patch.cardId)?.origin === 'local') continue
    const saved = await savePatch(patch)
    if (!saved) continue
    found.add(patch.cardId)
    const card = cards.find((c) => c.id === patch.cardId)
    if (card) filled.push({ ...card, imageSmall: patch.image ?? card.imageSmall, imageLarge: patch.image ?? card.imageLarge })
  }

  // Remember the cards nobody has, so a binder full of imageless promos is one
  // request every few days rather than one per scroll.
  const newMisses = wanted.filter((card) => !found.has(card.id)).map((card) => card.id)
  if (newMisses.length) {
    const all = [...misses, ...newMisses]
    // Bounded: this is a negative cache, not a log.
    await kvPut(MISS_KEY, all.slice(-2000))
  }
  if (found.size) track('card_source', { got: found.size, asked: wanted.length })
  return filled
}

/* ----------------------------------------------------------- the render queue */

/**
 * Cards asked about in this session, so the same card on ten screens is one
 * question. Separate from the persisted miss cache: this also covers hits
 * (already saved as patches) and in-flight ids.
 */
const asked = new Set<string>()
let queue: Card[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * "This card is being shown and has no picture."
 *
 * Called from `CardImg`, which is the one place that knows what a user is
 * actually looking at. Driving the lookup off render rather than off a
 * background sweep is deliberate: it means the app asks about the twenty cards
 * on screen instead of the eight thousand in a collection, it costs nothing
 * for users whose cards all have art, and it stops entirely when the app is
 * closed. Debounced, deduped, and capped by `fillMissingImages` itself.
 */
export function noteMissingImage(card: Card): void {
  if (!cardSourceLookupOn() || asked.has(card.id) || patchFor(card.id)) return
  asked.add(card.id)
  queue.push(card)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const batch = queue
    queue = []
    void fillMissingImages(batch).catch(() => {})
  }, FLUSH_DELAY_MS)
}

/** Long enough for a scroll to settle, short enough to feel like loading. */
const FLUSH_DELAY_MS = 400

/**
 * Cards that exist ONLY in the shared index — the ones no catalog lists.
 *
 * Merged into search results so a user who scans a promo nobody has catalogued
 * finds the card someone else already described, instead of typing it in for
 * the thousandth time.
 */
export async function searchSharedCards(game: Game, query: string): Promise<Card[]> {
  if (!cardSourceLookupOn() || query.trim().length < 2) return []
  try {
    const rows = await anonRpc<RemoteRow[]>('search_card_data', { p_game: game, p_query: query.trim() })
    noteLookupSuccess()
    const cards: Card[] = []
    for (const row of Array.isArray(rows) ? rows : []) {
      const patch = rowToPatch(row)
      if (!patch?.custom) continue
      cards.push(customCard(patch.game, patch.fields, patch.image))
    }
    return cards
  } catch (err) {
    noteLookupFailure(err instanceof MissingFunction)
    return []
  }
}

/* -------------------------------------------------------------------- writes */

/**
 * Contribute one patch to the shared index.
 *
 * Called only from the editor, only when the user ticked the box on that card.
 * Marks the local row `shared` on success so the UI can say so and a re-save
 * of unchanged data does not re-upload.
 */
export async function contributePatch(patch: CardPatch): Promise<void> {
  if (!cardSourceSharing()) throw new CloudError('Sharing card data is turned off')
  await authedRpc<string>('submit_card_data', {
    p_card_id: patch.cardId,
    p_game: patch.game,
    p_fields: patch.fields ?? {},
    p_image: patch.image ?? null,
    p_image_hash: patch.image ? (patch.imageHash ?? imageHash(patch.image)) : null,
    p_custom: patch.custom === true,
  })
  await savePatch({ ...patch, shared: true, sharedAt: Date.now() })
  track('card_source_submit', { game: patch.game, image: !!patch.image, custom: !!patch.custom })
}

/**
 * Report the served data for a card as wrong.
 *
 * Also drops the local copy of it, because a user who says "this is not my
 * card" should stop seeing it immediately rather than after three other people
 * agree. The card id goes back into the miss cache so the same wrong picture
 * is not re-fetched on the next screen.
 */
export async function flagCardData(cardId: string): Promise<void> {
  const local = patchFor(cardId)
  if (local?.origin === 'community') await deletePatch(cardId)
  const misses = await loadMisses()
  misses.add(cardId)
  await kvPut(MISS_KEY, [...misses].slice(-2000))
  if (!isSignedIn()) return
  try {
    await authedRpc<boolean>('flag_card_data', { p_card_id: cardId })
    track('card_source_flag', {})
  } catch {
    // A flag that did not reach the server still removed it locally, which is
    // the half the user asked for.
  }
}

/**
 * Forget every "nobody has this" answer — used when the user turns lookup on.
 *
 * Also clears a stand-down: flipping the switch is someone deliberately asking
 * for the feature, which is the one signal worth more than our own last
 * failure.
 */
export async function clearCardSourceMisses(): Promise<void> {
  stoodDown = false
  lookupFailures = 0
  asked.clear()
  await db.cache.delete(MISS_KEY)
}
