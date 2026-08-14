/**
 * The hosted-social visibility rule, proven against a real Supabase project.
 *
 * `psql` as `postgres` bypasses row-level security, so it can only ever show
 * that tables and policies exist — never that they work. This drives the same
 * doors the app will: four signed-in users and one anonymous caller against
 * the live REST surface, with genuine JWTs.
 *
 * What it is really guarding is one sentence from docs/social.md and decision
 * 16: a `trade` binder is readable by any signed-in user, an `all` binder only
 * by accepted friends, and a friends-only binder is never globally matchable
 * through the offers index. Those are three policies and one RPC that look
 * correct in review whether or not they are, which is exactly the kind of
 * thing that needs a test rather than a reading.
 *
 * Needs a secret key to create and delete its own throwaway users:
 *
 *   SUPABASE_SECRET=sb_secret_... node tests/harness/social-rls.mjs
 *
 * Point it at a local stack with SUPABASE_URL/SUPABASE_KEY. Users are deleted
 * on the way out, including after a failure — and deleting them cascades every
 * row this test wrote, so the project is left as it was found.
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

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    failures.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

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

async function makeUser(email) {
  const password = 'probe-password-123456'
  const admin = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const user = await admin.json()
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

async function cleanup() {
  for (const id of created) {
    // Deleting the auth user cascades profiles/binders/offers/inbox/friendships.
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
    }).catch(() => {})
  }
}

const stamp = Date.now()
const LOTUS = 'mtg|black lotus'
const SHIVAN = 'mtg|shivan dragon'
const binderPayload = (name, scope) => ({
  app: 'cardstock-social',
  v: 1,
  kind: 'profile',
  id: name,
  name,
  scope,
  at: stamp,
  cards: [
    { cardId: 'mtg:abc', game: 'mtg', name: 'Black Lotus', finish: 'nonfoil', condition: 'NM', qty: 1, forTrade: 1 },
  ],
})
const tradePayload = {
  app: 'cardstock-social',
  v: 1,
  kind: 'trade',
  id: `t${stamp}`,
  at: stamp,
  from: { id: 'carol', name: 'Carol' },
  offer: [],
  want: [],
}

try {
  console.log(`\nHosted social RLS — ${URL_BASE}`)

  const alice = await makeUser(`alice+${stamp}@probe.test`)
  const bob = await makeUser(`bob+${stamp}@probe.test`)
  const carol = await makeUser(`carol+${stamp}@probe.test`)
  const dave = await makeUser(`dave+${stamp}@probe.test`)

  console.log('\n\x1b[1m1. Identity\x1b[0m')
  const claim = await rpc(alice.token, 'set_profile', { p_handle: `alice${stamp}`, p_display_name: 'Alice' })
  check('set_profile claims a handle', claim.status === 200, `${claim.status} ${JSON.stringify(claim.body)}`)
  await rpc(bob.token, 'set_profile', { p_handle: `bob${stamp}`, p_display_name: 'Bob' })
  await rpc(carol.token, 'set_profile', { p_handle: `carol${stamp}`, p_display_name: 'Carol' })
  await rpc(dave.token, 'set_profile', { p_handle: `dave${stamp}`, p_display_name: 'Dave' })

  const dupe = await rpc(bob.token, 'set_profile', { p_handle: `alice${stamp}`, p_display_name: 'Impostor' })
  check('a taken handle is refused', JSON.stringify(dupe.body).includes('handle_taken'), JSON.stringify(dupe.body))
  const reserved = await rpc(bob.token, 'set_profile', { p_handle: 'support', p_display_name: 'Nope' })
  check('a reserved handle is refused', JSON.stringify(reserved.body).includes('handle_reserved'), JSON.stringify(reserved.body))
  const malformed = await rpc(bob.token, 'set_profile', { p_handle: 'No Spaces!', p_display_name: 'Nope' })
  check('a malformed handle is refused', JSON.stringify(malformed.body).includes('bad_handle'), JSON.stringify(malformed.body))

  const resolve = await rest(carol.token, `/profiles?handle=eq.alice${stamp}&select=handle,display_name`)
  check('any signed-in user resolves a handle', resolve.status === 200 && resolve.body?.length === 1, JSON.stringify(resolve.body))
  const anonDir = await rest(PUBLISHABLE, '/profiles?select=handle')
  check('anonymous cannot read the directory', anonDir.status !== 200 || anonDir.body?.length === 0, `${anonDir.status}`)

  console.log('\n\x1b[1m2. The visibility rule\x1b[0m')
  const alicePub = await rpc(alice.token, 'publish_binder', {
    p_scope: 'trade',
    p_payload: binderPayload('Alice', 'trade'),
    p_card_count: 1,
    p_want_count: 0,
    p_offers: [{ want_key: LOTUS, game: 'mtg', name: 'Black Lotus', qty: 1 }],
  })
  check('publish a trade binder', alicePub.status === 200, `${alicePub.status} ${JSON.stringify(alicePub.body)}`)
  const bobPub = await rpc(bob.token, 'publish_binder', {
    p_scope: 'all',
    p_payload: binderPayload('Bob', 'all'),
    p_card_count: 1,
    p_want_count: 0,
    p_offers: [{ want_key: SHIVAN, game: 'mtg', name: 'Shivan Dragon', qty: 1 }],
  })
  check('publish an everything binder', bobPub.status === 200, `${bobPub.status} ${JSON.stringify(bobPub.body)}`)

  const readsTrade = await rest(carol.token, `/binders?user_id=eq.${alice.id}&select=scope`)
  check("a STRANGER CAN read a 'trade' binder", readsTrade.body?.length === 1, JSON.stringify(readsTrade.body))
  const readsAll = await rest(carol.token, `/binders?user_id=eq.${bob.id}&select=scope`)
  check("a STRANGER CANNOT read an 'all' binder", readsAll.body?.length === 0, JSON.stringify(readsAll.body))
  const own = await rest(bob.token, `/binders?user_id=eq.${bob.id}&select=scope`)
  check('an owner always reads their own binder', own.body?.length === 1, JSON.stringify(own.body))
  const anonBinders = await rest(PUBLISHABLE, '/binders?select=user_id')
  check('anonymous reads no binder', anonBinders.status !== 200 || anonBinders.body?.length === 0, `${anonBinders.status}`)
  const forge = await rest(carol.token, '/binders', {
    method: 'POST',
    body: JSON.stringify({ user_id: bob.id, scope: 'trade', payload: {} }),
  })
  check("cannot publish under someone else's user_id", forge.status >= 400, `${forge.status}`)

  console.log('\n\x1b[1m3. Friendship is the consent gate\x1b[0m')
  const req = await rpc(carol.token, 'request_friend', { p_handle: `bob${stamp}` })
  check('request_friend by handle returns pending', req.body === 'pending', JSON.stringify(req.body))
  const pendingRead = await rest(carol.token, `/binders?user_id=eq.${bob.id}&select=scope`)
  check('a PENDING request unlocks nothing', pendingRead.body?.length === 0, JSON.stringify(pendingRead.body))

  const selfAccept = await rest(carol.token, `/friendships?requester=eq.${carol.id}&addressee=eq.${bob.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'accepted' }),
  })
  check('the REQUESTER cannot accept their own request', !Array.isArray(selfAccept.body) || selfAccept.body.length === 0, `${selfAccept.status} ${JSON.stringify(selfAccept.body)}`)
  const afterSelfAccept = await rest(carol.token, `/binders?user_id=eq.${bob.id}&select=scope`)
  check('…and it unlocked nothing', afterSelfAccept.body?.length === 0, JSON.stringify(afterSelfAccept.body))

  const accept = await rest(bob.token, `/friendships?requester=eq.${carol.id}&addressee=eq.${bob.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'accepted' }),
  })
  check('the ADDRESSEE can accept', Array.isArray(accept.body) && accept.body.length === 1, `${accept.status}`)
  const friendRead = await rest(carol.token, `/binders?user_id=eq.${bob.id}&select=scope`)
  check("an ACCEPTED FRIEND CAN read the 'all' binder", friendRead.body?.length === 1, JSON.stringify(friendRead.body))
  const thirdParty = await rest(alice.token, `/binders?user_id=eq.${bob.id}&select=scope`)
  check('a third party still cannot', thirdParty.body?.length === 0, JSON.stringify(thirdParty.body))

  console.log('\n\x1b[1m4. The want index is a lookup, not a dump\x1b[0m')
  const dump = await rest(carol.token, '/trade_offers?select=user_id,want_key')
  check('trade_offers refuses a direct read', dump.status >= 400 || dump.body?.length === 0, `${dump.status} ${JSON.stringify(dump.body)}`)
  const match = await rpc(carol.token, 'match_wants', { p_keys: [LOTUS, SHIVAN] })
  const matched = Array.isArray(match.body) ? match.body : []
  check('match_wants finds the trade-binder holder', matched.some((r) => r.want_key === LOTUS && r.user_id === alice.id), JSON.stringify(matched))
  check('match_wants EXCLUDES the friends-only publisher', !matched.some((r) => r.user_id === bob.id), JSON.stringify(matched))
  const selfMatch = await rpc(alice.token, 'match_wants', { p_keys: [LOTUS] })
  check('match_wants excludes the caller', (selfMatch.body ?? []).length === 0, JSON.stringify(selfMatch.body))
  const anonMatch = await rpc(PUBLISHABLE, 'match_wants', { p_keys: [LOTUS] })
  check('match_wants refuses anonymous', anonMatch.status >= 400, `${anonMatch.status}`)

  await rpc(alice.token, 'publish_binder', {
    p_scope: 'all',
    p_payload: binderPayload('Alice', 'all'),
    p_card_count: 1,
    p_want_count: 0,
    p_offers: [{ want_key: LOTUS, game: 'mtg', name: 'Black Lotus', qty: 1 }],
  })
  const afterFlip = await rpc(carol.token, 'match_wants', { p_keys: [LOTUS] })
  check("switching 'trade' -> 'all' evicts from the global index", (afterFlip.body ?? []).length === 0, JSON.stringify(afterFlip.body))
  await rpc(alice.token, 'publish_binder', {
    p_scope: 'trade',
    p_payload: binderPayload('Alice', 'trade'),
    p_card_count: 1,
    p_want_count: 0,
    p_offers: [{ want_key: LOTUS, game: 'mtg', name: 'Black Lotus', qty: 1 }],
  })

  console.log('\n\x1b[1m5. The trade inbox\x1b[0m')
  const send = await rpc(carol.token, 'send_to_inbox', { p_recipient: alice.id, p_payload: tradePayload })
  check('can send to a trade-binder publisher', send.status === 200, `${send.status} ${JSON.stringify(send.body)}`)
  const inbox = await rest(alice.token, '/inbox?select=id,sender')
  check('the recipient reads it', inbox.body?.length === 1, JSON.stringify(inbox.body))
  check('sender is stamped server-side', inbox.body?.[0]?.sender === carol.id, JSON.stringify(inbox.body?.[0]))
  const senderReads = await rest(carol.token, '/inbox?select=id')
  check('the SENDER cannot read it back', (senderReads.body ?? []).length === 0, JSON.stringify(senderReads.body))
  const directInsert = await rest(carol.token, '/inbox', {
    method: 'POST',
    body: JSON.stringify({ recipient: alice.id, sender: alice.id, payload: {} }),
  })
  check('direct INSERT is refused (no policy)', directInsert.status >= 400, `${directInsert.status}`)

  const unreachable = await rpc(carol.token, 'send_to_inbox', { p_recipient: dave.id, p_payload: tradePayload })
  check('an unpublished, unfriended user is unreachable', JSON.stringify(unreachable.body).includes('not_reachable'), JSON.stringify(unreachable.body))
  const selfSend = await rpc(carol.token, 'send_to_inbox', { p_recipient: carol.id, p_payload: tradePayload })
  check('cannot send to yourself', JSON.stringify(selfSend.body).includes('bad_recipient'), JSON.stringify(selfSend.body))

  for (let i = 0; i < 21; i++) await rpc(carol.token, 'send_to_inbox', { p_recipient: alice.id, p_payload: tradePayload })
  const capped = await rpc(carol.token, 'send_to_inbox', { p_recipient: alice.id, p_payload: tradePayload })
  check('the per-pair rate cap holds at 20', JSON.stringify(capped.body).includes('inbox_full'), JSON.stringify(capped.body))
  const cleared = await rest(alice.token, `/inbox?recipient=eq.${alice.id}`, { method: 'DELETE' })
  check('the recipient can clear their inbox', cleared.status < 300, `${cleared.status}`)

  console.log('\n\x1b[1m6. Erasure leaves the vault alone\x1b[0m')
  await rest(alice.token, '/rpc/put_vault', {
    method: 'POST',
    body: JSON.stringify({
      p_envelope: { v: 1, salt: 'x', iv: 'y', ct: 'z' },
      p_key_check: 'kc',
      p_device: 'probe',
      p_base: 0,
    }),
  })
  const vaultBefore = await rest(alice.token, '/vaults?select=revision')
  check('the user has a vault row', vaultBefore.body?.length === 1, JSON.stringify(vaultBefore.body))
  const erase = await rpc(alice.token, 'erase_social')
  check('erase_social succeeds', erase.status < 300, `${erase.status} ${JSON.stringify(erase.body)}`)
  const profileGone = await rest(alice.token, `/profiles?user_id=eq.${alice.id}&select=handle`)
  check('the profile is gone', (profileGone.body ?? []).length === 0, JSON.stringify(profileGone.body))
  const binderGone = await rest(alice.token, `/binders?user_id=eq.${alice.id}&select=scope`)
  check('the binder is gone', (binderGone.body ?? []).length === 0, JSON.stringify(binderGone.body))
  const indexGone = await rpc(carol.token, 'match_wants', { p_keys: [LOTUS] })
  check('the want-index entry is gone', (indexGone.body ?? []).length === 0, JSON.stringify(indexGone.body))
  const vaultAfter = await rest(alice.token, '/vaults?select=revision')
  check('THE VAULT SURVIVES', vaultAfter.body?.length === 1, JSON.stringify(vaultAfter.body))

  console.log('\n\x1b[1m7. Controls — a refusal must mean refusal, not absence\x1b[0m')
  const ghost = await rpc(carol.token, 'definitely_not_a_function', {})
  check('a nonexistent RPC 404s', ghost.status === 404, `${ghost.status}`)
  const refused = await rpc(PUBLISHABLE, 'erase_social', {})
  check('a real RPC refuses anon without 404ing', refused.status !== 404 && refused.status >= 400, `${refused.status}`)
} catch (err) {
  failures.push(`threw: ${err?.message ?? err}`)
  console.error(`\n\x1b[31m${err?.stack ?? err}\x1b[0m`)
} finally {
  await cleanup()
  console.log(`\ncleaned up ${created.length} throwaway users`)
}

console.log(`\n\x1b[1m${pass} passed, ${failures.length} failed\x1b[0m`)
if (failures.length) {
  for (const f of failures) console.log(`  \x1b[31m-\x1b[0m ${f}`)
  process.exit(1)
}
