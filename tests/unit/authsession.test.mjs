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
 * Reports of being signed out kept arriving after that fix, because the latch
 * it added covers ONE document and the same race runs between TABS: two tabs
 * hold two latches and one shared localStorage, so the second to wake spends a
 * token the first already rotated. GoTrue forgives that for
 * `refresh_token_reuse_interval` (10s here) and rejects it flatly after — a
 * rejection the old code could not tell from a revoked session, so it signed
 * the user out of both.
 *
 * Four rules follow, and all four are tested here because all four are
 * load-bearing:
 *   1. Concurrent callers share ONE refresh.
 *   2. Only a definitive rejection of the token ends a session. A 500 or a
 *      dropped connection says nothing about whether the token is valid, and
 *      signing someone out over one is how a train tunnel becomes a re-signup.
 *   3. A refresh spends the token STORAGE holds, and a rejection is re-checked
 *      against storage before it is believed — the other tab leaves its good
 *      session there.
 *   4. Tabs share what they learn, sign-out included.
 *
 * The remember-me tests at the bottom are a different thing wearing a similar
 * name: a FORGET-me switch, which decides which storage the tokens land in.
 * It was never the fix for any of the above and must not be sold as one.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'stubs', 'authsession-host.mjs')

const KEY = 'cardstock-cloud-session'

const REMEMBER = 'cardstock-remember'

/**
 * Both stores, because which one holds the session IS the remember-me
 * feature — a stub with only localStorage would pass every test while the
 * "don't remember me" path wrote nowhere.
 */
function installStorage() {
  const make = () => {
    const map = new Map()
    const api = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    }
    return [map, api]
  }
  const [local, localApi] = make()
  const [session, sessionApi] = make()
  globalThis.localStorage = localApi
  globalThis.sessionStorage = sessionApi
  return { local, session }
}

/**
 * A window that can deliver a `storage` event, which is how one tab learns
 * what another did. Installed before the module loads, because the listener
 * is registered at import.
 */
function installWindow() {
  const listeners = new Map()
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
  }
  return (type, event) => {
    for (const fn of listeners.get(type) ?? []) fn(event)
  }
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
  const { local: store } = installStorage()
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
  const { local: store } = installStorage()
  store.set(KEY, expiredSession())
  globalThis.fetch = async () => new Response('{"message":"upstream unavailable"}', { status: 503 })

  const { freshToken, isSignedIn } = await load()
  await assert.rejects(() => freshToken())
  assert.ok(isSignedIn(), 'a 503 says nothing about the token — the session must stay')
  assert.ok(store.get(KEY), 'the stored session must not be cleared')
})

test('a network error does NOT sign the user out', async () => {
  const { local: store } = installStorage()
  store.set(KEY, expiredSession())
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }

  const { freshToken, isSignedIn } = await load()
  await assert.rejects(() => freshToken())
  assert.ok(isSignedIn(), 'offline is not signed out')
})

test('a rejected refresh token DOES end the session', async () => {
  const { local: store } = installStorage()
  store.set(KEY, expiredSession())
  globalThis.fetch = async () =>
    new Response('{"error":"invalid_grant","error_description":"Refresh Token has expired"}', { status: 400 })

  const { freshToken, isSignedIn } = await load()
  await assert.rejects(() => freshToken())
  assert.equal(isSignedIn(), false, 'a definitive rejection must clear the session')
  assert.equal(store.get(KEY), undefined)
})

test('a live access token is returned without any network call', async () => {
  const { local: store } = installStorage()
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
  const { local: store } = installStorage()
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

/* ------------------------------------------------ the same race, between tabs
 *
 * The latch above dedupes callers inside ONE document. Two tabs have two
 * latches and one shared localStorage, so the second tab to wake spends a
 * refresh token the first already rotated — and GoTrue rejects a reused token
 * flatly once `refresh_token_reuse_interval` (10s on this project) is past.
 * That rejection is indistinguishable from a revoked session by status and
 * body alone, so the old code signed the user out of both tabs for the crime
 * of having two open. These pin the two halves of the answer: read storage
 * before spending, and re-read it before believing a rejection.
 */

/** A session in storage that some other tab has already refreshed. */
const rotatedSession = ({ access = 'other-tab-access', refresh = 'rotating-refresh-9', fresh = true } = {}) =>
  JSON.stringify({
    accessToken: access,
    refreshToken: refresh,
    expiresAt: fresh ? Date.now() + 600_000 : Date.now() - 600_000,
    email: 'someone@example.test',
    userId: '965de644-a645-4a8f-bea0-ad094da49191',
  })

test('a refresh spends the token STORAGE holds, not the one memoized earlier', async () => {
  const { local: store } = installStorage()
  store.set(KEY, expiredSession())
  const sent = []
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body).refresh_token)
    return new Response(refreshBody(1), { status: 200 })
  }

  const { freshToken, isSignedIn } = await load()
  assert.ok(isSignedIn(), 'this memoizes the session, as any UI read does')
  // Another tab refreshes. It writes storage; it cannot reach into this
  // document's memory.
  store.set(KEY, rotatedSession({ fresh: false }))

  await freshToken()
  assert.deepEqual(sent, ['rotating-refresh-9'], 'the memoized token was already spent by the other tab')
})

test('"already used" is re-checked against storage, and the other tab\'s session is adopted', async () => {
  const { local: store } = installStorage()
  store.set(KEY, expiredSession())
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    // The other tab wins the race while our request is in flight.
    store.set(KEY, rotatedSession())
    return new Response('{"error":"invalid_grant","error_description":"Invalid Refresh Token: Already Used"}', {
      status: 400,
    })
  }

  const { freshToken, isSignedIn } = await load()
  assert.equal(await freshToken(), 'other-tab-access', 'the live session was sitting in storage')
  assert.equal(calls, 1, 'a usable stored token needs no second request')
  assert.ok(isSignedIn(), 'two tabs must not sign each other out — this is the bug')
  assert.ok(store.get(KEY), 'the stored session must survive untouched')
})

test('if the adopted session is also due, it is refreshed once — and only once', async () => {
  const { local: store } = installStorage()
  store.set(KEY, expiredSession())
  const sent = []
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body).refresh_token)
    if (sent.length === 1) {
      store.set(KEY, rotatedSession({ fresh: false }))
      return new Response('{"error":"invalid_grant","error_description":"Already Used"}', { status: 400 })
    }
    return new Response(refreshBody(1), { status: 200 })
  }

  const { freshToken, isSignedIn } = await load()
  assert.equal(await freshToken(), 'fresh-access-1')
  assert.deepEqual(sent, ['rotating-refresh-1', 'rotating-refresh-9'], 'the retry uses the token storage holds')
  assert.ok(isSignedIn())
})

test('a rejection of the token storage still holds IS the end of the session', async () => {
  const { local, session } = installStorage()
  local.set(KEY, expiredSession())
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    // Nothing else rotated it — this really is a dead session.
    return new Response('{"error":"invalid_grant","error_description":"Already Used"}', { status: 400 })
  }

  const { freshToken, isSignedIn } = await load()
  await assert.rejects(() => freshToken(), /sign in again/)
  assert.equal(calls, 1, 'no retry when storage has not moved on')
  assert.equal(isSignedIn(), false)
  assert.equal(local.get(KEY), undefined)
  assert.equal(session.get(KEY), undefined, 'sign-out must leave nothing in either store')
})

test('a tab notices when another tab signs out', async () => {
  const dispatch = installWindow()
  const { local } = installStorage()
  local.set(KEY, expiredSession())

  const { isSignedIn, onSignOut } = await load()
  let dropped = 0
  onSignOut(() => dropped++)
  assert.ok(isSignedIn())

  // What the other tab's `signOut()` leaves behind, and the event it raises.
  local.delete(KEY)
  dispatch('storage', { key: KEY })

  assert.equal(isSignedIn(), false, 'signing out in one tab must sign out in all of them')
  assert.equal(dropped, 1, 'derived state — the vault key — has to go too')
})

test('a cleared storage (key === null) is honoured, not ignored', async () => {
  const dispatch = installWindow()
  const { local } = installStorage()
  local.set(KEY, expiredSession())

  const { isSignedIn } = await load()
  assert.ok(isSignedIn())
  local.clear()
  dispatch('storage', { key: null })
  assert.equal(isSignedIn(), false)
})

test('an unrelated key changing in another tab is left alone', async () => {
  const dispatch = installWindow()
  const { local } = installStorage()
  local.set(KEY, expiredSession())

  const { isSignedIn } = await load()
  assert.ok(isSignedIn(), 'memoized, as any UI read does')
  // Storage and memory now diverge. Only a session-key event may notice.
  local.delete(KEY)
  dispatch('storage', { key: 'cardstock-settings' })
  assert.ok(isSignedIn(), 'a settings write must not re-read, or every toggle costs a parse')
})

/* --------------------------------------------------------------- remember me
 *
 * The checkbox is a FORGET-me switch: sessions have always persisted, and
 * unticking it is how somebody on a borrowed machine says don't. So the thing
 * to prove is which storage the tokens land in — a stub with only localStorage
 * would pass everything while the "no" wrote nowhere.
 */

const verifyBody = JSON.stringify({
  access_token: 'signed-in-access',
  refresh_token: 'signed-in-refresh',
  expires_in: 3600,
  user: { id: '965de644-a645-4a8f-bea0-ad094da49191', email: 'someone@example.test' },
})

test('by default a session persists, in localStorage, with nothing left in the tab store', async () => {
  const { local, session } = installStorage()
  globalThis.fetch = async () => new Response(verifyBody, { status: 200 })

  const auth = await load()
  assert.equal(auth.rememberMe(), true, 'an install that never touched the box remembers')
  await auth.verifyEmailCode('someone@example.test', '123456')

  assert.ok(local.get(KEY), 'the session outlives the tab')
  assert.equal(session.get(KEY), undefined)
  assert.equal(local.get(REMEMBER), undefined, 'the default costs no write')
})

test('unticked, the session lands in the tab store and nowhere durable', async () => {
  const { local, session } = installStorage()
  globalThis.fetch = async () => new Response(verifyBody, { status: 200 })

  const auth = await load()
  auth.setRememberMe(false)
  await auth.verifyEmailCode('someone@example.test', '123456')

  assert.equal(local.get(KEY), undefined, 'a shared machine keeps nothing that outlives the tab')
  assert.ok(session.get(KEY), 'but the session works for as long as the tab is open')
  assert.ok(auth.isSignedIn())
  assert.equal(auth.rememberMe(), false)
  assert.equal(
    local.get(REMEMBER),
    '0',
    'the CHOICE is durable even though the session is not — it must survive the Google round trip',
  )
})

test('changing your mind moves the session you already have', async () => {
  const { local, session } = installStorage()
  globalThis.fetch = async () => new Response(verifyBody, { status: 200 })

  const auth = await load()
  await auth.verifyEmailCode('someone@example.test', '123456')
  assert.ok(local.get(KEY))

  auth.setRememberMe(false)
  assert.equal(local.get(KEY), undefined, 'unticking has to evict what is already written')
  assert.ok(session.get(KEY))
  assert.ok(auth.isSignedIn(), 'moving a session must not drop it')

  auth.setRememberMe(true)
  assert.ok(local.get(KEY))
  assert.equal(session.get(KEY), undefined, 'a session must never exist in both stores at once')
  assert.ok(auth.isSignedIn())
})

test('signing out clears both stores, whatever the preference says', async () => {
  const { local, session } = installStorage()
  // A session written before the preference last changed can sit in either.
  local.set(KEY, expiredSession())
  session.set(KEY, expiredSession())

  const auth = await load()
  auth.signOut()
  assert.equal(local.get(KEY), undefined)
  assert.equal(session.get(KEY), undefined)
  assert.equal(auth.isSignedIn(), false)
})

/* ----------------------------------------------------------------- keepalive */

test('coming back to the app refreshes a due token before anything asks for one', async () => {
  installWindow()
  const { local } = installStorage()
  local.set(KEY, expiredSession())
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(refreshBody(1), { status: 200 })
  }
  const shown = []
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => shown.push([type, fn]),
  }

  const { installSessionKeepalive, isSignedIn } = await load()
  installSessionKeepalive()
  for (const [type, fn] of shown) if (type === 'visibilitychange') fn()
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(calls, 1, 'a phone waking with an hour-dead token refreshes quietly, not on the user')
  assert.ok(isSignedIn())
})

test('a keepalive tick with a live token asks the server nothing', async () => {
  installWindow()
  const { local } = installStorage()
  local.set(KEY, rotatedSession())
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('{}', { status: 200 })
  }
  const shown = []
  globalThis.document = { visibilityState: 'visible', addEventListener: (type, fn) => shown.push([type, fn]) }

  const { installSessionKeepalive } = await load()
  installSessionKeepalive()
  for (const [type, fn] of shown) if (type === 'visibilitychange') fn()
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(calls, 0, 'every foreground must not become a request')
})
