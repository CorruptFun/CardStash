/**
 * Messaging, proven against a real Supabase project.
 *
 * The sibling of `social-rls.mjs`, and it exists for the same reason: `psql`
 * as `postgres` bypasses row-level security, so it can only show that tables
 * and functions exist. This drives the real REST surface with genuine user
 * JWTs — five signed-in users and one anonymous caller.
 *
 * What it is really guarding is the header of `supabase/migrations/0019`:
 *
 *   * reachability — friends, or a `scope='trade'` publisher, or somebody who
 *     already spoke to you, and NOBODY ELSE;
 *   * a third party can neither read a conversation nor write into one;
 *   * `sender` is stamped server-side, and no client can forge a thread's
 *     preview, its read watermarks or the other side's block flag;
 *   * a block is one-sided and silent — the thread leaves the blocker's list,
 *     the sender is never told and their own history is untouched;
 *   * `erase_social()` takes conversations with it and STILL leaves the vault.
 *
 * Needs a secret key to create and delete its own throwaway users:
 *
 *   SUPABASE_SECRET=sb_secret_... node tests/harness/messages-rls.mjs
 *
 * Users are deleted on the way out, including after a failure, and deleting
 * them cascades every row this wrote.
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
const stamp = Date.now()

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
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
    }).catch(() => {})
  }
  // `handle_claims` deliberately does not cascade (0010) — right for a person,
  // wrong for a probe. Sweep this run's names or every run burns five.
  await fetch(`${URL_BASE}/rest/v1/handle_claims?handle=like.*${stamp}`, {
    method: 'DELETE',
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
  }).catch(() => {})
}

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

const ABOUT = {
  cardId: 'mtg:abc',
  game: 'mtg',
  name: 'Black Lotus',
  finish: 'nonfoil',
  condition: 'NM',
  qty: 1,
  forTrade: 1,
  price: 12.5,
}

const threadFor = (list, otherId) => (Array.isArray(list) ? list.find((row) => row.other_id === otherId) : undefined)

try {
  console.log(`\nMessaging RLS — ${URL_BASE}`)

  // seller  — publishes a trade binder, so strangers may open a conversation
  // buyer   — a stranger who wants to ask about a card
  // friend  — accepted friend of `quiet`, so friendship alone is enough
  // quiet   — publishes nothing, befriends nobody: unreachable, on purpose
  // snoop   — a third party who must see none of it
  const seller = await makeUser(`seller+${stamp}@probe.test`)
  const buyer = await makeUser(`buyer+${stamp}@probe.test`)
  const friend = await makeUser(`friend+${stamp}@probe.test`)
  const quiet = await makeUser(`quiet+${stamp}@probe.test`)
  const snoop = await makeUser(`snoop+${stamp}@probe.test`)

  await rpc(seller.token, 'set_profile', { p_handle: `seller${stamp}`, p_display_name: 'Seller' })
  await rpc(buyer.token, 'set_profile', { p_handle: `buyer${stamp}`, p_display_name: 'Buyer' })
  await rpc(friend.token, 'set_profile', { p_handle: `friend${stamp}`, p_display_name: 'Friend' })
  await rpc(quiet.token, 'set_profile', { p_handle: `quiet${stamp}`, p_display_name: 'Quiet' })
  await rpc(snoop.token, 'set_profile', { p_handle: `snoop${stamp}`, p_display_name: 'Snoop' })

  await rpc(seller.token, 'publish_binder', {
    p_scope: 'trade',
    p_payload: binderPayload('Seller', 'trade'),
    p_card_count: 1,
    p_want_count: 0,
    p_offers: [{ want_key: 'mtg|black lotus', game: 'mtg', name: 'Black Lotus', qty: 1 }],
  })

  console.log('\n\x1b[1m1. Who may open a conversation\x1b[0m')
  const reachable = await rpc(buyer.token, 'can_message', { p_to: seller.id })
  check('a trade-binder publisher is reachable by anyone signed in', reachable.body === true, JSON.stringify(reachable.body))
  const unreachable = await rpc(buyer.token, 'can_message', { p_to: quiet.id })
  check('someone who publishes nothing and has no friends is NOT', unreachable.body === false, JSON.stringify(unreachable.body))
  const selfCheck = await rpc(buyer.token, 'can_message', { p_to: buyer.id })
  check('nobody is reachable by themselves', selfCheck.body === false, JSON.stringify(selfCheck.body))
  const anonCheck = await rpc(PUBLISHABLE, 'can_message', { p_to: seller.id })
  check('anonymous cannot even ask', anonCheck.status >= 400, `${anonCheck.status}`)

  const refused = await rpc(buyer.token, 'send_message', { p_to: quiet.id, p_body: 'hello?' })
  check('sending to an unreachable user is refused', JSON.stringify(refused.body).includes('not_reachable'), JSON.stringify(refused.body))
  const selfSend = await rpc(buyer.token, 'send_message', { p_to: buyer.id, p_body: 'hi me' })
  check('cannot message yourself', JSON.stringify(selfSend.body).includes('bad_recipient'), JSON.stringify(selfSend.body))
  const empty = await rpc(buyer.token, 'send_message', { p_to: seller.id, p_body: '   ' })
  check('an empty message is refused', JSON.stringify(empty.body).includes('empty_message'), JSON.stringify(empty.body))
  const tooLong = await rpc(buyer.token, 'send_message', { p_to: seller.id, p_body: 'x'.repeat(2001) })
  check('a 2001-character message is refused', JSON.stringify(tooLong.body).includes('message_too_long'), JSON.stringify(tooLong.body))

  // Friendship alone reaches someone who publishes nothing at all.
  await rpc(friend.token, 'request_friend', { p_handle: `quiet${stamp}` })
  await rest(quiet.token, `/friendships?requester=eq.${friend.id}&addressee=eq.${quiet.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'accepted' }),
  })
  const friendSend = await rpc(friend.token, 'send_message', { p_to: quiet.id, p_body: 'want to swap?' })
  check('an ACCEPTED FRIEND reaches someone who publishes nothing', friendSend.status === 200, `${friendSend.status} ${JSON.stringify(friendSend.body)}`)

  console.log('\n\x1b[1m2. A conversation is between exactly two people\x1b[0m')
  const opened = await rpc(buyer.token, 'send_message', {
    p_to: seller.id,
    p_body: 'Is the Lotus still available?',
    p_about: ABOUT,
  })
  const threadId = opened.body
  check('a stranger opens a thread with a trade publisher', opened.status === 200 && Number(threadId) > 0, `${opened.status} ${JSON.stringify(opened.body)}`)

  const sellerThreads = await rpc(seller.token, 'list_threads', {})
  const sellerSide = threadFor(sellerThreads.body, buyer.id)
  check('the recipient sees the thread', !!sellerSide, JSON.stringify(sellerThreads.body))
  check('...with the message unread', sellerSide?.unread === 1, JSON.stringify(sellerSide))
  check('...and the counterparty resolved to a handle', sellerSide?.handle === `buyer${stamp}`, JSON.stringify(sellerSide))

  const buyerThreads = await rpc(buyer.token, 'list_threads', {})
  const buyerSide = threadFor(buyerThreads.body, seller.id)
  check('the SENDER sees it too (unlike the trade inbox)', !!buyerSide, JSON.stringify(buyerThreads.body))
  check('...and their own message is not unread to them', buyerSide?.unread === 0, JSON.stringify(buyerSide))

  const body = await rest(seller.token, `/messages?thread_id=eq.${threadId}&select=id,sender,body,about`)
  check('the recipient reads the message body', body.body?.length === 1, JSON.stringify(body.body))
  check('sender is stamped server-side', body.body?.[0]?.sender === buyer.id, JSON.stringify(body.body?.[0]))
  check('the attached card rides along', body.body?.[0]?.about?.cardId === 'mtg:abc', JSON.stringify(body.body?.[0]?.about))

  const snooped = await rest(snoop.token, `/messages?thread_id=eq.${threadId}&select=id,body`)
  check('A THIRD PARTY READS NOTHING', (snooped.body ?? []).length === 0, JSON.stringify(snooped.body))
  const snoopedThreads = await rest(snoop.token, '/message_threads?select=id,user_lo,user_hi')
  check('...and sees no thread rows either', (snoopedThreads.body ?? []).length === 0, JSON.stringify(snoopedThreads.body))
  const anonMessages = await rest(PUBLISHABLE, '/messages?select=id,body')
  check('anonymous reads nothing', anonMessages.status !== 200 || (anonMessages.body ?? []).length === 0, `${anonMessages.status}`)

  console.log('\n\x1b[1m3. Nothing is writable except through the RPCs\x1b[0m')
  const forgeMessage = await rest(snoop.token, '/messages', {
    method: 'POST',
    body: JSON.stringify({ thread_id: threadId, sender: seller.id, body: 'I accept your offer' }),
  })
  check('direct INSERT into messages is refused (no policy, no grant)', forgeMessage.status >= 400, `${forgeMessage.status}`)
  const forgeMine = await rest(buyer.token, '/messages', {
    method: 'POST',
    body: JSON.stringify({ thread_id: threadId, sender: buyer.id, body: 'as myself, even' }),
  })
  check('...even as a genuine participant writing as themselves', forgeMine.status >= 400, `${forgeMine.status}`)
  const forgeThread = await rest(snoop.token, '/message_threads', {
    method: 'POST',
    body: JSON.stringify({ user_lo: buyer.id, user_hi: seller.id }),
  })
  check('direct INSERT into message_threads is refused', forgeThread.status >= 400, `${forgeThread.status}`)
  const forgePreview = await rest(buyer.token, `/message_threads?id=eq.${threadId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ last_preview: 'forged', hi_read_id: 9999, lo_blocked: true }),
  })
  check('a participant cannot PATCH the thread row', forgePreview.status >= 400 || (forgePreview.body ?? []).length === 0, `${forgePreview.status} ${JSON.stringify(forgePreview.body)}`)
  const notMine = await rpc(snoop.token, 'mark_thread_read', { p_thread: threadId })
  check('marking someone else’s thread read is refused', JSON.stringify(notMine.body).includes('not_in_thread'), JSON.stringify(notMine.body))
  const notMineBlock = await rpc(snoop.token, 'set_thread_block', { p_thread: threadId, p_blocked: true })
  check('blocking inside someone else’s thread is refused', JSON.stringify(notMineBlock.body).includes('not_in_thread'), JSON.stringify(notMineBlock.body))

  console.log('\n\x1b[1m4. Reading, replying, and the unanswered cap\x1b[0m')
  const read = await rpc(seller.token, 'mark_thread_read', { p_thread: threadId })
  check('mark_thread_read succeeds for a participant', read.status < 300, `${read.status} ${JSON.stringify(read.body)}`)
  const afterRead = threadFor((await rpc(seller.token, 'list_threads', {})).body, buyer.id)
  check('...and the unread count drops to zero', afterRead?.unread === 0, JSON.stringify(afterRead))

  const reply = await rpc(seller.token, 'send_message', { p_to: buyer.id, p_body: 'Yes — $12 shipped.' })
  check('the recipient can reply', reply.status === 200, `${reply.status} ${JSON.stringify(reply.body)}`)
  check('...into the SAME thread, not a second one', Number(reply.body) === Number(threadId), `${reply.body} vs ${threadId}`)

  // Unpublishing must not strand the person who was answering you.
  await rpc(seller.token, 'unpublish_binder', {})
  const stillReachable = await rpc(buyer.token, 'send_message', { p_to: seller.id, p_body: 'Deal.' })
  check('SOMEONE WHO SPOKE TO ME FIRST STAYS REACHABLE after they unpublish', stillReachable.status === 200, `${stillReachable.status} ${JSON.stringify(stillReachable.body)}`)
  const strangerNow = await rpc(snoop.token, 'send_message', { p_to: seller.id, p_body: 'hello' })
  check('...while a stranger no longer is', JSON.stringify(strangerNow.body).includes('not_reachable'), JSON.stringify(strangerNow.body))

  // A monologue is capped per pair: 15 since the other side last spoke.
  let capped = null
  for (let i = 0; i < 16; i++) {
    capped = await rpc(buyer.token, 'send_message', { p_to: seller.id, p_body: `ping ${i}` })
  }
  check('the unanswered cap holds at 15', JSON.stringify(capped?.body).includes('thread_full'), JSON.stringify(capped?.body))
  await rpc(seller.token, 'send_message', { p_to: buyer.id, p_body: 'still here' })
  const afterAnswer = await rpc(buyer.token, 'send_message', { p_to: seller.id, p_body: 'thanks' })
  check('...and a single reply from them clears it', afterAnswer.status === 200, `${afterAnswer.status} ${JSON.stringify(afterAnswer.body)}`)

  console.log('\n\x1b[1m5. Blocking is one-sided and silent\x1b[0m')
  const blocked = await rpc(seller.token, 'set_thread_block', { p_thread: threadId, p_blocked: true })
  check('a participant can block their side', blocked.status < 300, `${blocked.status} ${JSON.stringify(blocked.body)}`)
  const blockerList = await rpc(seller.token, 'list_threads', {})
  check('the thread leaves the BLOCKER’s list', !threadFor(blockerList.body, buyer.id), JSON.stringify(blockerList.body))
  const senderList = await rpc(buyer.token, 'list_threads', {})
  check('the SENDER’s own list is untouched', !!threadFor(senderList.body, seller.id), JSON.stringify(senderList.body))
  const stillSends = await rpc(buyer.token, 'send_message', { p_to: seller.id, p_body: 'you there?' })
  check('...and they are NOT told — the send still succeeds', stillSends.status === 200, `${stillSends.status} ${JSON.stringify(stillSends.body)}`)
  const stillGone = await rpc(seller.token, 'list_threads', {})
  check('...while the blocker still does not see it', !threadFor(stillGone.body, buyer.id), JSON.stringify(stillGone.body))
  const unblocked = await rpc(seller.token, 'send_message', { p_to: buyer.id, p_body: 'sorry, back' })
  check('talking to them again lifts my own block', unblocked.status === 200, `${unblocked.status}`)
  check('...and the thread returns to my list', !!threadFor((await rpc(seller.token, 'list_threads', {})).body, buyer.id), '')

  console.log('\n\x1b[1m6. Erasure takes conversations, and still leaves the vault\x1b[0m')
  await rest(buyer.token, '/rpc/put_vault', {
    method: 'POST',
    body: JSON.stringify({
      p_envelope: { v: 1, salt: 'x', iv: 'y', ct: 'z' },
      p_key_check: 'kc',
      p_device: 'probe',
      p_base: 0,
    }),
  })
  const vaultBefore = await rest(buyer.token, '/vaults?select=revision')
  check('the user has a vault row', vaultBefore.body?.length === 1, JSON.stringify(vaultBefore.body))
  const erase = await rpc(buyer.token, 'erase_social', {})
  check('erase_social succeeds', erase.status < 300, `${erase.status} ${JSON.stringify(erase.body)}`)
  const gone = await rest(seller.token, `/messages?thread_id=eq.${threadId}&select=id`)
  check('THE CONVERSATION IS GONE FOR BOTH SIDES', (gone.body ?? []).length === 0, JSON.stringify(gone.body))
  const goneThread = threadFor((await rpc(seller.token, 'list_threads', {})).body, buyer.id)
  check('...and the thread with it', !goneThread, JSON.stringify(goneThread))
  const vaultAfter = await rest(buyer.token, '/vaults?select=revision')
  check('THE VAULT SURVIVES', vaultAfter.body?.length === 1, JSON.stringify(vaultAfter.body))

  console.log('\n\x1b[1m7. Controls — a refusal must mean refusal, not absence\x1b[0m')
  const ghost = await rpc(seller.token, 'definitely_not_a_function', {})
  check('a nonexistent RPC 404s', ghost.status === 404, `${ghost.status}`)
  const refusedAnon = await rpc(PUBLISHABLE, 'send_message', { p_to: seller.id, p_body: 'hi' })
  check('send_message refuses anon without 404ing', refusedAnon.status !== 404 && refusedAnon.status >= 400, `${refusedAnon.status}`)
  const refusedList = await rpc(PUBLISHABLE, 'list_threads', {})
  check('list_threads refuses anon without 404ing', refusedList.status !== 404 && refusedList.status >= 400, `${refusedList.status}`)
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
