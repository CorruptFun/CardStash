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
  // `handle_claims` deliberately does NOT cascade — a deleted account retires
  // its handle forever (0010). That is right for a person and wrong for a test
  // account, so this run's handles are swept explicitly. Without it every run
  // against the real project would permanently burn five names.
  await fetch(`${URL_BASE}/rest/v1/handle_claims?handle=like.*${stamp}`, {
    method: 'DELETE',
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
  }).catch(() => {})
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

  // These have to be asked by someone who has claimed NOTHING yet. Since 0010
  // a caller who already has a handle is refused for that reason first — the
  // name they asked for stops mattering — so asking bob would prove only that
  // permanence works, and silently stop testing what it says on the label.
  const frank = await makeUser(`frank+${stamp}@probe.test`)
  const dupe = await rpc(frank.token, 'set_profile', { p_handle: `alice${stamp}`, p_display_name: 'Impostor' })
  check('a taken handle is refused', JSON.stringify(dupe.body).includes('handle_taken'), JSON.stringify(dupe.body))
  const reserved = await rpc(frank.token, 'set_profile', { p_handle: 'support', p_display_name: 'Nope' })
  check('a reserved handle is refused', JSON.stringify(reserved.body).includes('handle_reserved'), JSON.stringify(reserved.body))
  const malformed = await rpc(frank.token, 'set_profile', { p_handle: 'No Spaces!', p_display_name: 'Nope' })
  check('a malformed handle is refused', JSON.stringify(malformed.body).includes('bad_handle'), JSON.stringify(malformed.body))
  const stillNone = await rest(carol.token, `/profiles?user_id=eq.${frank.id}&select=handle`)
  check('...and none of those left a half-made profile', (stillNone.body ?? []).length === 0, JSON.stringify(stillNone.body))

  const resolve = await rest(carol.token, `/profiles?handle=eq.alice${stamp}&select=handle,display_name`)
  check('any signed-in user resolves a handle', resolve.status === 200 && resolve.body?.length === 1, JSON.stringify(resolve.body))
  const anonDir = await rest(PUBLISHABLE, '/profiles?select=handle')
  check('anonymous cannot read the directory', anonDir.status !== 200 || anonDir.body?.length === 0, `${anonDir.status}`)

  // A handle that can come to mean a second person is an impersonation
  // primitive — `request_friend` resolves one at the moment it is called. These
  // are the guards from migration 0010, and the reason the welcome screen no
  // longer offers the field to someone who already has one.
  console.log('\n\x1b[1m1b. A handle is claimed once, and never recycled\x1b[0m')
  const rename = await rpc(alice.token, 'set_profile', { p_handle: `alice2${stamp}`, p_display_name: 'Alice' })
  check('MY OWN HANDLE CANNOT BE CHANGED', JSON.stringify(rename.body).includes('handle_locked'), JSON.stringify(rename.body))
  const rename3 = await rpc(alice.token, 'set_profile', { p_handle: `bob${stamp}`, p_display_name: 'Alice' })
  check("...not even to someone else's, which is refused as locked, not taken", JSON.stringify(rename3.body).includes('handle_locked'), JSON.stringify(rename3.body))
  const stillMine = await rest(alice.token, `/profiles?user_id=eq.${alice.id}&select=handle`)
  check('...and the refusal left it exactly as it was', stillMine.body?.[0]?.handle === `alice${stamp}`, JSON.stringify(stillMine.body))
  const freed = await rpc(bob.token, 'handle_available', { p_handle: `alice2${stamp}` })
  check('...so the name it would have freed was never freed', freed.body === 'ok', JSON.stringify(freed.body))

  const rename2 = await rest(alice.token, `/profiles?user_id=eq.${alice.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ handle: `alice3${stamp}` }),
  })
  check('A DIRECT PATCH CANNOT CHANGE IT EITHER', rename2.status >= 400, `${rename2.status} ${JSON.stringify(rename2.body)}`)

  const renamed = await rpc(alice.token, 'set_profile', { p_handle: `alice${stamp}`, p_display_name: 'Alice Renamed' })
  check('re-sending my own handle edits the display name', renamed.status === 200, `${renamed.status} ${JSON.stringify(renamed.body)}`)
  const named = await rpc(alice.token, 'set_display_name', { p_display_name: 'Alice' })
  check('set_display_name changes the name with no handle at all', named.status === 200 && (Array.isArray(named.body) ? named.body[0] : named.body)?.display_name === 'Alice', JSON.stringify(named.body))
  const noProfile = await rpc(dave.token, 'set_display_name', { p_display_name: '' })
  check('set_display_name refuses an empty name', JSON.stringify(noProfile.body).includes('bad_display_name'), JSON.stringify(noProfile.body))

  const avail = await rpc(bob.token, 'handle_available', { p_handle: `free${stamp}` })
  check("handle_available says 'ok' for a free one", avail.body === 'ok', JSON.stringify(avail.body))
  const availTaken = await rpc(bob.token, 'handle_available', { p_handle: `alice${stamp}` })
  check("handle_available says 'taken' before anyone commits to it", availTaken.body === 'taken', JSON.stringify(availTaken.body))
  const availMine = await rpc(bob.token, 'handle_available', { p_handle: `bob${stamp}` })
  check("handle_available says 'mine' for my own", availMine.body === 'mine', JSON.stringify(availMine.body))
  const availReserved = await rpc(bob.token, 'handle_available', { p_handle: 'support' })
  check("handle_available says 'reserved'", availReserved.body === 'reserved', JSON.stringify(availReserved.body))
  const availBad = await rpc(bob.token, 'handle_available', { p_handle: 'No Spaces!' })
  check("handle_available says 'bad'", availBad.body === 'bad', JSON.stringify(availBad.body))
  const availAnon = await rpc(PUBLISHABLE, 'handle_available', { p_handle: `free${stamp}` })
  check('anonymous cannot probe the handle space', availAnon.status >= 400, `${availAnon.status}`)
  // The ledger is the uniqueness authority and holds handles whose owners are
  // gone. Readable, it would be a dump of who used to be here.
  const ledger = await rest(carol.token, '/handle_claims?select=handle,user_id')
  check('the claim ledger refuses a direct read', ledger.status >= 400 || (ledger.body ?? []).length === 0, `${ledger.status} ${JSON.stringify(ledger.body)}`)

  // Erasing your social presence deletes the profile row. The ledger keeps the
  // claim, so the name does not go back on the shelf — and comes back to you.
  const erin = await makeUser(`erin+${stamp}@probe.test`)
  await rpc(erin.token, 'set_profile', { p_handle: `erin${stamp}`, p_display_name: 'Erin' })
  await rpc(erin.token, 'erase_social', {})
  const erinGone = await rest(carol.token, `/profiles?handle=eq.erin${stamp}&select=handle`)
  check('erasing removes the profile row', (erinGone.body ?? []).length === 0, JSON.stringify(erinGone.body))
  const grab = await rpc(frank.token, 'set_profile', { p_handle: `erin${stamp}`, p_display_name: 'Impostor' })
  check('AN ERASED HANDLE IS STILL NOT UP FOR GRABS', JSON.stringify(grab.body).includes('handle_taken'), JSON.stringify(grab.body))
  const reclaim = await rpc(erin.token, 'set_profile', { p_handle: `erin${stamp}`, p_display_name: 'Erin' })
  check('...but its owner gets it back', reclaim.status === 200, `${reclaim.status} ${JSON.stringify(reclaim.body)}`)

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

  // An invite link creates an ACCEPTED edge with no request and no answer,
  // which is the one thing 0002 spends its whole comment block forbidding. It
  // is allowed here because the referral row is proof that both sides acted —
  // one wrote the invite, one followed it — and because the function takes no
  // argument, so there is nothing a caller can point at a stranger. The two
  // checks that matter are the last two: a refusal must survive an invite, and
  // the count must not become a window onto the graph.
  console.log('\n\x1b[1m6b. An invite introduces two people (0017)\x1b[0m')
  const ivy = await makeUser(`ivy+${stamp}@probe.test`)
  const jack = await makeUser(`jack+${stamp}@probe.test`)
  const kim = await makeUser(`kim+${stamp}@probe.test`)
  const liam = await makeUser(`liam+${stamp}@probe.test`)
  await rpc(ivy.token, 'set_profile', { p_handle: `ivy${stamp}`, p_display_name: 'Ivy' })
  await rpc(jack.token, 'set_profile', { p_handle: `jack${stamp}`, p_display_name: 'Jack' })
  await rpc(kim.token, 'set_profile', { p_handle: `kim${stamp}`, p_display_name: 'Kim' })

  const claimed = await rpc(jack.token, 'claim_referral', { p_handle: `ivy${stamp}` })
  check('an invited collector claims the referral', claimed.body === true, JSON.stringify(claimed.body))
  const introduced = await rpc(jack.token, 'befriend_referrer', {})
  check(
    'befriend_referrer returns the inviter\'s handle',
    introduced.body === `ivy${stamp}`,
    `${introduced.status} ${JSON.stringify(introduced.body)}`,
  )
  const edge = await rest(ivy.token, `/friendships?requester=eq.${ivy.id}&addressee=eq.${jack.id}&select=status`)
  check('THEY ARE ACCEPTED FRIENDS, with nothing left to answer', edge.body?.[0]?.status === 'accepted', JSON.stringify(edge.body))
  const seenByJack = await rest(jack.token, `/friendships?select=status,requester`)
  check('...and the invited side sees the same edge', (seenByJack.body ?? []).some((f) => f.requester === ivy.id && f.status === 'accepted'), JSON.stringify(seenByJack.body))

  const again = await rpc(jack.token, 'befriend_referrer', {})
  check('a second call says nothing rather than announcing it twice', again.body === null, JSON.stringify(again.body))
  const oneEdge = await rest(ivy.token, `/friendships?addressee=eq.${jack.id}&select=status`)
  check('...and left exactly one row', (oneEdge.body ?? []).length === 1, JSON.stringify(oneEdge.body))

  const noReferral = await rpc(dave.token, 'befriend_referrer', {})
  check('someone who arrived on their own gets no friend', noReferral.body === null, JSON.stringify(noReferral.body))

  // The invited person must have a profile first: a friend nobody can name,
  // look up or answer is not an introduction.
  const beforeSetup = await rpc(liam.token, 'claim_referral', { p_handle: `ivy${stamp}` })
  check('a referral can be claimed before a handle exists', beforeSetup.body === true, JSON.stringify(beforeSetup.body))
  const tooEarly = await rpc(liam.token, 'befriend_referrer', {})
  check('...but no friendship is made until they set up their profile', tooEarly.body === null, JSON.stringify(tooEarly.body))
  const noEdgeYet = await rest(ivy.token, `/friendships?addressee=eq.${liam.id}&select=status`)
  check('...and nothing was written meanwhile', (noEdgeYet.body ?? []).length === 0, JSON.stringify(noEdgeYet.body))

  // The safety property. Someone who declined a person must not find them back
  // in their friends list because that person sent them an invite link.
  await rpc(ivy.token, 'request_friend', { p_handle: `kim${stamp}` })
  await rest(kim.token, `/friendships?requester=eq.${ivy.id}&addressee=eq.${kim.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'blocked' }),
  })
  const kimClaim = await rpc(kim.token, 'claim_referral', { p_handle: `ivy${stamp}` })
  check('a blocked collector can still claim the referral (it is only a price)', kimClaim.body === true, JSON.stringify(kimClaim.body))
  const laundered = await rpc(kim.token, 'befriend_referrer', {})
  check('AN INVITE CANNOT LAUNDER A BLOCK', laundered.body === null, JSON.stringify(laundered.body))
  const stillBlocked = await rest(kim.token, `/friendships?requester=eq.${ivy.id}&addressee=eq.${kim.id}&select=status`)
  check('...and the refusal is exactly as it was', stillBlocked.body?.[0]?.status === 'blocked', JSON.stringify(stillBlocked.body))

  const joins = await rpc(ivy.token, 'referral_joins', {})
  check('the inviter is told how many joined', joins.body === 3, JSON.stringify(joins.body))
  const theirJoins = await rpc(jack.token, 'referral_joins', {})
  check('...and it counts only my own, never the graph', theirJoins.body === 0, JSON.stringify(theirJoins.body))
  const whoJoined = await rest(ivy.token, `/referrals?select=user_id,referred_by`)
  check('THE GRAPH ITSELF STAYS PRIVATE — a count is not a list', (whoJoined.body ?? []).length === 0, JSON.stringify(whoJoined.body))

  const anonBefriend = await rpc(PUBLISHABLE, 'befriend_referrer', {})
  check('anonymous cannot call befriend_referrer', anonBefriend.status >= 400, `${anonBefriend.status}`)
  const anonJoins = await rpc(PUBLISHABLE, 'referral_joins', {})
  check('anonymous cannot call referral_joins', anonJoins.status >= 400, `${anonJoins.status}`)

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
