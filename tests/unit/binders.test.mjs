/**
 * Custom binders: what a binder claims, and who it claims it to.
 *
 * Two of these guard promises a user acts on. **Quantities are clamped to the
 * collection** — a binder saying you have four of something you own two of is
 * a claim a friend will drive across town for, and the clamp has to survive
 * the collection shrinking long after the binder row was written. And
 * **`isDiscoverable` needs both halves**: a friends-only binder must never be
 * globally matchable (migration 0003's invariant, applied one level down), and
 * a public binder that is merely on display is not an offer.
 *
 * The rest pins the wire shape. A binder payload is its own `kind` precisely so
 * importing one cannot be mistaken for importing a profile — a binder is a
 * subset, and merging one over somebody's card list would look like a friend
 * who had thrown their collection away.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'stubs', 'messaging-host.mjs')
const hosts = { './analytics': STUB, './authsession': STUB, './cloudconfig': STUB, './settings': STUB }

const {
  binderQty,
  binderSharedCards,
  binderSummary,
  isDiscoverable,
  isPublished,
  resolveBinderRows,
} = await bundleImport('src/lib/binders.ts', { alias: hosts })

const { buildBinderPayload, sanitizePayload, sharedBinderFromPayload } = await bundleImport('src/lib/social.ts', {
  alias: hosts,
})

const item = (id, over = {}) => ({
  id,
  cardId: 'mtg:abc',
  game: 'mtg',
  name: 'Black Lotus',
  finish: 'nonfoil',
  condition: 'NM',
  qty: 2,
  forTrade: 0,
  addedAt: 1,
  card: { id: 'mtg:abc', game: 'mtg', apiId: 'abc', name: 'Black Lotus', prices: { best: 10, bestFoil: null, entries: [], updatedAt: 1 }, links: {} },
  ...over,
})

const binderRow = (id, itemId, qty) => ({ id, binderId: 'b1', itemId, cardId: 'mtg:abc', qty, addedAt: 1 })

test('a binder row is dropped when the copy behind it is gone', () => {
  const rows = resolveBinderRows([binderRow('r1', 'i1', 1), binderRow('r2', 'gone', 1)], [item('i1')])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].row.itemId, 'i1')
})

test('a row is dropped when the collection row has dropped to zero', () => {
  const rows = resolveBinderRows([binderRow('r1', 'i1', 1)], [item('i1', { qty: 0 })])
  assert.equal(rows.length, 0)
})

test('QUANTITIES CLAMP TO WHAT IS STILL OWNED', () => {
  // Four were put in the binder; three have since been traded away.
  const rows = resolveBinderRows([binderRow('r1', 'i1', 4)], [item('i1', { qty: 1 })])
  assert.equal(rows[0].row.qty, 1)
  assert.equal(binderQty(rows), 1)
  const cards = binderSharedCards(rows, true)
  assert.equal(cards[0].qty, 1)
  assert.equal(cards[0].forTrade, 1)
})

test('an opened sealed product never travels, as on a profile share', () => {
  const rows = resolveBinderRows([binderRow('r1', 'i1', 1)], [item('i1', { opened: true })])
  assert.equal(binderSharedCards(rows, true).length, 0)
})

test('a binder that is not tradeable publishes cards and NO offer', () => {
  const rows = resolveBinderRows([binderRow('r1', 'i1', 2)], [item('i1')])
  const shown = binderSharedCards(rows, false)
  assert.equal(shown[0].qty, 2)
  assert.equal(shown[0].forTrade, 0, 'on display, not on offer')
  // The collection row's own for-trade flag must not leak in either.
  const flagged = resolveBinderRows([binderRow('r1', 'i1', 2)], [item('i1', { forTrade: 2 })])
  assert.equal(binderSharedCards(flagged, false)[0].forTrade, 0)
})

test('DISCOVERABLE NEEDS BOTH HALVES', () => {
  assert.equal(isDiscoverable({ visibility: 'public', tradeable: true }), true)
  assert.equal(isDiscoverable({ visibility: 'friends', tradeable: true }), false, 'friends-only is never global')
  assert.equal(isDiscoverable({ visibility: 'public', tradeable: false }), false, 'a display case is not an offer')
  assert.equal(isDiscoverable({ visibility: 'private', tradeable: true }), false)
})

test('only a non-private binder is uploaded at all', () => {
  assert.equal(isPublished({ visibility: 'private' }), false)
  assert.equal(isPublished({ visibility: 'friends' }), true)
  assert.equal(isPublished({ visibility: 'public' }), true)
})

test('the summary says the audience, and only claims a trade when there is one', () => {
  const base = { id: 'b1', name: 'Vintage', visibility: 'public', tradeable: true, createdAt: 1, updatedAt: 1 }
  assert.equal(binderSummary(base, 4), '4 cards · public · for trade')
  assert.equal(binderSummary({ ...base, tradeable: false }, 1), '1 card · public')
  // Private plus tradeable is not "for trade" — nothing is published to trade.
  assert.equal(binderSummary({ ...base, visibility: 'private' }, 2), '2 cards · private')
})

test('a binder payload round-trips through the sanitizer as its own kind', () => {
  const rows = resolveBinderRows([binderRow('r1', 'i1', 2)], [item('i1')])
  const payload = buildBinderPayload(
    { id: 'b1', name: 'Vintage Charizards', note: 'ask me', tradeable: true },
    binderSharedCards(rows, true),
    { id: 'me', name: 'Rae', scope: 'trade' },
  )
  assert.equal(payload.kind, 'binder')
  const clean = sanitizePayload({ app: 'cardstock-social', v: 1, ...payload })
  assert.equal(clean.kind, 'binder', 'never mistaken for a profile')
  assert.equal(clean.name, 'Vintage Charizards')
  assert.equal(clean.from.id, 'me')
  assert.equal(clean.cards.length, 1)
  const stored = sharedBinderFromPayload(clean)
  assert.equal(stored.id, 'b1')
  assert.equal(stored.tradeable, true)
})

test('a binder payload with no sender is refused', () => {
  assert.throws(() => sanitizePayload({ kind: 'binder', id: 'b1', name: 'x', cards: [] }))
})

test('tradeable is a boolean, not whatever the wire said', () => {
  const clean = sanitizePayload({
    kind: 'binder',
    id: 'b1',
    from: { id: 'them', name: 'Rae' },
    name: 'x',
    tradeable: 'yes please',
    cards: [],
  })
  assert.equal(clean.tradeable, false)
})
