/**
 * Binders — the label, the link, and the merge.
 *
 * Three things here are worth a test rather than a read-through: a name that
 * gets printed on paper and must survive whatever was pasted into the field, a
 * URL that gets glued to a shelf and cannot be re-issued when it is wrong, and
 * the vault merge, where a binder renamed on a phone must not be undone by a
 * laptop that has not synced since.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const {
  binderCode,
  binderId,
  binderUrl,
  byPage,
  cleanBinderName,
  cleanBinderNote,
  cleanBinderPage,
  isBinderId,
  pageLabel,
  parseBinderCode,
  sanitizeBinder,
  BINDER_NAME_MAX,
} = await bundleImport('src/lib/binders.ts')

const { mergeBackups } = await bundleImport('src/lib/cloudmerge.ts')

test('a name is one line, trimmed, and capped', () => {
  assert.equal(cleanBinderName('  Pokémon rares  '), 'Pokémon rares')
  assert.equal(cleanBinderName('two\nlines\there'), 'two lines here')
  assert.equal(cleanBinderName('a\u0000b\u007f'), 'a b')
  assert.equal(cleanBinderName('x'.repeat(200)).length, BINDER_NAME_MAX)
  assert.equal(cleanBinderName('   '), '')
  assert.equal(cleanBinderNote('shelf 2,\n left'), 'shelf 2, left')
})

test('page numbers are 1-based and bounded', () => {
  assert.equal(cleanBinderPage('7'), 7)
  assert.equal(cleanBinderPage(3.8), 3)
  assert.equal(cleanBinderPage(0), undefined)
  assert.equal(cleanBinderPage(-2), undefined)
  assert.equal(cleanBinderPage(100000), undefined)
  assert.equal(cleanBinderPage('page seven'), undefined)
  assert.equal(pageLabel(4), 'Page 4')
  assert.equal(pageLabel(undefined), 'Unpaged')
})

test('ids are short, camera-safe, and unique', () => {
  const ids = new Set()
  for (let i = 0; i < 500; i++) {
    const id = binderId()
    assert.match(id, /^[a-z0-9]{10}$/)
    // No 'i', 'l', 'o' or '0'/'1' — the characters a person mistypes off paper.
    assert.doesNotMatch(id, /[ilo01]/)
    ids.add(id)
  }
  assert.equal(ids.size, 500)
  assert.ok(isBinderId('abc123'))
  assert.ok(!isBinderId('has space'))
  assert.ok(!isBinderId(''))
})

test('the printed code round-trips however it is typed back', () => {
  const id = 'k3f9a2b1c8'
  assert.equal(binderCode(id), 'K3F9A-2B1C8')
  assert.equal(parseBinderCode(binderCode(id)), id)
  assert.equal(parseBinderCode('  k3f9a 2b1c8 '), id)
})

test('the QR link points at this deployment, and only at a binder', () => {
  assert.equal(binderUrl('abc', 'https://example.com/app/'), 'https://example.com/app/#/binders/abc')
  // A base carrying its own query or fragment (the referral `?via=`, a stale
  // route) must not end up inside the printed link.
  assert.equal(binderUrl('abc', 'https://example.com/app/?via=rae#/scan'), 'https://example.com/app/#/binders/abc')
  assert.equal(binderUrl('a b', 'https://example.com/'), 'https://example.com/#/binders/a%20b')
})

test('an outside binder row is coerced or dropped, never trusted', () => {
  assert.equal(sanitizeBinder(null), null)
  assert.equal(sanitizeBinder('binder'), null)
  assert.equal(sanitizeBinder({}), null)
  assert.equal(sanitizeBinder({ id: 'x'.repeat(90), name: 'huge' }), null)

  const clean = sanitizeBinder({ id: ' abc ', name: '  Rares\n', note: 'x'.repeat(500), createdAt: 5, updatedAt: 9 })
  assert.deepEqual(clean, { id: 'abc', name: 'Rares', note: 'x'.repeat(80), createdAt: 5, updatedAt: 9 })

  const nameless = sanitizeBinder({ id: 'abc', createdAt: -1 })
  assert.equal(nameless.name, 'Untitled binder')
  assert.ok(nameless.createdAt > 0)
  assert.equal(nameless.updatedAt, nameless.createdAt)
})

test('rows group by page, in page order, unpaged last', () => {
  const grouped = byPage([
    { id: 'c', binderPage: 3 },
    { id: 'a', binderPage: 1 },
    { id: 'u' },
    { id: 'b', binderPage: 1 },
  ])
  assert.deepEqual(
    grouped.map((g) => [g.page, g.rows.map((r) => r.id)]),
    [
      [1, ['a', 'b']],
      [3, ['c']],
      [undefined, ['u']],
    ],
  )
})

/* --- the vault merge ------------------------------------------------------ */

const EMPTY = {
  app: 'cardstock',
  version: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  collection: [],
  decks: [],
  deckCards: [],
  history: [],
  friends: [],
  trades: [],
  wants: [],
  binders: [],
  patches: [],
}

test('binders union across devices, and the latest rename wins', () => {
  const local = {
    ...EMPTY,
    exportedAt: '2026-02-01T00:00:00.000Z',
    binders: [{ id: 'a', name: 'Rares', createdAt: 1, updatedAt: 100 }],
  }
  const remote = {
    ...EMPTY,
    // Older vault overall — a rename made on it must still win, because the
    // rename itself is newer than the local row.
    exportedAt: '2026-01-15T00:00:00.000Z',
    binders: [
      { id: 'a', name: 'Rares — 2026', createdAt: 1, updatedAt: 200 },
      { id: 'b', name: 'Bulk', createdAt: 2, updatedAt: 2 },
    ],
  }
  const { merged } = mergeBackups(local, remote)
  assert.equal(merged.binders.length, 2)
  assert.equal(merged.binders.find((b) => b.id === 'a').name, 'Rares — 2026')
  assert.ok(merged.binders.some((b) => b.id === 'b'))
})

test('a backup written before binders existed still merges', () => {
  const old = { ...EMPTY }
  delete old.binders
  const { merged } = mergeBackups(old, { ...EMPTY, binders: [{ id: 'a', name: 'Rares', createdAt: 1, updatedAt: 1 }] })
  assert.equal(merged.binders.length, 1)
})

test('a card filed in a binder keeps its filing through a merge', () => {
  const filed = {
    ...EMPTY,
    exportedAt: '2026-02-01T00:00:00.000Z',
    collection: [{ id: 'row1', cardId: 'mtg:1', addedAt: 200, binderId: 'a', binderPage: 3, card: {} }],
  }
  const unfiled = {
    ...EMPTY,
    exportedAt: '2026-01-01T00:00:00.000Z',
    collection: [{ id: 'row1', cardId: 'mtg:1', addedAt: 100, card: {} }],
  }
  const { merged } = mergeBackups(filed, unfiled)
  assert.equal(merged.collection[0].binderId, 'a')
  assert.equal(merged.collection[0].binderPage, 3)
})
