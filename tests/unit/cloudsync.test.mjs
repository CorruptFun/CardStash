/**
 * The two pure halves of cloud sync: the encryption envelope the server can
 * never read, and the merge that decides what a second device does with what
 * it finds. Both are network-free and clock-free, so they are testable end to
 * end — which matters, because a merge bug silently eats a user's cards.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const { deriveKey, encryptJson, decryptJson, randomSalt, keyCheck, WrongPassphraseError, toBase64, fromBase64 } =
  await bundleImport('src/lib/crypto.ts', {})

const { mergeBackups } = await bundleImport('src/lib/cloudmerge.ts', {})

const backup = (over = {}) => ({
  app: 'cardstock',
  version: 1,
  exportedAt: '2026-08-01T00:00:00.000Z',
  collection: [],
  decks: [],
  deckCards: [],
  history: [],
  friends: [],
  trades: [],
  wants: [],
  ...over,
})

const card = (id, over = {}) => ({
  id,
  cardId: `mtg:${id}`,
  game: 'mtg',
  name: id,
  finish: 'nonfoil',
  condition: 'nm',
  qty: 1,
  addedAt: 1000,
  card: { id: `mtg:${id}`, name: id, game: 'mtg' },
  ...over,
})

/* ---------------------------------------------------------------- crypto */

test('round-trips a payload through a passphrase', async () => {
  const salt = randomSalt()
  const key = await deriveKey('correct horse battery staple', salt)
  const env = await encryptJson({ cards: [1, 2, 3], note: 'héllo 😀' }, key, salt)
  assert.equal(env.v, 1)
  assert.deepEqual(await decryptJson(env, key), { cards: [1, 2, 3], note: 'héllo 😀' })
})

test('the envelope leaks no plaintext', async () => {
  const salt = randomSalt()
  // The sentinel must contain characters outside the base64 alphabet ('-', '!')
  // — a short all-letter passphrase like 'pw' shows up inside the ~150 base64
  // chars of salt/iv/ct by pure chance in a few percent of runs.
  const key = await deriveKey('pw-sentinel!', salt)
  const env = await encryptJson({ name: 'Black Lotus' }, key, salt)
  assert.ok(!JSON.stringify(env).includes('Black Lotus'))
  assert.ok(!JSON.stringify(env).includes('pw-sentinel!'))
})

test('a wrong passphrase fails as WrongPassphraseError, not a crash', async () => {
  const salt = randomSalt()
  const env = await encryptJson({ a: 1 }, await deriveKey('right', salt), salt)
  const wrongKey = await deriveKey('wrong', salt)
  await assert.rejects(
    () => decryptJson(env, wrongKey),
    (err) => err instanceof WrongPassphraseError,
  )
})

test('the same passphrase on a different salt is a different key', async () => {
  const a = randomSalt()
  const b = randomSalt()
  const env = await encryptJson({ a: 1 }, await deriveKey('same', a), a)
  const otherSaltKey = await deriveKey('same', b)
  await assert.rejects(
    () => decryptJson(env, otherSaltKey),
    (e) => e instanceof WrongPassphraseError,
  )
})

test('every write uses a fresh IV', async () => {
  const salt = randomSalt()
  const key = await deriveKey('pw', salt)
  const one = await encryptJson({ a: 1 }, key, salt)
  const two = await encryptJson({ a: 1 }, key, salt)
  assert.notEqual(one.iv, two.iv)
  assert.notEqual(one.ct, two.ct)
})

test('a future envelope version is refused rather than mis-read', async () => {
  const salt = randomSalt()
  const key = await deriveKey('pw', salt)
  const env = { ...(await encryptJson({ a: 1 }, key, salt)), v: 99 }
  await assert.rejects(() => decryptJson(env, key), /Unsupported vault format/)
})

test('keyCheck matches for the right passphrase and differs for the wrong one', async () => {
  const salt = randomSalt()
  assert.equal(await keyCheck('pw', salt), await keyCheck('pw', salt))
  assert.notEqual(await keyCheck('pw', salt), await keyCheck('pw2', salt))
})

test('base64 helpers survive bytes that are not valid UTF-8', () => {
  const bytes = new Uint8Array([0, 255, 128, 10, 13, 200])
  assert.deepEqual([...fromBase64(toBase64(bytes))], [...bytes])
})

/* ----------------------------------------------------------------- merge */

test('adopts rows that exist only on the remote device', () => {
  const { merged, report } = mergeBackups(backup({ collection: [card('a')] }), backup({ collection: [card('b')] }))
  assert.deepEqual(merged.collection.map((r) => r.id).sort(), ['a', 'b'])
  assert.equal(report.added, 1)
})

test('never sums quantities — two devices holding qty 3 mean three cards', () => {
  const mine = backup({ collection: [card('a', { qty: 3 })] })
  const theirs = backup({ collection: [card('a', { qty: 3 })] })
  const { merged } = mergeBackups(mine, theirs)
  assert.equal(merged.collection.length, 1)
  assert.equal(merged.collection[0].qty, 3)
})

test('the newer row wins a collision, whichever side it is on', () => {
  const older = backup({ collection: [card('a', { qty: 1, addedAt: 10 })] })
  const newer = backup({ collection: [card('a', { qty: 9, addedAt: 99 })] })
  assert.equal(mergeBackups(older, newer).merged.collection[0].qty, 9)
  assert.equal(mergeBackups(newer, older).merged.collection[0].qty, 9)
})

test('an identical merge changes nothing and reports no writes', () => {
  const same = backup({ collection: [card('a')] })
  const { merged, report } = mergeBackups(same, structuredClone(same))
  assert.deepEqual(merged.collection, same.collection)
  assert.equal(report.added, 0)
  assert.equal(report.updated, 0)
})

test('price history survives — it is keyed by [cardId+date], not id', () => {
  const mine = backup({ history: [{ cardId: 'mtg:x', date: '2026-08-01', best: 1, foil: null }] })
  const theirs = backup({ history: [{ cardId: 'mtg:x', date: '2026-08-02', best: 2, foil: null }] })
  const { merged } = mergeBackups(mine, theirs)
  assert.equal(merged.history.length, 2, 'both days kept')
})

test('same card same day is one point, not a duplicate', () => {
  const point = { cardId: 'mtg:x', date: '2026-08-01', best: 1, foil: null }
  const { merged } = mergeBackups(backup({ history: [point] }), backup({ history: [{ ...point, best: 5 }] }))
  assert.equal(merged.history.length, 1)
})

test('a stale device cannot roll back a fresher one on untimestamped tables', () => {
  const fresh = backup({ exportedAt: '2026-08-10T00:00:00.000Z', deckCards: [{ id: 'd1', deckId: 'x', cardId: 'c', qty: 4, board: 'main' }] })
  const stale = backup({ exportedAt: '2026-01-01T00:00:00.000Z', deckCards: [{ id: 'd1', deckId: 'x', cardId: 'c', qty: 1, board: 'main' }] })
  assert.equal(mergeBackups(fresh, stale).merged.deckCards[0].qty, 4, 'stale remote must not win')
  assert.equal(mergeBackups(stale, fresh).merged.deckCards[0].qty, 4, 'fresh remote must win')
})

test('wants merge on their compound key, not an id', () => {
  const mine = backup({ wants: [{ key: 'mtg|black lotus', cardId: 'mtg:1', game: 'mtg', name: 'Black Lotus', addedAt: 1 }] })
  const theirs = backup({ wants: [{ key: 'mtg|ancestral recall', cardId: 'mtg:2', game: 'mtg', name: 'Ancestral Recall', addedAt: 2 }] })
  assert.equal(mergeBackups(mine, theirs).merged.wants.length, 2)
})

test('neither input is mutated', () => {
  const mine = backup({ collection: [card('a')] })
  const theirs = backup({ collection: [card('b')] })
  const snapshot = JSON.stringify([mine, theirs])
  mergeBackups(mine, theirs)
  assert.equal(JSON.stringify([mine, theirs]), snapshot)
})

test('rows with no usable key are dropped rather than crashing the merge', () => {
  const { merged } = mergeBackups(backup({ collection: [card('a')] }), backup({ collection: [{ nonsense: true }, card('b')] }))
  assert.deepEqual(merged.collection.map((r) => r.id).sort(), ['a', 'b'])
})

test('merging thousands of rows stays linear', () => {
  const many = (n, off) => Array.from({ length: n }, (_, i) => card(`c${i + off}`))
  const mine = backup({ collection: many(4000, 0) })
  const theirs = backup({ collection: many(4000, 2000) })
  const started = process.hrtime.bigint()
  const { merged } = mergeBackups(mine, theirs)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(merged.collection.length, 6000)
  assert.ok(ms < 500, `merge took ${ms.toFixed(0)}ms — quadratic behaviour is back`)
})
