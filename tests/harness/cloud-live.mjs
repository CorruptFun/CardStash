/**
 * Live round-trip against a real Supabase project.
 *
 * The unit tests cover the two pure halves (crypto, merge). This covers the
 * half that can only fail in production: grants, RLS, the `put_vault` conflict
 * check, token refresh, and the pull-merge-push retry in `cloud.ts`. All of
 * that was written blind — the environment it was authored in could not reach
 * the Supabase host — so it needs a real network or it is not verified.
 *
 * It drives the REAL `src/lib/cloud.ts`, with only `./db` and `./settings`
 * stubbed (Dexie and zustand are browser-shaped). Two "devices" are two
 * separate bundles of the same module, each with its own localStorage and its
 * own in-memory collection, which is exactly the shape of the bug this feature
 * exists to prevent: two devices holding cards the other lacks.
 *
 * Needs a secret key to create and delete its own throwaway user:
 *
 *   SUPABASE_SECRET=sb_secret_... node tests/harness/cloud-live.mjs
 *
 * The user is deleted on the way out, including after a failure. Nothing here
 * touches a real person's account, and no email is ever sent — the test user
 * is created pre-confirmed and signs in with a password, so the project's
 * 2-emails-per-hour cap is irrelevant.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleImport } from '../unit/bundle.mjs'

const URL_BASE = (process.env.SUPABASE_URL ?? 'https://xvfuyvaehtdxroyzixak.supabase.co').replace(/\/+$/, '')
const PUBLISHABLE = process.env.SUPABASE_KEY ?? 'sb_publishable_G3bgfYDZWuFYzEufHf793A_i4Po9Y3E'
const SECRET = process.env.SUPABASE_SECRET
const PASSPHRASE = 'correct horse battery staple'

if (!SECRET) {
  console.error('SUPABASE_SECRET is required (service_role or sb_secret_… key).')
  process.exit(2)
}

const stubDir = mkdtempSync(join(tmpdir(), 'cardstock-live-'))
let pass = 0
const failures = []

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++
      console.log(`  ok  ${name}`)
    })
    .catch((err) => {
      failures.push(name)
      console.log(`  FAIL ${name}\n       ${err?.message ?? err}`)
    })
}

/* ------------------------------------------------------------------ fixtures */

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

const EMPTY = {
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
}

/* --------------------------------------------------------------- admin plumbing */

async function admin(path, init = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...init.headers },
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${body.slice(0, 300)}`)
  return body ? JSON.parse(body) : null
}

async function createUser(email, password) {
  const user = await admin('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  return user.id
}

/**
 * Read the vault as the signed-in user, over exactly the path the app uses.
 * Deliberately NOT the secret key: `service_role` has no grant on this table
 * and should not get one — the app never needs it, and a row that only the
 * account holder can fetch is a stronger claim to be verifying anyway.
 */
async function asUser(session, path) {
  const res = await fetch(`${URL_BASE}${path}`, {
    headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${session.access_token}` },
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${body.slice(0, 300)}`)
  return JSON.parse(body)
}

async function signIn(email, password) {
  const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

/* ------------------------------------------------------------------- a device */

/**
 * One simulated device: its own bundle of `cloud.ts` (so its in-memory session
 * and vault key are its own), its own localStorage, its own collection.
 */
async function makeDevice(label, session, rows = []) {
  const id = label.replace(/\W/g, '')
  const dbPath = join(stubDir, `db-${id}.mjs`)
  const setPath = join(stubDir, `settings-${id}.mjs`)

  // A faithful-enough stand-in for Dexie: importBackup replaces by primary
  // key exactly as bulkPut does, which is what the merge result assumes.
  //
  // State lives on globalThis, NOT in module scope. bundleImport *bundles*,
  // so the copy of this stub inside cloud.ts's bundle is a different module
  // instance from one the test imports directly — read that one and every
  // device looks frozen at its starting cards while sync silently works.
  writeFileSync(
    dbPath,
    `const SLOT = ${JSON.stringify(`__cardstock_db_${id}`)}
globalThis[SLOT] ??= ${JSON.stringify({ ...EMPTY, collection: rows })}
const get = () => globalThis[SLOT]
export const peek = get
export async function exportBackup() {
  return { ...get(), exportedAt: new Date().toISOString() }
}
export function sanitizeBackup(raw) {
  if (!raw || raw.app !== 'cardstock') throw new Error('Not a Cardstock backup file')
  return raw
}
export async function importBackup(raw) {
  const next = sanitizeBackup(raw)
  const merged = { ...get() }
  for (const table of ['collection','decks','deckCards','history','friends','trades','wants']) {
    const key = table === 'wants' ? 'key' : 'id'
    const at = new Map(merged[table].map((r, i) => [r[key], i]))
    const out = merged[table].slice()
    for (const row of next[table] ?? []) {
      const pos = at.get(row[key])
      if (pos === undefined) { at.set(row[key], out.length); out.push(row) } else out[pos] = row
    }
    merged[table] = out
  }
  globalThis[SLOT] = merged
}
`,
  )
  writeFileSync(
    setPath,
    `const state = { cloudSalt: '', cloudKeyCheck: '', cloudRevision: 0, cloudSyncedAt: 0,
  set(patch) { Object.assign(state, patch) } }
export const settings = () => state
`,
  )

  const store = new Map()
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  if (session) {
    storage.setItem(
      'cardstock-cloud-session',
      JSON.stringify({
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresAt: Date.now() + (session.expires_in - 60) * 1000,
        email: session.user?.email ?? '',
        userId: session.user?.id ?? '',
      }),
    )
  }

  const cloud = await bundleImport('src/lib/cloud.ts', {
    alias: { './db': dbPath, './settings': setPath },
  })
  const db = await import(`file://${dbPath}`)

  // cloud.ts reads these off the globals at call time, so swapping before each
  // call is what keeps two devices from sharing one session. Both are
  // getter-only on newer Node, hence defineProperty rather than assignment.
  const nav = { userAgent: `Mozilla/5.0 (${label})` }
  const enter = () => {
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true })
  }
  const wrap =
    (fn) =>
    (...args) => {
      enter()
      return fn(...args)
    }

  return {
    label,
    storage,
    cards: () => db.peek().collection.map((c) => c.id).sort(),
    qtyOf: (cardId) => db.peek().collection.find((c) => c.id === cardId)?.qty,
    add: (row) => db.peek().collection.push(row),
    unlock: wrap(cloud.unlock),
    syncNow: wrap(cloud.syncNow),
    signedInAs: wrap(cloud.signedInAs),
    raw: cloud,
  }
}

/* ---------------------------------------------------------------------- main */

const stamp = Math.random().toString(36).slice(2, 10)
const userA = { email: `cardstock-live-${stamp}-a@example.com`, password: `Aa1!${stamp}${stamp}` }
const userB = { email: `cardstock-live-${stamp}-b@example.com`, password: `Bb2!${stamp}${stamp}` }
const created = []

try {
  console.log(`\nLive cloud vault round-trip — ${URL_BASE}\n`)

  created.push(await createUser(userA.email, userA.password))
  created.push(await createUser(userB.email, userB.password))
  const sessionA1 = await signIn(userA.email, userA.password)
  const sessionA2 = await signIn(userA.email, userA.password)
  const sessionB = await signIn(userB.email, userB.password)
  console.log('  --  two throwaway users created, three sessions issued\n')

  // Two devices, ONE account — the case the vault exists for.
  const phone = await makeDevice('iPhone', sessionA1, [card('alpha'), card('shared', { qty: 3 })])
  const mac = await makeDevice('Macintosh', sessionA2, [card('shared', { qty: 3 }), card('beta')])

  await check('device A unlocks a brand-new vault (existing: false)', async () => {
    const out = await phone.unlock(PASSPHRASE)
    assert.equal(out.existing, false, 'a fresh account should not report an existing vault')
  })

  await check('device A pushes, revision starts at 1', async () => {
    const out = await phone.syncNow()
    assert.equal(out.pushed, true)
    assert.equal(out.revision, 1, `expected revision 1, got ${out.revision}`)
  })

  await check('the stored envelope is ciphertext, not readable JSON', async () => {
    const rows = await asUser(sessionA1, '/rest/v1/vaults?select=envelope,key_check,revision,device')
    assert.equal(rows.length, 1, 'exactly one vault row expected')
    const blob = JSON.stringify(rows[0].envelope)
    assert.ok(blob.length > 40, 'envelope suspiciously small')
    for (const leak of ['alpha', 'shared', 'mtg', 'nonfoil', 'collection', 'cardstock']) {
      assert.ok(!blob.includes(leak), `PLAINTEXT LEAK — found "${leak}" in the stored envelope`)
    }
    assert.equal(rows[0].device, 'iPhone', 'device label should name the writer')
  })

  await check('device B unlocks the SAME vault with the same passphrase', async () => {
    const out = await mac.unlock(PASSPHRASE)
    assert.equal(out.existing, true, 'second device should find the existing vault')
  })

  await check('a wrong passphrase is refused before any download', async () => {
    const other = await makeDevice('Windows', sessionA1, [])
    await assert.rejects(() => other.unlock('not the right passphrase'), /does not match/i)
  })

  await check('device B merges: both devices\' cards survive, qty is NOT summed', async () => {
    await mac.syncNow()
    assert.deepEqual(mac.cards(), ['alpha', 'beta', 'shared'], 'B should hold the union')
    assert.equal(mac.qtyOf('shared'), 3, 'qty must never be summed across devices')
  })

  await check('device A pulls B\'s additions on its next sync', async () => {
    await phone.syncNow()
    assert.deepEqual(phone.cards(), ['alpha', 'beta', 'shared'], 'A should converge on the union')
    assert.equal(phone.qtyOf('shared'), 3, 'qty must never be summed across devices')
  })

  await check('put_vault REJECTS a stale base revision', async () => {
    const current = (await asUser(sessionA1, '/rest/v1/vaults?select=revision'))[0].revision
    const res = await fetch(`${URL_BASE}/rest/v1/rpc/put_vault`, {
      method: 'POST',
      headers: {
        apikey: PUBLISHABLE,
        Authorization: `Bearer ${sessionA1.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_envelope: { v: 1 }, p_key_check: 'x', p_device: 'stale', p_base: current - 1 }),
    })
    const body = await res.text()
    assert.ok(!res.ok, 'a stale base must not be accepted')
    assert.match(body, /vault_conflict:\d+/, `expected vault_conflict, got ${body.slice(0, 200)}`)
    const after = (await asUser(sessionA1, '/rest/v1/vaults?select=revision'))[0].revision
    assert.equal(after, current, 'a rejected write must not have changed anything')
  })

  await check('two concurrent syncs both land — the loser pulls, merges and retries', async () => {
    phone.add(card('race-a'))
    mac.add(card('race-b'))
    const before = (await asUser(sessionA1, '/rest/v1/vaults?select=revision'))[0].revision
    await Promise.all([phone.syncNow(), mac.syncNow()])
    // Whoever lost the race re-read, merged and wrote again, so the server
    // must have moved by two and hold both cards.
    const after = (await asUser(sessionA1, '/rest/v1/vaults?select=revision'))[0].revision
    assert.ok(after >= before + 2, `expected at least two writes, revision went ${before} → ${after}`)
    await phone.syncNow()
    await mac.syncNow()
    assert.ok(phone.cards().includes('race-b'), 'A lost B\'s concurrent card')
    assert.ok(mac.cards().includes('race-a'), 'B lost A\'s concurrent card')
  })

  await check('the emailed-code path verifies and issues a session', async () => {
    // `admin/generate_link` mints the same OTP the email would carry without
    // sending anything, which is the only way to prove this path while the
    // project's mailer is capped at two messages an hour. It separates two
    // very different failures: a wrong request shape in verifyEmailCode (a
    // bug we own) from an email that never carries a code (infrastructure).
    const email = `cardstock-live-${stamp}-otp@example.com`
    const id = await createUser(email, `Otp!${stamp}${stamp}`)
    created.push(id)
    const link = await admin('/auth/v1/admin/generate_link', {
      method: 'POST',
      body: JSON.stringify({ type: 'magiclink', email }),
    })
    const otp = link.email_otp ?? link.properties?.email_otp
    assert.ok(otp, 'no OTP came back from generate_link')
    assert.equal(otp.length, 6, `the UI asks for six digits; the project is minting ${otp.length}`)

    const device = await makeDevice('OtpProbe', null, [])
    const session = await device.raw.verifyEmailCode(email, otp)
    assert.equal(session.email, email, 'the session should name the user who verified')
    assert.equal(device.signedInAs(), email, 'the session should be readable back from storage')
  })

  await check('RLS: another signed-in user cannot read this vault', async () => {
    const res = await fetch(`${URL_BASE}/rest/v1/vaults?select=envelope`, {
      headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${sessionB.access_token}` },
    })
    assert.ok(res.ok, `expected a clean empty result, got ${res.status}`)
    assert.deepEqual(await res.json(), [], 'another user must see zero rows, not our vault')
  })

  await check('RLS: an anonymous caller cannot read the table at all', async () => {
    const res = await fetch(`${URL_BASE}/rest/v1/vaults?select=envelope`, {
      headers: { apikey: PUBLISHABLE },
    })
    assert.ok(!res.ok, 'anon must be refused')
  })
} catch (err) {
  failures.push('harness')
  console.log(`\n  HARNESS ERROR: ${err?.stack ?? err}`)
} finally {
  for (const id of created) {
    await admin(`/auth/v1/admin/users/${id}`, { method: 'DELETE' }).catch((e) =>
      console.log(`  !! could not delete test user ${id}: ${e.message}`),
    )
  }
  console.log(`\n  cleaned up ${created.length} test user(s)`)
}

console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${pass} passed, ${failures.length} failed`)
if (failures.length) console.log(`  failing: ${failures.join(', ')}`)
process.exit(failures.length ? 1 : 0)
