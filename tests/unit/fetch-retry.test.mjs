import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

// The transport rules behind "the card isn't in the database… but it is if I
// come back later": Scryfall answers 429 with a block that outlives the burst
// that earned it, and nothing here used to space requests, retry, or tell a
// throttle apart from a genuine miss.
const HERE = fileURLToPath(new URL('.', import.meta.url))
const { fetchJson, httpStatus } = await bundleImport('src/lib/fetchJson.ts')

/** Answer a scripted sequence of statuses, recording every attempt. */
function stubFetch(sequence, headers = {}) {
  const attempts = []
  globalThis.fetch = async (url) => {
    attempts.push(url)
    const status = sequence[Math.min(attempts.length - 1, sequence.length - 1)]
    return {
      ok: status < 400,
      status,
      headers: { get: (name) => headers[name] ?? null },
      json: async () => ({ ok: true }),
      text: async () => 'body',
    }
  }
  return attempts
}

test('the HTTP status rides on the rejection, so 404 is distinguishable from 429', async () => {
  stubFetch([404])
  const err = await fetchJson('https://api.scryfall.com/cards/search?q=x').catch((e) => e)
  assert.equal(httpStatus(err), 404)
  stubFetch([429])
  assert.equal(httpStatus(await fetchJson('https://x/y').catch((e) => e)), 429)
})

test('no retries by default — the scan pipeline must not silently spend its budget', async () => {
  const attempts = stubFetch([429])
  await fetchJson('https://x/y').catch(() => {})
  assert.equal(attempts.length, 1)
})

test('a 429 is retried when the caller asked, and the last answer wins', async () => {
  const attempts = stubFetch([429, 200])
  const res = await fetchJson('https://x/y', { retries: 2 })
  assert.deepEqual(res, { ok: true })
  assert.equal(attempts.length, 2)
})

test('a 404 is never retried — "no such card" is an answer, not a fault', async () => {
  const attempts = stubFetch([404])
  await fetchJson('https://x/y', { retries: 3 }).catch(() => {})
  assert.equal(attempts.length, 1)
})

test('retries are bounded — a server that stays angry still rejects', async () => {
  const attempts = stubFetch([503])
  const err = await fetchJson('https://x/y', { retries: 2 }).catch((e) => e)
  assert.equal(httpStatus(err), 503)
  assert.equal(attempts.length, 3, 'the original attempt plus two retries')
})

test('Retry-After is honoured but clamped — a long one must not hang the UI', async () => {
  stubFetch([429, 200], { 'Retry-After': '120' })
  const started = Date.now()
  await fetchJson('https://x/y', { retries: 1 })
  // The margin is deliberately enormous: the claim is "nowhere near the two
  // minutes it asked for", and a tight bound around the actual clamp would
  // just be a wall-clock assertion that flakes whenever the box is busy.
  assert.ok(Date.now() - started < 30_000, 'a two-minute Retry-After must not be waited out')
})

// --- the Scryfall client on top of it ------------------------------------
const throttleStub = join(HERE, 'stubs', 'scryfall-throttle.mjs')
const stub = await import(throttleStub)
const { searchMtg } = await bundleImport('src/lib/scryfall.ts', { alias: { './fetchJson': throttleStub } })

test('Scryfall requests are spaced, because a burst is what earns the block', async () => {
  stub.calls.length = 0
  await Promise.all([searchMtg('one'), searchMtg('two'), searchMtg('three')])
  assert.equal(stub.calls.length, 3)
  for (let i = 1; i < stub.calls.length; i++) {
    const gap = stub.calls[i].at - stub.calls[i - 1].at
    assert.ok(gap >= 90, `requests ${i - 1}→${i} were ${gap}ms apart, under Scryfall's asked-for spacing`)
  }
})

test('a 404 search is an empty result; a 429 is an error the user can act on', async () => {
  stub.calls.length = 0
  stub.failWith.length = 0
  stub.failWith.push(404)
  assert.deepEqual(await searchMtg('nothing matches this'), [])

  stub.failWith.push(429)
  const err = await searchMtg('rate limited').catch((e) => e)
  assert.ok(err instanceof Error)
  assert.match(err.message, /rate-limit/i)
  assert.ok(!/^HTTP 429/.test(err.message), 'the raw status is not a message for a user')
})

test('one failed lookup does not reject the requests queued behind it', async () => {
  stub.calls.length = 0
  stub.failWith.length = 0
  stub.failWith.push(500)
  const [first, second] = await Promise.allSettled([searchMtg('boom'), searchMtg('fine')])
  assert.equal(first.status, 'rejected')
  assert.equal(second.status, 'fulfilled', 'the shared queue must not propagate a rejection')
})
