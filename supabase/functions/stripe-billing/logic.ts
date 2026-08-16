/**
 * What a Stripe subscription event MEANS. Pure, so it can be tested without a
 * network, a clock or a database — the same split `square-billing/logic.ts` and
 * `stripe-escrow/logic.ts` use, and for the same reason: billing bugs are
 * decided here, and a bug here is somebody's scanner going dark or somebody
 * getting a year free.
 *
 * THIS FILE KNOWS NOTHING ABOUT ENTITLEMENTS. It reads Stripe's shapes and
 * answers "who, which features, until when". Writing that to the table is
 * `index.ts`'s job, and the table is the interface (migration 0005) — which is
 * exactly why replacing Square is a new sibling file rather than a rewrite.
 */

const ENCODER = new TextEncoder()

/** Signature freshness. Same tolerance Stripe's own libraries default to. */
export const SIGNATURE_TOLERANCE_S = 300

export async function stripeSignature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, ENCODER.encode(payload))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time compare — a timing side channel on a signature is a forgery oracle. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = NaN
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2)
    if (k?.trim() === 't') timestamp = Number(v)
    else if (k?.trim() === 'v1' && v) signatures.push(v.trim())
  }
  return { timestamp, signatures }
}

/**
 * Verify a `stripe-signature` header. Accepts a LIST of secrets for the same
 * reason `stripe-escrow` does: endpoints are per-destination and each has its
 * own signing secret, so a single-secret verifier silently 401s every delivery
 * from the other one.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string,
  secrets: string | string[],
  now: () => number = Date.now,
  toleranceS: number = SIGNATURE_TOLERANCE_S,
): Promise<boolean> {
  const keys = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean)
  if (!rawBody || !header || !keys.length) return false
  const { timestamp, signatures } = parseSignatureHeader(header)
  if (!Number.isFinite(timestamp) || !signatures.length) return false
  if (Math.abs(now() / 1000 - timestamp) > toleranceS) return false

  // No short-circuit: which secret matched, and whether it matched early, must
  // not be observable in the response time.
  let ok = false
  for (const key of keys) {
    const expected = await stripeSignature(`${timestamp}.${rawBody}`, key)
    for (const given of signatures) if (safeEqual(given, expected)) ok = true
  }
  return ok
}

/** A Supabase user id, as it arrives from Stripe metadata. */
export function isUserId(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export interface SubscriptionEvent {
  /** OUR user id, carried in metadata we set. Never derived from an email. */
  userId: string
  /** Stripe's status: active, trialing, past_due, canceled, unpaid, … */
  status: string
  /**
   * Unix seconds the paid period runs to.
   *   > 0  a real period end
   *   = 0  none yet — a checkout that just completed (see the bridge below)
   *   < 0  the field was present and UNUSABLE, which must never mean access
   */
  periodEnd: number
  /** Stripe's id, for logging and idempotency. */
  subscriptionId: string
  /**
   * A one-off FOUNDING purchase: lifetime access, no renewal, no expiry.
   * Distinguished from a subscription because the entitlement it writes has
   * `expires_at = NULL` (migration 0005: null means no expiry) and because a
   * seat has to be claimed against it.
   */
  founding?: boolean
  /** 'referred' | 'standard' — which price was sold, for the referral bounty. */
  tier?: string
}

/**
 * Pull the subscription facts out of an event, or null if this is not one we
 * act on.
 *
 * WE JOIN ON METADATA WE SET, NEVER ON AN EMAIL. `square-billing` uses
 * `reference_id` for exactly this reason and CLAUDE.md calls it out: a billing
 * email is attacker-chosen and joining on it means anyone who can create a
 * Stripe customer with the right address can grant themselves a subscription.
 * `metadata.user_id` is written by our own checkout call and by nothing else.
 *
 * Both the subscription object and a checkout session are accepted, because the
 * first event of a new subscriber's life is usually `checkout.session.completed`
 * and waiting for the subscription event would leave them unentitled for the
 * seconds in between — which is precisely when they go to use what they bought.
 */
export function subscriptionFromEvent(event: unknown): SubscriptionEvent | null {
  if (typeof event !== 'object' || event === null) return null
  const e = event as Record<string, unknown>
  const type = typeof e.type === 'string' ? e.type : ''
  const object = ((e.data as Record<string, unknown>)?.object ?? null) as Record<string, unknown> | null
  if (!object) return null

  const metadata = (object.metadata ?? {}) as Record<string, unknown>
  // A checkout session carries `client_reference_id` as well; accept either.
  const userId = isUserId(metadata.user_id)
    ? String(metadata.user_id)
    : isUserId(object.client_reference_id)
      ? String(object.client_reference_id)
      : ''
  if (!userId) return null

  if (type === 'checkout.session.completed') {
    if (object.payment_status !== 'paid') return null

    // A one-off purchase is the FOUNDING seat: paid once, keeps access for
    // good. Guarded on our own metadata rather than on the mode alone, so an
    // unrelated one-off charge on the same account can never be mistaken for a
    // lifetime grant.
    if (object.mode === 'payment') {
      const seat = Number((metadata as Record<string, unknown>).founding_seat)
      if (!Number.isInteger(seat) || seat < 1 || seat > 100) return null
      return { userId, status: 'active', periodEnd: 0, subscriptionId: '', founding: true }
    }

    // A completed subscription checkout means paid NOW. The period end arrives
    // with the subscription event moments later; until then grant a short
    // window so the thing they just bought works immediately.
    if (object.mode !== 'subscription') return null
    return {
      userId,
      status: 'active',
      periodEnd: 0,
      subscriptionId: typeof object.subscription === 'string' ? object.subscription : '',
      tier: typeof (metadata as Record<string, unknown>).tier === 'string'
        ? String((metadata as Record<string, unknown>).tier)
        : '',
    }
  }

  if (type.startsWith('customer.subscription.')) {
    const raw = Number(object.current_period_end)
    return {
      userId,
      // A deleted subscription is not active whatever the object says.
      status: type === 'customer.subscription.deleted' ? 'canceled' : String(object.status ?? ''),
      // -1, NOT 0. Collapsing an unparseable date to 0 would land it in the
      // checkout bridge below and hand out a day of access for a field we could
      // not read — the exact "NaN becomes unlimited" trap the Square version
      // guards against.
      periodEnd: Number.isFinite(raw) && raw > 0 ? raw : -1,
      subscriptionId: typeof object.id === 'string' ? object.id : '',
    }
  }

  return null
}

/** Statuses that mean "they have paid and may use it". */
const ENTITLING = new Set(['active', 'trialing'])

/**
 * Turn a subscription into a window of access.
 *
 * `past_due` is deliberately NOT entitling on its own — but it rarely bites,
 * because the previous period's `expires_at` is still in the future and this
 * function never shortens an existing grant; `index.ts` only ever pushes the
 * date forward. The effect is Square's behaviour: a failed card costs access
 * only once the paid-for time actually runs out, retries and all.
 */
export function entitlementWindow(
  sub: SubscriptionEvent,
  graceDays: number,
  now: () => number = Date.now,
): { active: boolean; expiresAt: string } {
  if (!ENTITLING.has(sub.status.toLowerCase())) {
    return { active: false, expiresAt: new Date(0).toISOString() }
  }
  // A negative period end means the field was there and unusable. Refuse it —
  // only an ABSENT one (exactly 0, set by a completed checkout) earns the
  // bridge, which exists so what someone just paid for works this second while
  // the subscription event catches up.
  if (sub.periodEnd < 0) return { active: false, expiresAt: new Date(0).toISOString() }
  const base = sub.periodEnd > 0 ? sub.periodEnd * 1000 : now() + 86_400_000
  if (!Number.isFinite(base)) return { active: false, expiresAt: new Date(0).toISOString() }
  return { active: true, expiresAt: new Date(base + graceDays * 86_400_000).toISOString() }
}
