/**
 * The shared card index's grants, proven against a real Supabase project.
 *
 * `psql` as `postgres` bypasses row-level security, so a schema read can only
 * ever show that these functions exist — never that the right people can call
 * them. This drives the same doors the app does: one anonymous caller and two
 * signed-in users against the live REST surface, with genuine JWTs.
 *
 * What it guards is the ASYMMETRY migration 0013 is built around, which is the
 * one thing about this table that is easy to get backwards in review:
 *
 *   * **Reading is anonymous.** `lookup_card_data()` must answer `anon`,
 *     called with the publishable key alone. If it ever stops, every signed-out
 *     user silently loses the pictures — and the free path is signed out.
 *   * **Writing is not.** `submit_card_data()` and `flag_card_data()` must
 *     refuse `anon`. Contributing is the only operation here that can hurt
 *     anyone: a wrong picture propagates to every device that asks for it.
 *   * **Nobody writes the tables directly.** Both are `revoke all` with RLS and
 *     no policies, so the RPCs are the only door. A stray grant would let a
 *     caller write any row's `submitted_by`, or read who contributed what.
 *
 * It also holds the functions to the promises their comments make: one live row
 * per person per card, `submitted_by` never returned to anyone, and an image
 * that is not a bounded inline raster dropped rather than stored.
 *
 * Needs a secret key to create and delete its own throwaway users:
 *
 *   SUPABASE_SECRET=sb_secret_... node tests/harness/cardsource-rls.mjs
 *
 * Point it at another stack with SUPABASE_URL/SUPABASE_KEY. It cleans up after
 * itself: `card_data.submitted_by` is `on delete set null` (a contribution
 * outlives the account, deliberately), so deleting the users is NOT enough —
 * the rows are deleted explicitly.
 */

const URL_BASE = (process.env.SUPABASE_URL ?? 'https://xvfuyvaehtdxroyzixak.supabase.co').replace(/\/+$/, '')
const PUBLISHABLE = process.env.SUPABASE_KEY ?? 'sb_publishable_G3bgfYDZWuFYzEufHf793A_i4Po9Y3E'
const SECRET = process.env.SUPABASE_SECRET

if (!SECRET) {
  console.error('SUPABASE_SECRET is required (service_role or sb_secret_… key).')
  process.exit(2)
}

let pass = 0
const failures = []
const created = []
/** Card ids this run invented, so teardown can find its own litter. */
const cardIds = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    failures.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const section = (n, title) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`)

const headers = (token, extra = {}) => ({
  apikey: PUBLISHABLE,
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  ...extra,
})

async function rest(token, path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1${path}`, { ...init, headers: headers(token, init.headers) })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const rpc = (token, fn, args) => rest(token, `/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args ?? {}) })

/**
 * Anonymous: the publishable key as apikey AND as bearer, which is exactly
 * what `anonRpc` in cardsource.ts sends. Never a user token.
 */
const anonRpc = (fn, args) => rpc(PUBLISHABLE, fn, args)

async function admin(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1${path}`, {
    ...init,
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...init.headers },
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

async function makeUser(email) {
  const password = 'probe-password-123456'
  const res = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const user = await res.json()
  if (!user.id) throw new Error(`could not create ${email}: ${JSON.stringify(user)}`)
  created.push(user.id)
  const signIn = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const session = await signIn.json()
  if (!session.access_token) throw new Error(`could not sign in ${email}: ${JSON.stringify(session)}`)
  return { id: user.id, token: session.access_token }
}

function must(res, what) {
  if (res.status >= 400) throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res
}

async function cleanup() {
  for (const id of cardIds) await admin(`/card_data?card_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' })
  for (const id of created) {
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
    })
  }
}

/** A 1x1 WebP — the smallest thing that is genuinely a bounded inline raster. */
const IMAGE = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA='
const stamp = Date.now()
const CARD = `mtg:custom-probe-${stamp}`
const CARD_B = `mtg:custom-probe-b-${stamp}`
cardIds.push(CARD, CARD_B)

console.log(`\ncard-source RLS harness → ${URL_BASE}`)

try {
  const alice = await makeUser(`cardsource-a-${stamp}@example.com`)
  const bob = await makeUser(`cardsource-b-${stamp}@example.com`)

  // ---------------------------------------------------------------------- 1
  section(1, 'The migration is actually applied')

  const probe = await anonRpc('lookup_card_data', { p_ids: [CARD] })
  check(
    'lookup_card_data exists (a 404 here means 0013 was never applied)',
    probe.status !== 404,
    `${probe.status} ${JSON.stringify(probe.body).slice(0, 120)}`,
  )
  if (probe.status === 404) throw new Error('0013_card_source.sql is not applied — nothing below can pass')

  // ---------------------------------------------------------------------- 2
  section(2, 'Reading is anonymous, and that is deliberate')

  check('anon may call lookup_card_data', probe.status === 200, `${probe.status}`)
  const anonSearch = await anonRpc('search_card_data', { p_game: 'mtg', p_query: 'probe' })
  check('anon may call search_card_data', anonSearch.status === 200, `${anonSearch.status}`)

  // ---------------------------------------------------------------------- 3
  section(3, 'Writing is attributed — anon must be refused')

  const anonSubmit = await anonRpc('submit_card_data', {
    p_card_id: CARD,
    p_game: 'mtg',
    p_fields: { name: 'Anonymous Vandal' },
    p_image: IMAGE,
  })
  check(
    'anon may NOT submit card data',
    anonSubmit.status >= 400 && anonSubmit.status !== 404,
    `${anonSubmit.status} ${JSON.stringify(anonSubmit.body).slice(0, 120)}`,
  )

  const anonFlag = await anonRpc('flag_card_data', { p_card_id: CARD })
  check('anon may NOT flag card data', anonFlag.status >= 400 && anonFlag.status !== 404, `${anonFlag.status}`)

  // ---------------------------------------------------------------------- 4
  section(4, 'Nobody touches the tables directly — the RPCs are the only door')

  for (const [who, token] of [
    ['anon', PUBLISHABLE],
    ['a signed-in user', alice.token],
  ]) {
    const read = await rest(token, '/card_data?select=card_id,submitted_by&limit=1')
    check(`${who} may NOT read card_data directly`, read.status >= 400, `${read.status}`)
    const write = await rest(token, '/card_data', {
      method: 'POST',
      body: JSON.stringify({ card_id: CARD, game: 'mtg', fields: {} }),
    })
    check(`${who} may NOT insert into card_data directly`, write.status >= 400, `${write.status}`)
    const flags = await rest(token, '/card_data_flags?select=user_id&limit=1')
    check(`${who} may NOT read card_data_flags directly`, flags.status >= 400, `${flags.status}`)
  }

  // ---------------------------------------------------------------------- 5
  section(5, 'A signed-in user can contribute, and it comes back to everyone')

  const submit = must(
    await rpc(alice.token, 'submit_card_data', {
      p_card_id: CARD,
      p_game: 'mtg',
      p_fields: { name: 'Probe Promo', setCode: 'PRB', number: '1' },
      p_image: IMAGE,
      p_image_hash: 'probehash',
      p_custom: true,
    }),
    'alice submits',
  )
  check('a signed-in user may submit', submit.status === 200)

  const fetched = await anonRpc('lookup_card_data', { p_ids: [CARD] })
  const row = Array.isArray(fetched.body) ? fetched.body[0] : null
  check('an anonymous reader gets the contribution back', row?.card_id === CARD, JSON.stringify(fetched.body).slice(0, 140))
  check('the image survives the round trip', row?.image === IMAGE)
  check('the typed fields survive', row?.fields?.name === 'Probe Promo')

  // ---------------------------------------------------------------------- 6
  section(6, 'What the index must never leak')

  check(
    'lookup_card_data never returns who contributed',
    row != null && !('submitted_by' in row),
    Object.keys(row ?? {}).join(','),
  )

  // ---------------------------------------------------------------------- 7
  section(7, 'One live row per person per card')

  must(
    await rpc(alice.token, 'submit_card_data', {
      p_card_id: CARD,
      p_game: 'mtg',
      p_fields: { name: 'Probe Promo Corrected' },
      p_image: IMAGE,
    }),
    'alice re-submits',
  )
  const mine = await admin(`/card_data?card_id=eq.${encodeURIComponent(CARD)}&submitted_by=eq.${alice.id}&select=id`)
  check(
    're-submitting UPDATES the contributor’s row rather than adding a second',
    Array.isArray(mine.body) && mine.body.length === 1,
    `${Array.isArray(mine.body) ? mine.body.length : '?'} rows`,
  )

  const bobSubmit = await rpc(bob.token, 'submit_card_data', {
    p_card_id: CARD,
    p_game: 'mtg',
    p_fields: { name: 'Probe Promo, Better Photo' },
    p_image: IMAGE,
  })
  check('a DIFFERENT person may contribute to the same card', bobSubmit.status === 200, `${bobSubmit.status}`)

  // ---------------------------------------------------------------------- 8
  section(8, 'Submissions are validated, not merely stored')

  const badGame = await rpc(alice.token, 'submit_card_data', {
    p_card_id: 'pokemon:whatever',
    p_game: 'mtg',
    p_fields: { name: 'Mismatched' },
  })
  check('a card id that disagrees with its game is refused', badGame.status >= 400, `${badGame.status}`)

  const emptyOne = await rpc(alice.token, 'submit_card_data', { p_card_id: CARD_B, p_game: 'mtg', p_fields: {} })
  check('a submission with nothing in it is refused', emptyOne.status >= 400, `${emptyOne.status}`)

  must(
    await rpc(alice.token, 'submit_card_data', {
      p_card_id: CARD_B,
      p_game: 'mtg',
      p_fields: { name: 'Remote Image Probe' },
      // Every client renders this in an <img src>. A URL is not storable here.
      p_image: 'https://example.test/not-inline.png',
    }),
    'alice submits with a remote image',
  )
  const scrubbed = await anonRpc('lookup_card_data', { p_ids: [CARD_B] })
  const scrubbedRow = Array.isArray(scrubbed.body) ? scrubbed.body[0] : null
  check(
    'a non-inline image is dropped, while the rest of the submission is kept',
    scrubbedRow?.image == null && scrubbedRow?.fields?.name === 'Remote Image Probe',
    JSON.stringify(scrubbedRow).slice(0, 140),
  )

  // ---------------------------------------------------------------------- 9
  section(9, 'Flagging is one vote per account')

  const flag1 = await rpc(bob.token, 'flag_card_data', { p_card_id: CARD })
  check('a signed-in user may flag', flag1.status === 200, `${flag1.status}`)
  const flag2 = await rpc(bob.token, 'flag_card_data', { p_card_id: CARD })
  check('flagging twice is idempotent, not an error', flag2.status === 200, `${flag2.status}`)

  const counted = await admin(`/card_data?card_id=eq.${encodeURIComponent(CARD)}&select=flags&order=flags.desc`)
  const top = Array.isArray(counted.body) ? counted.body[0]?.flags : null
  check('one account produces exactly one flag', top === 1, `flags=${top}`)

  // --------------------------------------------------------------------- 10
  section(10, 'Controls — a refusal must mean refusal, not absence')

  const ghost = await anonRpc('definitely_not_a_function', {})
  check('a nonexistent RPC 404s', ghost.status === 404, `${ghost.status}`)
  check(
    'the anon refusals above were refusals, not missing functions',
    anonSubmit.status !== 404 && anonFlag.status !== 404,
    `${anonSubmit.status}/${anonFlag.status}`,
  )
  const exists = await admin('/card_data?select=card_id&limit=1')
  check('card_data is really there (service role reads it)', exists.status === 200, `${exists.status}`)
} catch (err) {
  failures.push(`threw: ${err?.message ?? err}`)
  console.log(`\n\x1b[31mthrew\x1b[0m — ${err?.stack ?? err}`)
} finally {
  await cleanup()
}

console.log(`\n\x1b[1m${pass} passed, ${failures.length} failed\x1b[0m`)
if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m-\x1b[0m ${f}`)
  process.exit(1)
}
