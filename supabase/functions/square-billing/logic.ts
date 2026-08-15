/**
 * The parts of the Square webhook that are pure decisions rather than I/O.
 *
 * Split out so they can be tested by `npm run test:unit` in plain node: the
 * handler itself needs Deno, a Square account and a Supabase project, and the
 * things most worth getting right — is this really Square, and how long has
 * this person paid for — need none of those. Web Crypto is used rather than
 * any runtime's own hashing so the same code runs in Deno and in the test.
 *
 * Nothing here reads the environment or the network. Keep it that way; the
 * moment a decision needs a fetch it belongs in index.ts.
 */

/**
 * Square signs `notification_url + raw_body` with the endpoint's signature key
 * and sends base64 HMAC-SHA256.
 *
 * The URL is the one CONFIGURED in Square, never one reconstructed from the
 * request: behind any proxy the reconstruction differs in scheme, host or a
 * trailing slash and every signature fails. The body is the RAW text, because
 * a re-serialized object would have to reproduce key order and whitespace
 * exactly to hash the same.
 */
export async function squareSignature(payload: string, key: string): Promise<string> {
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

/**
 * Constant-time compare. A fast-exit compare on a signature leaks it byte by
 * byte to anyone who can time the endpoint, which is everyone.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** A Supabase user id, as it arrives from Square's `reference_id`. */
export function isUserId(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export interface SubscriptionEvent {
  /** Square customer whose `reference_id` maps to one of our users. */
  customerId: string
  status: string
  chargedThroughDate: string
}

/**
 * The subscription an event is about, or null when the event is not one we act
 * on. Subscription lifecycle ONLY: an invoice or payment event is a fact about
 * money, not about access. `charged_through_date` is the single field that says
 * how long this person has paid for, so taking access from exactly that one
 * field means the two can never disagree with each other.
 */
export function subscriptionFromEvent(event: unknown): SubscriptionEvent | null {
  const e = event as any
  const type = String(e?.type ?? '')
  if (type !== 'subscription.created' && type !== 'subscription.updated') return null
  const sub = e?.data?.object?.subscription
  const customerId = sub?.customer_id ? String(sub.customer_id) : ''
  if (!customerId) return null
  return {
    customerId,
    status: String(sub?.status ?? ''),
    chargedThroughDate: sub?.charged_through_date ? String(sub.charged_through_date) : '',
  }
}

/**
 * How long the entitlement should last, given the subscription and a grace
 * window in days.
 *
 * ACTIVE with a paid-through date grants; everything else — CANCELED, PAUSED,
 * DEACTIVATED, or an ACTIVE subscription whose date is not set yet — returns an
 * expiry in the past. Writing an expired row rather than deleting one is
 * deliberate: the row is the record of why someone lost access, and
 * `consume_scan_credit` already treats expired and absent identically.
 *
 * The grace window exists because a renewal webhook can land late and a card
 * can be retried for a day. Being stingy here means a paying user whose
 * scanner quietly stops, which is far worse than a few free days.
 */
export function entitlementWindow(
  sub: SubscriptionEvent,
  graceDays: number,
  now: () => number = Date.now,
): { active: boolean; expiresAt: string } {
  const active = sub.status.toUpperCase() === 'ACTIVE' && !!sub.chargedThroughDate
  if (!active) return { active: false, expiresAt: new Date(0).toISOString() }
  const paidThrough = new Date(`${sub.chargedThroughDate}T00:00:00Z`).getTime()
  // An unparseable date is not a grant. Square sends YYYY-MM-DD, but a field we
  // did not validate must not become unlimited access by way of NaN.
  if (!Number.isFinite(paidThrough)) return { active: false, expiresAt: new Date(0).toISOString() }
  void now
  return { active: true, expiresAt: new Date(paidThrough + graceDays * 86_400_000).toISOString() }
}
