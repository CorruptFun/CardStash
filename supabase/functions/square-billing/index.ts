/**
 * square-billing — the webhook that turns a Square subscription into a row in
 * `entitlements`, and nothing else.
 *
 * THE INTERFACE IS THE TABLE. `scan-card` asks `consume_scan_credit()` whether
 * the caller may scan; that function reads `entitlements` and knows nothing
 * about Square, invoices, or money. So this file is allowed to be the only
 * place in the repo that understands a payment provider, and swapping provider
 * later means writing a sibling of this file and changing the `source` string
 * it writes. Nothing in `src/` changes, and no scanning code is touched by
 * billing at all — that separation is the whole design and is worth more than
 * any convenience that would breach it.
 *
 * Contract:
 *   POST (from Square)  → 200 always, once the signature verifies
 *   401 bad/absent signature      503 not configured
 *
 * WHY 200 ON EVENTS WE IGNORE: Square retries any non-2xx with backoff for
 * days and disables an endpoint that keeps failing. An event we do not care
 * about is handled correctly by ignoring it, so it gets a 200. Only a
 * signature failure is a 401, because that one is not Square talking.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * Days of slack past Square's `charged_through_date` before a subscriber stops
 * being one. A renewal webhook can land minutes late, a card can be retried for
 * a day, and the failure mode of being stingy here is a paying user whose
 * scanner quietly stops working — much worse than a few free days. Lapsing IS
 * the cancellation mechanism (migration 0005): nothing writes a "cancelled"
 * state, the row simply stops being in the future.
 */
const GRACE_DAYS = Number(Deno.env.get('SQUARE_GRACE_DAYS') ?? '3')

/** The feature this subscription buys. Matches PaidFeature in src/lib/entitlement.ts. */
const FEATURE = 'cloud-scan'

const SQUARE_API = Deno.env.get('SQUARE_API_BASE') ?? 'https://connect.squareup.com'

/**
 * Square signs `notification_url + raw_body` — the URL exactly as configured in
 * the Square dashboard, not as reconstructed from the request. Behind any proxy
 * the reconstructed one differs (scheme, host, trailing slash) and every
 * signature fails, so it is configuration rather than inference.
 */
const NOTIFICATION_URL = Deno.env.get('SQUARE_NOTIFICATION_URL') ?? ''

/** Constant-time compare: a fast-exit compare on a signature leaks it byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function signatureFor(payload: string, key: string): Promise<string> {
  const mac = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', mac, new TextEncoder().encode(payload))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const SIGNATURE_KEY = Deno.env.get('SQUARE_SIGNATURE_KEY')
  const SQUARE_TOKEN = Deno.env.get('SQUARE_ACCESS_TOKEN')
  if (!SIGNATURE_KEY || !SQUARE_TOKEN || !NOTIFICATION_URL) return json({ error: 'not configured' }, 503)

  // --- is this actually Square ---------------------------------------------
  // Read the body as TEXT and verify before parsing. Verifying a re-serialized
  // object cannot work — key order and whitespace would have to survive a round
  // trip — and parsing first means running the parser on unverified input.
  const raw = await req.text()
  const given = req.headers.get('x-square-hmacsha256-signature') ?? ''
  const expected = await signatureFor(NOTIFICATION_URL + raw, SIGNATURE_KEY)
  if (!given || !safeEqual(given, expected)) return json({ error: 'bad signature' }, 401)

  let event: any = null
  try {
    event = JSON.parse(raw)
  } catch {
    return json({ ok: true, ignored: 'unparseable' })
  }

  // Subscription lifecycle only. An invoice or payment event is a fact about
  // money, not about access: `charged_through_date` on the subscription is the
  // single field that says how long this user has paid for, and taking access
  // from exactly one field means the two can never disagree.
  const type = String(event?.type ?? '')
  if (type !== 'subscription.created' && type !== 'subscription.updated') {
    return json({ ok: true, ignored: type })
  }

  const sub = event?.data?.object?.subscription
  const customerId = sub?.customer_id ? String(sub.customer_id) : ''
  if (!customerId) return json({ ok: true, ignored: 'no customer' })

  // --- which of OUR users is this ------------------------------------------
  // Square's `reference_id` on the customer is the join. It is set when the
  // subscription is started (the checkout flow creates the customer with the
  // signed-in Supabase user id in it), so the mapping is established by the
  // party that actually knows both ids. Deriving it from the billing email
  // instead would let anyone with a Square account claim any Cardstock account
  // whose address they can guess.
  const customer = await fetch(`${SQUARE_API}/v2/customers/${customerId}`, {
    headers: { Authorization: `Bearer ${SQUARE_TOKEN}`, 'Square-Version': '2025-01-23' },
  }).catch(() => null)
  if (!customer?.ok) return json({ error: 'customer lookup failed' }, 503)
  const userId = String((await customer.json())?.customer?.reference_id ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ ok: true, ignored: 'no reference_id' })

  // --- how long have they paid for -----------------------------------------
  // ACTIVE with a paid-through date grants; anything else (CANCELED, PAUSED,
  // DEACTIVATED, or an active subscription whose date has not been set yet)
  // writes an entitlement that has already expired. Writing the expired row
  // rather than deleting it is deliberate: the row is the audit trail of why
  // someone lost access, and `consume_scan_credit` already treats "expired" and
  // "absent" identically.
  const paidThrough = sub?.charged_through_date ? String(sub.charged_through_date) : ''
  const active = String(sub?.status ?? '').toUpperCase() === 'ACTIVE' && !!paidThrough
  const expiresAt = active
    ? new Date(new Date(`${paidThrough}T00:00:00Z`).getTime() + GRACE_DAYS * 86_400_000).toISOString()
    : new Date(0).toISOString()

  // Service role, so RLS is bypassed — which is the ONLY way this table is ever
  // written (migration 0005: nobody may write it through PostgREST, because a
  // user who could would grant themselves the tier).
  const write = await fetch(`${SUPABASE_URL}/rest/v1/entitlements?on_conflict=user_id,feature`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      user_id: userId,
      feature: FEATURE,
      expires_at: expiresAt,
      source: 'square',
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => null)
  // A 5xx here is the one case worth failing: Square will retry, and a dropped
  // renewal is a paying user locked out.
  if (!write?.ok) return json({ error: 'write failed' }, 503)

  return json({ ok: true, feature: FEATURE, active, expires_at: expiresAt })
})
