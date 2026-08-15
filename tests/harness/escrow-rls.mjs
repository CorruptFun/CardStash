/**
 * The marketplace's money rules, proven against a real Supabase project.
 *
 * `psql` as `postgres` bypasses row-level security, so it can only ever show
 * that tables and policies exist — never that they work. This drives the same
 * doors the app will: four signed-in users and one anonymous caller against the
 * live REST surface, with genuine JWTs.
 *
 * What it is really guarding is the sentence migration 0006 is built around:
 * **nobody may write an order's state or its amounts through PostgREST.** A
 * buyer who could UPDATE `orders` would mark their own purchase 'delivered' and
 * collect a stranger's money; a seller who could write `seller_accounts` would
 * point someone else's payouts at their own Stripe account. Both look like
 * ordinary missing policies in review, and neither is visible to a schema read.
 *
 * It also holds the state machine to its own table, since migration 0006 is the
 * only place that graph is written down — logic.ts deliberately does not keep a
 * second copy, so this is what proves the edges.
 *
 * Needs a secret key to create and delete its own throwaway users:
 *
 *   SUPABASE_SECRET=sb_secret_... node tests/harness/escrow-rls.mjs
 *
 * Point it at a local stack with SUPABASE_URL/SUPABASE_KEY. Unlike the social
 * harness, deleting the users is NOT enough to clean up: `orders.buyer` and
 * `orders.seller` are `on delete set null`, not `cascade`, precisely so a
 * financial record survives a closed account. So this deletes its own orders
 * explicitly, and would leave litter behind if it did not.
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
const orders = []

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

/** The same call as the edge function makes: service role, RLS bypassed. */
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

const adminRpc = (fn, args) => admin(`/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args ?? {}) })

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

/**
 * Setup that fails must fail LOUDLY. A silently-broken fixture turns every
 * downstream assertion into a confusing red, and the temptation is then to
 * "fix" the thing being tested.
 */
function must(res, what) {
  if (res.status >= 400) throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res
}

/**
 * Make two users accepted friends — as the USERS, not as the service role.
 *
 * `friendships` grants DML to `authenticated` only (migration 0002); the
 * service role was never given any, so an admin insert here returns 42501 and,
 * with `Prefer: resolution=merge-duplicates`, does it quietly. Driving the real
 * two-step instead is both the thing that works and a better fixture: it is
 * exactly what the app does, so the friendship these tests rely on is a real
 * one rather than a row conjured past the policies that govern it.
 */
async function befriend(a, b) {
  must(
    await rest(a.token, '/friendships', {
      method: 'POST',
      body: JSON.stringify({ requester: a.id, addressee: b.id, status: 'pending' }),
    }),
    `${a.id} requesting ${b.id}`,
  )
  const accepted = must(
    await rest(b.token, `/friendships?requester=eq.${a.id}&addressee=eq.${b.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'accepted' }),
    }),
    `${b.id} accepting ${a.id}`,
  )
  if (!Array.isArray(accepted.body) || accepted.body.length !== 1) {
    throw new Error(`friendship not accepted: ${JSON.stringify(accepted.body)}`)
  }
}

/**
 * Give a user a verified-looking connected account. This one IS a service-role
 * write, and has to be: `seller_accounts` grants no DML to `authenticated` at
 * all, which is the property section 2 exists to prove.
 */
async function makeSeller(user, payoutsEnabled = true) {
  must(
    await admin('/seller_accounts?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        user_id: user.id,
        stripe_account_id: `acct_probe_${user.id.slice(0, 8)}`,
        payouts_enabled: payoutsEnabled,
        charges_enabled: payoutsEnabled,
      }),
    }),
    `seller_accounts for ${user.id}`,
  )
}

async function openOrder(buyer, seller, over = {}) {
  const res = await adminRpc('open_order', {
    p_buyer: buyer.id,
    p_seller: seller.id,
    p_card_id: 'mtg:lotus-1',
    p_card_name: 'Black Lotus',
    p_qty: 1,
    p_item_cents: 2000,
    p_shipping_cents: 500,
    p_fee_cents: 200,
    ...over,
  })
  const row = Array.isArray(res.body) ? res.body[0] : res.body
  if (row?.id) orders.push(row.id)
  return { status: res.status, row, body: res.body }
}

async function cleanup() {
  // Orders first: they do NOT cascade from auth.users (on delete set null), so
  // deleting the users would orphan them rather than remove them.
  for (const id of orders) {
    await admin(`/orders?id=eq.${id}`, { method: 'DELETE' }).catch(() => {})
  }
  for (const id of created) {
    await admin(`/seller_accounts?user_id=eq.${id}`, { method: 'DELETE' }).catch(() => {})
    // This cascades profiles/binders/offers/inbox/friendships, as in social-rls.
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
    }).catch(() => {})
  }
}

const stamp = Date.now()
const section = (n, title) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`)

try {
  const buyer = await makeUser(`buyer+${stamp}@probe.test`)
  const seller = await makeUser(`seller+${stamp}@probe.test`)
  const stranger = await makeUser(`stranger+${stamp}@probe.test`)
  const unverified = await makeUser(`unverified+${stamp}@probe.test`)

  await befriend(buyer, seller)
  await befriend(buyer, unverified)
  await makeSeller(seller, true)
  await makeSeller(unverified, false)

  // ---------------------------------------------------------------------- 1
  section(1, 'Who may be paid')

  const sells = await rpc(buyer.token, 'can_sell', { p_user: seller.id })
  check('a friend with payouts enabled can sell', sells.body === true, JSON.stringify(sells.body))

  const notReady = await rpc(buyer.token, 'can_sell', { p_user: unverified.id })
  check(
    'a friend who has NOT finished Stripe verification cannot',
    notReady.body === false,
    JSON.stringify(notReady.body),
  )

  const notFriend = await rpc(stranger.token, 'can_sell', { p_user: seller.id })
  check('a stranger cannot buy from them at all', notFriend.body === false, JSON.stringify(notFriend.body))

  const self = await rpc(seller.token, 'can_sell', { p_user: seller.id })
  check('you cannot sell to yourself', self.body === false, JSON.stringify(self.body))

  const anonSell = await rpc(PUBLISHABLE, 'can_sell', { p_user: seller.id })
  check('anonymous gets no answer', anonSell.status >= 400 || anonSell.body === false, `${anonSell.status}`)

  // ---------------------------------------------------------------------- 2
  section(2, 'The payout destination is not writable')

  const ownRead = await rest(seller.token, `/seller_accounts?user_id=eq.${seller.id}&select=stripe_account_id`)
  check('a seller reads their own account row', ownRead.status === 200 && ownRead.body?.length === 1, `${ownRead.status}`)

  const peek = await rest(buyer.token, `/seller_accounts?user_id=eq.${seller.id}&select=stripe_account_id`)
  check(
    "nobody reads someone else's Stripe account id",
    peek.status === 200 && (peek.body?.length ?? 0) === 0,
    JSON.stringify(peek.body),
  )

  const hijack = await rest(stranger.token, `/seller_accounts?user_id=eq.${seller.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ stripe_account_id: 'acct_attacker' }),
  })
  check(
    'THE PAYOUT DESTINATION CANNOT BE REPOINTED',
    hijack.status >= 400 || (Array.isArray(hijack.body) && hijack.body.length === 0),
    `${hijack.status} ${JSON.stringify(hijack.body)}`,
  )

  const selfGrant = await rest(stranger.token, '/seller_accounts', {
    method: 'POST',
    body: JSON.stringify({ user_id: stranger.id, stripe_account_id: 'acct_self', payouts_enabled: true }),
  })
  check('a user cannot declare themselves a verified seller', selfGrant.status >= 400, `${selfGrant.status}`)

  // ---------------------------------------------------------------------- 3
  section(3, 'Opening an order')

  const good = await openOrder(buyer, seller)
  check('a friend can be sold to', good.row?.status === 'pending', JSON.stringify(good.body).slice(0, 160))

  const strangerOrder = await openOrder(stranger, seller)
  check(
    'an order between non-friends is refused',
    strangerOrder.status >= 400 && /not_friends/.test(JSON.stringify(strangerOrder.body)),
    JSON.stringify(strangerOrder.body).slice(0, 120),
  )

  const unreadyOrder = await openOrder(buyer, unverified)
  check(
    'an order against an unverified seller is refused',
    unreadyOrder.status >= 400 && /seller_not_ready/.test(JSON.stringify(unreadyOrder.body)),
    JSON.stringify(unreadyOrder.body).slice(0, 120),
  )

  const tiny = await openOrder(buyer, seller, { p_item_cents: 100, p_shipping_cents: 0, p_fee_cents: 50 })
  check(
    'a sale below the minimum is refused, because it would lose money',
    tiny.status >= 400 && /below_minimum/.test(JSON.stringify(tiny.body)),
    JSON.stringify(tiny.body).slice(0, 120),
  )

  const greedy = await openOrder(buyer, seller, { p_item_cents: 1000, p_shipping_cents: 0, p_fee_cents: 1000 })
  check(
    'a fee that would leave the seller nothing is refused',
    greedy.status >= 400 && /bad_fee/.test(JSON.stringify(greedy.body)),
    JSON.stringify(greedy.body).slice(0, 120),
  )

  const negative = await openOrder(buyer, seller, { p_item_cents: -5000 })
  check(
    'a negative amount is refused',
    negative.status >= 400,
    JSON.stringify(negative.body).slice(0, 120),
  )

  const userOpen = await rpc(buyer.token, 'open_order', {
    p_buyer: buyer.id,
    p_seller: seller.id,
    p_card_id: 'mtg:x',
    p_card_name: 'X',
    p_qty: 1,
    p_item_cents: 2000,
    p_shipping_cents: 0,
    p_fee_cents: 100,
  })
  check('a USER cannot open an order directly — amounts are not theirs to name', userOpen.status >= 400, `${userOpen.status}`)

  const order = good.row

  // ---------------------------------------------------------------------- 4
  section(4, 'An order is readable by its two parties and nobody else')

  const buyerSees = await rest(buyer.token, `/orders?id=eq.${order.id}&select=id,status`)
  check('the buyer reads it', buyerSees.body?.length === 1, JSON.stringify(buyerSees.body))

  const sellerSees = await rest(seller.token, `/orders?id=eq.${order.id}&select=id,status`)
  check('the seller reads it', sellerSees.body?.length === 1, JSON.stringify(sellerSees.body))

  const strangerSees = await rest(stranger.token, `/orders?id=eq.${order.id}&select=id,status`)
  check('a stranger does not', (strangerSees.body?.length ?? 0) === 0, JSON.stringify(strangerSees.body))

  const anonSees = await rest(PUBLISHABLE, `/orders?id=eq.${order.id}&select=id,status`)
  check(
    'anonymous does not',
    anonSees.status >= 400 || (anonSees.body?.length ?? 0) === 0,
    `${anonSees.status} ${JSON.stringify(anonSees.body)}`,
  )

  // ---------------------------------------------------------------------- 5
  section(5, 'NOBODY WRITES AN ORDER THROUGH PostgREST')

  for (const [who, actor] of [
    ['buyer', buyer],
    ['seller', seller],
    ['stranger', stranger],
  ]) {
    const patch = await rest(actor.token, `/orders?id=eq.${order.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'released' }),
    })
    check(
      `the ${who} cannot set status directly`,
      patch.status >= 400 || (Array.isArray(patch.body) && patch.body.length === 0),
      `${patch.status} ${JSON.stringify(patch.body)}`,
    )
  }

  const rewrite = await rest(buyer.token, `/orders?id=eq.${order.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ fee_cents: 0, item_cents: 1 }),
  })
  check(
    'THE AMOUNTS CANNOT BE REWRITTEN',
    rewrite.status >= 400 || (Array.isArray(rewrite.body) && rewrite.body.length === 0),
    `${rewrite.status} ${JSON.stringify(rewrite.body)}`,
  )

  const forge = await rest(buyer.token, '/orders', {
    method: 'POST',
    body: JSON.stringify({
      buyer: buyer.id,
      seller: seller.id,
      card_id: 'mtg:x',
      card_name: 'X',
      item_cents: 1,
      fee_cents: 0,
      status: 'delivered',
    }),
  })
  check('an order cannot be forged into existence', forge.status >= 400, `${forge.status}`)

  const wipe = await rest(seller.token, `/orders?id=eq.${order.id}`, { method: 'DELETE' })
  check(
    'an order cannot be deleted by either party',
    wipe.status >= 400 || (await rest(buyer.token, `/orders?id=eq.${order.id}&select=id`)).body?.length === 1,
    `${wipe.status}`,
  )

  // ---------------------------------------------------------------------- 6
  section(6, 'The state machine, from both sides')

  const earlyShip = await rpc(seller.token, 'mark_shipped', { p_order: order.id })
  check(
    'a pending (unpaid) order cannot be shipped',
    earlyShip.status >= 400 && /bad_transition/.test(JSON.stringify(earlyShip.body)),
    JSON.stringify(earlyShip.body).slice(0, 120),
  )

  await adminRpc('advance_order', { p_order: order.id, p_to: 'paid', p_stripe: { charge_id: 'ch_probe' } })

  const buyerShips = await rpc(buyer.token, 'mark_shipped', { p_order: order.id })
  check(
    'the BUYER cannot mark it shipped',
    buyerShips.status >= 400 && /not_your_order/.test(JSON.stringify(buyerShips.body)),
    JSON.stringify(buyerShips.body).slice(0, 120),
  )

  const strangerShips = await rpc(stranger.token, 'mark_shipped', { p_order: order.id })
  check(
    'a stranger cannot either, and is told the same thing',
    strangerShips.status >= 400 && /not_your_order/.test(JSON.stringify(strangerShips.body)),
    JSON.stringify(strangerShips.body).slice(0, 120),
  )

  const sellerConfirms = await rpc(seller.token, 'confirm_receipt', { p_order: order.id })
  check(
    'the SELLER cannot confirm their own delivery',
    sellerConfirms.status >= 400 && /not_your_order/.test(JSON.stringify(sellerConfirms.body)),
    JSON.stringify(sellerConfirms.body).slice(0, 120),
  )

  const shipped = await rpc(seller.token, 'mark_shipped', { p_order: order.id, p_tracking: '9400111899' })
  const shippedRow = Array.isArray(shipped.body) ? shipped.body[0] : shipped.body
  check('the seller ships it', shippedRow?.status === 'shipped', JSON.stringify(shipped.body).slice(0, 120))

  const confirmed = await rpc(buyer.token, 'confirm_receipt', { p_order: order.id })
  const confirmedRow = Array.isArray(confirmed.body) ? confirmed.body[0] : confirmed.body
  check('the buyer confirms receipt', confirmedRow?.status === 'delivered', JSON.stringify(confirmed.body).slice(0, 120))

  const userReleases = await rpc(buyer.token, 'advance_order', { p_order: order.id, p_to: 'released' })
  check(
    'A USER CANNOT RELEASE THE MONEY',
    userReleases.status >= 400,
    `${userReleases.status} ${JSON.stringify(userReleases.body).slice(0, 100)}`,
  )

  const released = await adminRpc('advance_order', {
    p_order: order.id,
    p_to: 'released',
    p_stripe: { transfer_id: 'tr_probe' },
  })
  const releasedRow = Array.isArray(released.body) ? released.body[0] : released.body
  check('the service role releases it', releasedRow?.status === 'released', JSON.stringify(released.body).slice(0, 120))

  const twice = await adminRpc('advance_order', { p_order: order.id, p_to: 'released' })
  const twiceRow = Array.isArray(twice.body) ? twice.body[0] : twice.body
  check(
    'releasing twice is a no-op, not an error — webhooks redeliver',
    twice.status === 200 && twiceRow?.status === 'released',
    `${twice.status}`,
  )

  const backwards = await adminRpc('advance_order', { p_order: order.id, p_to: 'paid' })
  check(
    'a released order cannot go back to paid',
    backwards.status >= 400 && /bad_transition/.test(JSON.stringify(backwards.body)),
    JSON.stringify(backwards.body).slice(0, 120),
  )

  const lateDispute = await rpc(buyer.token, 'raise_dispute', { p_order: order.id })
  check(
    'a released order cannot be disputed — that is a chargeback now',
    lateDispute.status >= 400 && /bad_transition/.test(JSON.stringify(lateDispute.body)),
    JSON.stringify(lateDispute.body).slice(0, 120),
  )

  // ---------------------------------------------------------------------- 7
  section(7, 'Disputes freeze a live order')

  const second = await openOrder(buyer, seller)
  await adminRpc('advance_order', { p_order: second.row.id, p_to: 'paid' })
  await rpc(seller.token, 'mark_shipped', { p_order: second.row.id })

  const sellerDisputes = await rpc(seller.token, 'raise_dispute', { p_order: second.row.id })
  check(
    'the seller cannot raise a dispute against their own buyer',
    sellerDisputes.status >= 400,
    JSON.stringify(sellerDisputes.body).slice(0, 120),
  )

  const disputed = await rpc(buyer.token, 'raise_dispute', { p_order: second.row.id, p_reason: 'never arrived' })
  const disputedRow = Array.isArray(disputed.body) ? disputed.body[0] : disputed.body
  check('the buyer disputes it', disputedRow?.status === 'disputed', JSON.stringify(disputed.body).slice(0, 120))

  const disputedRead = await rest(buyer.token, `/orders?id=eq.${second.row.id}&select=status,tracking`)
  check(
    'the reason text is not stored anywhere on the order',
    !/never arrived/.test(JSON.stringify(disputedRead.body)),
    JSON.stringify(disputedRead.body),
  )

  const releaseDisputed = await adminRpc('advance_order', { p_order: second.row.id, p_to: 'released' })
  check(
    'A DISPUTED ORDER CANNOT BE RELEASED',
    releaseDisputed.status >= 400 && /bad_transition/.test(JSON.stringify(releaseDisputed.body)),
    JSON.stringify(releaseDisputed.body).slice(0, 120),
  )

  const refunded = await adminRpc('advance_order', { p_order: second.row.id, p_to: 'refunded' })
  const refundedRow = Array.isArray(refunded.body) ? refunded.body[0] : refunded.body
  check('...but it can be refunded', refundedRow?.status === 'refunded', JSON.stringify(refunded.body).slice(0, 120))

  // ---------------------------------------------------------------------- 8
  section(8, 'Controls — a refusal must mean refusal, not absence')

  const ghost = await adminRpc('definitely_not_a_function', {})
  check('a nonexistent RPC 404s', ghost.status === 404, `${ghost.status}`)

  const realRefusal = await rpc(PUBLISHABLE, 'confirm_receipt', { p_order: order.id })
  check(
    'a real RPC refuses anon without 404ing',
    realRefusal.status !== 404 && realRefusal.status >= 400,
    `${realRefusal.status}`,
  )

  const tableExists = await admin('/orders?select=id&limit=1')
  check('the orders table is really there (service role reads it)', tableExists.status === 200, `${tableExists.status}`)
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
