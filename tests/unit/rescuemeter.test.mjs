/**
 * The rescue meter's arithmetic — pure, so node can hold it to account.
 *
 * The properties that matter, in the order they can go wrong: the month key
 * must match the server's UTC bucket exactly; a rolled-over month must read
 * as NO sample rather than last month's number; the cap may only ever be
 * derived (an entitlement answer, or a `remaining` only the subscriber pool
 * can return) and a cap that CHANGES drops the sample with it — "49 left"
 * under the free 50 must never be re-read as "used 951 of 1,000" the moment
 * someone subscribes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const {
  EMPTY_RESCUE_METER,
  FREE_MONTHLY_RESCUES,
  SUBSCRIBER_MONTHLY_RESCUES,
  meterMonth,
  noteCap,
  noteRemaining,
  readRescueMeter,
  rescueHintQuiet,
  rescueMomentText,
  RESCUE_HINT_QUIET_MS,
  sanitizeRescueMeter,
} = await bundleImport('src/lib/rescuemeter.ts')

/** A fixed instant: 2026-08-17 in UTC, mid-month, mid-day. */
const AUG = Date.UTC(2026, 7, 17, 12, 0, 0)
const SEP = Date.UTC(2026, 8, 2, 0, 30, 0)

// ------------------------------------------------------------ the month key

test('meterMonth is the server bucket: UTC, YYYY-MM', () => {
  assert.equal(meterMonth(AUG), '2026-08')
  // 23:30 on the 31st in UTC is already September in Sydney and still August
  // here — the SERVER's clock is the one the allowance resets on.
  assert.equal(meterMonth(Date.UTC(2026, 7, 31, 23, 30)), '2026-08')
  assert.equal(meterMonth(SEP), '2026-09')
})

// ------------------------------------------------------- noting a remaining

test('a successful rescue stores month + remaining', () => {
  const meter = noteRemaining(EMPTY_RESCUE_METER, 49, AUG)
  assert.deepEqual(meter, { month: '2026-08', remaining: 49, cap: 0 })
})

test('remaining at 50 or above proves the subscriber pool', () => {
  // The free pool consumes before it counts, so it answers 49 at most.
  assert.equal(noteRemaining(EMPTY_RESCUE_METER, 50, AUG).cap, SUBSCRIBER_MONTHLY_RESCUES)
  assert.equal(noteRemaining(EMPTY_RESCUE_METER, 987, AUG).cap, SUBSCRIBER_MONTHLY_RESCUES)
  // Below it the answer is ambiguous and proves nothing.
  assert.equal(noteRemaining(EMPTY_RESCUE_METER, 49, AUG).cap, 0)
})

test('a small remaining keeps the cap already known', () => {
  const free = { month: '2026-08', remaining: 40, cap: FREE_MONTHLY_RESCUES }
  assert.equal(noteRemaining(free, 12, AUG).cap, FREE_MONTHLY_RESCUES)
  // A subscriber deep into the month still counts down from 1,000.
  const sub = { month: '2026-08', remaining: 60, cap: SUBSCRIBER_MONTHLY_RESCUES }
  assert.equal(noteRemaining(sub, 31, AUG).cap, SUBSCRIBER_MONTHLY_RESCUES)
})

test('junk from the wire stores nothing', () => {
  for (const junk of [undefined, null, '37', Number.NaN, Number.POSITIVE_INFINITY, -1, {}]) {
    assert.equal(noteRemaining(EMPTY_RESCUE_METER, junk, AUG), null, `${String(junk)} must not become a meter`)
  }
})

test('zero is storable — the words for "none left" must exist', () => {
  assert.deepEqual(noteRemaining(EMPTY_RESCUE_METER, 0, AUG), { month: '2026-08', remaining: 0, cap: 0 })
})

test('a new month re-keys the sample and carries the cap forward', () => {
  const july = { month: '2026-07', remaining: 3, cap: FREE_MONTHLY_RESCUES }
  assert.deepEqual(noteRemaining(july, 49, AUG), { month: '2026-08', remaining: 49, cap: FREE_MONTHLY_RESCUES })
})

// ------------------------------------------------------------ noting a cap

test('an entitlement answer sets the cap without inventing a sample', () => {
  assert.deepEqual(noteCap(EMPTY_RESCUE_METER, false), { month: '', remaining: 0, cap: FREE_MONTHLY_RESCUES })
  assert.deepEqual(noteCap(EMPTY_RESCUE_METER, true), { month: '', remaining: 0, cap: SUBSCRIBER_MONTHLY_RESCUES })
})

test('a cap that already agrees hands back the SAME object, so nothing is written', () => {
  const meter = { month: '2026-08', remaining: 37, cap: FREE_MONTHLY_RESCUES }
  assert.equal(noteCap(meter, false), meter)
})

test('a cap that CHANGES drops the sample with it', () => {
  // 49 left of the free 50, then the person subscribes: the 49 was the other
  // pool's number, and keeping it would render "used 951 of 1,000".
  const free = { month: '2026-08', remaining: 49, cap: FREE_MONTHLY_RESCUES }
  assert.deepEqual(noteCap(free, true), { month: '', remaining: 0, cap: SUBSCRIBER_MONTHLY_RESCUES })
  // And the reverse, when a subscription lapses mid-month.
  const sub = { month: '2026-08', remaining: 400, cap: SUBSCRIBER_MONTHLY_RESCUES }
  assert.deepEqual(noteCap(sub, false), { month: '', remaining: 0, cap: FREE_MONTHLY_RESCUES })
})

// -------------------------------------------------------------- reading it

test('this month reads back; a rolled-over month reads as nothing', () => {
  const meter = noteRemaining(EMPTY_RESCUE_METER, 37, AUG)
  assert.deepEqual(readRescueMeter(meter, AUG), { remaining: 37, cap: 0 })
  assert.equal(readRescueMeter(meter, SEP), null, 'September must not show August’s figure')
})

test('no sample yet reads as nothing, even with a cap known', () => {
  assert.equal(readRescueMeter(noteCap(EMPTY_RESCUE_METER, false), AUG), null)
  assert.equal(readRescueMeter(undefined, AUG), null)
})

test('a remaining above the cap downgrades the cap to unknown rather than rendering an impossibility', () => {
  const edited = { month: meterMonth(AUG), remaining: 400, cap: FREE_MONTHLY_RESCUES }
  assert.deepEqual(readRescueMeter(edited, AUG), { remaining: 400, cap: 0 })
})

// -------------------------------------------------------------- sanitizing

test('sanitize collapses junk to "no sample" and caps to values that exist', () => {
  assert.deepEqual(sanitizeRescueMeter(undefined), { month: '', remaining: 0, cap: 0 })
  assert.deepEqual(sanitizeRescueMeter('garbage'), { month: '', remaining: 0, cap: 0 })
  assert.deepEqual(sanitizeRescueMeter({ month: 'nope', remaining: 9, cap: 50 }), { month: '', remaining: 0, cap: 50 })
  assert.deepEqual(sanitizeRescueMeter({ month: '2026-08', remaining: '9', cap: 50 }), { month: '2026-08', remaining: 0, cap: 50 })
  // A devtools-typed cap is not a number the product has.
  assert.equal(sanitizeRescueMeter({ month: '2026-08', remaining: 9, cap: 7_000_000 }).cap, 0)
  assert.equal(sanitizeRescueMeter({ month: '2026-08', remaining: 9.7, cap: 1000 }).remaining, 9)
})

// -------------------------------------------------------- the moment's words

test('the toast line degrades by what is actually known', () => {
  const both = { month: '2026-08', remaining: 37, cap: FREE_MONTHLY_RESCUES }
  assert.equal(rescueMomentText(both, AUG), 'Read in the cloud — 37 of 50 left this month')
  const sub = { month: '2026-08', remaining: 987, cap: SUBSCRIBER_MONTHLY_RESCUES }
  assert.equal(rescueMomentText(sub, AUG), 'Read in the cloud — 987 of 1,000 left this month')
  const capless = { month: '2026-08', remaining: 37, cap: 0 }
  assert.equal(rescueMomentText(capless, AUG), 'Read in the cloud — 37 left this month')
  assert.equal(rescueMomentText(EMPTY_RESCUE_METER, AUG), 'Read in the cloud')
  // Stale month: the fact stands, the stale number stays out of it.
  assert.equal(rescueMomentText(both, SEP), 'Read in the cloud')
})

// --------------------------------------------------------- the offer's rest

test('a dismissed offer stays quiet for a fortnight, then may return', () => {
  assert.equal(rescueHintQuiet(0, AUG), false, 'never dismissed → never quiet')
  assert.equal(rescueHintQuiet(AUG - 86_400_000, AUG), true, 'yesterday → quiet')
  assert.equal(rescueHintQuiet(AUG - RESCUE_HINT_QUIET_MS + 1, AUG), true, 'a fortnight less a tick → still quiet')
  assert.equal(rescueHintQuiet(AUG - RESCUE_HINT_QUIET_MS, AUG), false, 'a full fortnight → the offer may return')
  assert.equal(rescueHintQuiet(AUG + 86_400_000, AUG), true, 'a clock set forward reads as quiet, not as a nag')
})
