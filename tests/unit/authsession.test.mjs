/**
 * The session must survive its own app being busy.
 *
 * These pin one bug, reported from the live site 2026-08-15: someone signed up
 * with an email and a handle, came back later, and was asked for their email
 * again as though they had never registered.
 *
 * The cause was a race, not an expiry. Refresh tokens ROTATE — the server
 * accepts a given one once and rejects it afterwards. Opening the Friends
 * screen fires `listRequests()`, `matchWants()` and `listOrders()` in the same
 * tick, each of which independently asked for a token. With the access token
 * expired, all three raced to redeem the same refresh token: one won, the
 * losers got a 400, and the 400 path called `signOut()`. The session was
 * destroyed by concurrency and the user was bounced back to sign-up.
 *
 * Two rules follow, and both are tested here because both are load-bearing:
 *   1. Concurrent callers share ONE refresh.
 *   2. Only a definitive rejection of the token ends a session. A 500 or a
 *      dropped connection says nothing about whether the token is valid, and
 *      signing someone out over one is how a train tunnel becomes a re-signup.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'stubs', 'authsession-host.mjs')

const KEY = 'cardstock-cloud-session'

/** Minimal localStorage; the module only ever gets/sets/removes one key. */
function installStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return map
}

/** A session whose access token expired an hour ago but whose refresh is good. */
const expiredSession = () =>
  JSON.stringify({
    accessToken: 'stale-access',
    refreshToken: 'rotating-refresh-1',
    expiresAt: Date.now() - 3_600_000,
    email: 'someone@example.test',
    userId: '965de644-a645-4a8f-bea0-ad094da49191',
  })

const refreshBody = (n) =>
  JSON.stringify({
    access_token: `fresh-access-${n}`,
    refresh_token: `rotating-refresh-${n + 1}`,
    expires_in: 3600,
    user: { id: '965de644-a645-4a8f-bea0-ad094da49191', email: 'someone@example.test' },
  })

async function load() {
  return bundleImport('src/lib/authsession.ts', { alias: { './cloudconfig': STUB } })
}

test('concurrent callers share one refresh — the token is redeemed once', async () => {
  const store = installStorage()
  store.set(KEY, expiredSession())
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    // Rotation, as the real server does it: the first redemption succeeds and
    // any later use of that same token is rejected.
    if (calls > 1) return new Response('{"error":"invalid_grant"}', { status: 400 })
    return new Response(refreshBody(1), { status: 200 })
  }

  const { freshToken, isSignedIn } = await load()
  // Exactly the shape of an app launch: several features, one tick.
  const tokens = await Promise.all([freshToken(), freshToken(), freshToken(), freshToken()])

  assert.equal(calls, 1, 'four concurrent callers must produce ONE refresh request')
  assert.deepEqual(new Set(tokens), new Set(['fresh-access-1']), 'all callers get the same token')
  assert.ok(isSignedIn(), 'the session must survive — this is the reported bug')
})

test('a transient server failure does NOT sign the user out', async () => {
  const store = installStorage()
  store.set(KEY, expiredSession())
  globalThis.fetch = async () => new Response('{"message":"upstream unavailable"}', { status: 503 })

  const { freshToken, isSignedIn } = await load()
  await assert.rejects(() => freshToken())
  assert.ok(isSignedIn(), 'a 503 says nothing about the token — the session must stay')
  assert.ok(store.get(KEY), 'the stored session must not be cleared')
})

test('a network error does NOT sign the user out', async () => {
  const store = installStorage()
  store.set(KEY, expiredSession())
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }

  const { freshToken, isSignedIn } = await load()
  await assert.rejects(() => freshToken())
  assert.ok(isSignedIn(), 'offline is not signed out')
})

test('a rejected refresh token DOES end the session', async () => {
  const store = installStorage()
  store.set(KEY, expiredSession())
  globalThis.fetch = async () =>
    new Response('{"error":"invalid_grant","error_description":"Refresh Token has expired"}', { status: 400 })

  const { freshToken, isSignedIn } = await load()
  await assert.rejects(() => freshToken())
  assert.equal(isSignedIn(), false, 'a definitive rejection must clear the session')
  assert.equal(store.get(KEY), undefined)
})

test('a live access token is returned without any network call', async () => {
  const store = installStorage()
  store.set(
    KEY,
    JSON.stringify({
      accessToken: 'still-good',
      refreshToken: 'r',
      expiresAt: Date.now() + 600_000,
      email: 'someone@example.test',
      userId: 'u',
    }),
  )
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('{}', { status: 200 })
  }

  const { freshToken } = await load()
  assert.equal(await freshToken(), 'still-good')
  assert.equal(calls, 0, 'a valid token must not hit the network')
})

test('the in-flight latch is released, so a later refresh still works', async () => {
  const store = installStorage()
  store.set(KEY, expiredSession())
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    // `expires_in: 0` hands back a token that is already due, so the next call
    // must refresh again. Driven through the module's own API on purpose:
    // `loadSession()` memoizes in a module-level `session`, so poking
    // localStorage directly would prove nothing about the real code path.
    return new Response(refreshBody(calls).replace('"expires_in":3600', '"expires_in":0'), { status: 200 })
  }

  const { freshToken } = await load()
  assert.equal(await freshToken(), 'fresh-access-1')
  assert.equal(await freshToken(), 'fresh-access-2', 'a stuck latch would return the first token forever')
  assert.equal(calls, 2)
})
