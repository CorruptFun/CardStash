/**
 * The catalog mirror's grants (migration 0021), proven against a real
 * Supabase project — schema reads can show the functions exist, never that
 * the right callers can use them and the wrong ones cannot.
 *
 * What it guards, in one line each:
 *
 *   * **Reading is anonymous.** The three lookup RPCs must answer the
 *     publishable key alone — the free path is signed out.
 *   * **There is no user door at all.** Unlike card_data, not even
 *     `authenticated` may write (or read) the table directly: rows come only
 *     from the operator sync worker with the service key. A stray grant here
 *     would let anyone poison what every scanner falls back on.
 *   * **Normalization is real.** "0321" must find a row stored as "321", and
 *     "085" one stored as "EN085" — the shapes cardcode.ts produces.
 *
 * Run after applying 0021 and after any migration touching catalog_printings:
 *
 *   SUPABASE_SECRET=sb_secret_... node tests/harness/catalog-rls.mjs
 *
 * Point at another stack with SUPABASE_URL/SUPABASE_KEY. Creates one
 * throwaway user and its own mirror rows; deletes both on the way out.
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

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    failures.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const anonHeaders = { apikey: PUBLISHABLE, 'Content-Type': 'application/json' }
const serviceHeaders = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }
const userHeaders = (token) => ({ apikey: PUBLISHABLE, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

const rpc = (fn, body, headers) =>
  fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) })

const STAMP = Date.now().toString(36)
const API_ID = `rls-harness-${STAMP}`

async function makeUser() {
  const email = `catalog-rls-${STAMP}@harness.invalid`
  const password = `Harness-${STAMP}-pw!`
  const created = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: serviceHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  if (!created.ok) throw new Error(`admin create user: HTTP ${created.status} ${await created.text()}`)
  const { id } = await created.json()
  const login = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: anonHeaders,
    body: JSON.stringify({ email, password }),
  })
  if (!login.ok) throw new Error(`login: HTTP ${login.status} ${await login.text()}`)
  return { id, token: (await login.json()).access_token }
}

async function main() {
  console.log(`catalog mirror RLS harness against ${URL_BASE}`)
  const user = await makeUser()

  try {
    /* --- seed as service_role: the one legitimate writer ------------------ */
    const seed = await fetch(`${URL_BASE}/rest/v1/catalog_printings?on_conflict=game,api_id,set_code`, {
      method: 'POST',
      headers: { ...serviceHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([
        {
          game: 'mtg',
          api_id: API_ID,
          name: `Harness Bolt ${STAMP}`,
          slug: `harness bolt ${STAMP}`,
          set_code: 'HRN',
          collector_number: '321',
          rarity: 'test',
          image_url: 'https://example.invalid/harness.jpg',
          art_hash: '0'.repeat(64),
        },
        {
          game: 'yugioh',
          api_id: API_ID,
          name: `Harness Dragon ${STAMP}`,
          slug: `harness dragon ${STAMP}`,
          set_code: 'HRN',
          collector_number: 'EN085',
        },
      ]),
    })
    check('service_role can upsert mirror rows', seed.ok, `HTTP ${seed.status}`)

    /* --- the anonymous read half ------------------------------------------ */
    const byCode = await rpc('catalog_by_code', { p_game: 'mtg', p_set: 'hrn', p_number: '0321' }, anonHeaders)
    const codeRows = byCode.ok ? await byCode.json() : []
    check(
      'anon reads by code, case- and zero-insensitively ("hrn 0321" finds HRN 321)',
      byCode.ok && codeRows.some((r) => r.api_id === API_ID),
      `HTTP ${byCode.status}`,
    )

    const digits = await rpc('catalog_by_code', { p_game: 'yugioh', p_set: 'HRN', p_number: '085' }, anonHeaders)
    const digitRows = digits.ok ? await digits.json() : []
    check(
      'anon digits-only number finds an EN-prefixed printing ("085" → EN085)',
      digits.ok && digitRows.some((r) => r.api_id === API_ID),
      `HTTP ${digits.status}`,
    )

    const byName = await rpc('catalog_by_name', { p_game: 'mtg', p_query: `Harness Bolt ${STAMP}` }, anonHeaders)
    const nameRows = byName.ok ? await byName.json() : []
    check('anon searches by name', byName.ok && nameRows.some((r) => r.api_id === API_ID), `HTTP ${byName.status}`)

    const printings = await rpc(
      'catalog_printings_of',
      { p_game: 'mtg', p_name: `Harness Bolt ${STAMP}` },
      anonHeaders,
    )
    const printRows = printings.ok ? await printings.json() : []
    check(
      'anon lists printings of a card, art_hash included',
      printings.ok && printRows.some((r) => r.api_id === API_ID && r.art_hash === '0'.repeat(64)),
      `HTTP ${printings.status}`,
    )

    /* --- no other door ---------------------------------------------------- */
    const anonSelect = await fetch(`${URL_BASE}/rest/v1/catalog_printings?select=api_id&limit=1`, {
      headers: anonHeaders,
    })
    check('anon cannot read the table directly', !anonSelect.ok, `HTTP ${anonSelect.status}`)

    const anonInsert = await fetch(`${URL_BASE}/rest/v1/catalog_printings`, {
      method: 'POST',
      headers: anonHeaders,
      body: JSON.stringify({ game: 'mtg', api_id: 'defaced', name: 'Defaced', slug: 'defaced' }),
    })
    check('anon cannot insert', !anonInsert.ok, `HTTP ${anonInsert.status}`)

    const userSelect = await fetch(`${URL_BASE}/rest/v1/catalog_printings?select=api_id&limit=1`, {
      headers: userHeaders(user.token),
    })
    check('a signed-in user cannot read the table directly either', !userSelect.ok, `HTTP ${userSelect.status}`)

    const userInsert = await fetch(`${URL_BASE}/rest/v1/catalog_printings`, {
      method: 'POST',
      headers: userHeaders(user.token),
      body: JSON.stringify({ game: 'mtg', api_id: 'defaced2', name: 'Defaced', slug: 'defaced' }),
    })
    check('a signed-in user cannot insert — there is no user door at all', !userInsert.ok, `HTTP ${userInsert.status}`)

    const userUpdate = await fetch(`${URL_BASE}/rest/v1/catalog_printings?api_id=eq.${API_ID}`, {
      method: 'PATCH',
      headers: userHeaders(user.token),
      body: JSON.stringify({ name: 'Defaced' }),
    })
    // PostgREST answers 404 or a permission error for a table the role cannot
    // touch; what it must never answer is a 2xx that changed a row.
    check('a signed-in user cannot update', !userUpdate.ok, `HTTP ${userUpdate.status}`)

    /* --- shape guards actually hold --------------------------------------- */
    const badHash = await fetch(`${URL_BASE}/rest/v1/catalog_printings?on_conflict=game,api_id,set_code`, {
      method: 'POST',
      headers: { ...serviceHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([
        { game: 'mtg', api_id: `${API_ID}-bad`, name: 'Bad Hash', slug: 'bad hash', art_hash: 'NOT-HEX' },
      ]),
    })
    check('a malformed art_hash is refused even from the service key', !badHash.ok, `HTTP ${badHash.status}`)

    const badImage = await fetch(`${URL_BASE}/rest/v1/catalog_printings?on_conflict=game,api_id,set_code`, {
      method: 'POST',
      headers: { ...serviceHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([
        { game: 'mtg', api_id: `${API_ID}-bad2`, name: 'Bad Image', slug: 'bad image', image_url: 'http://x/y.jpg' },
      ]),
    })
    check('a non-https image_url is refused', !badImage.ok, `HTTP ${badImage.status}`)
  } finally {
    /* --- teardown: this run's rows and its user --------------------------- */
    await fetch(`${URL_BASE}/rest/v1/catalog_printings?api_id=like.${API_ID}*`, {
      method: 'DELETE',
      headers: serviceHeaders,
    }).catch(() => {})
    await fetch(`${URL_BASE}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: serviceHeaders }).catch(
      () => {},
    )
  }

  console.log(failures.length ? `\n${pass} passed, ${failures.length} FAILED: ${failures.join('; ')}` : `\n${pass} passed`)
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
