/**
 * The parts of the Stripe escrow function that are pure decisions rather than
 * I/O — signature verification, what an event means, and what the fee is.
 *
 * Split out so they can be tested by `npm run test:unit` in plain node: the
 * handler itself needs Deno, a Stripe account and a Supabase project, and the
 * things most worth getting right — is this really Stripe, and how much money
 * is whose — need none of those. Web Crypto is used rather than any runtime's
 * own hashing so the same code runs in Deno and in the test. Exactly the split
 * `square-billing/logic.ts` makes, for exactly the same reason.
 *
 * Nothing here reads the environment or the network. Keep it that way; the
 * moment a decision needs a fetch it belongs in index.ts.
 *
 * WHAT IS DELIBERATELY *NOT* HERE: the order state machine. Which transitions
 * are legal lives in migration 0006's `advance_order()` and nowhere else. It
 * was tempting to mirror it here so it could be unit-tested in node, but two
 * authorities on a money state machine disagree eventually, and the one that
 * loses is always the one that is not actually guarding the row. This module
 * decides what a Stripe event MEANS; the database decides whether that is
 * allowed. The edges are proven by tests/harness/escrow-rls.mjs against real
 * SQL rather than against a copy of it.
 */

/**
 * Stripe signs `${timestamp}.${raw_body}` with the endpoint's signing secret
 * and sends lowercase hex HMAC-SHA256 — note both differences from Square,
 * which signs `url + body` and sends base64.
 */
export async function stripeSignature(payload: string, secret: string): Promise<string> {
  const mac = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', mac, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
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

/**
 * Pull the timestamp and the v1 signatures out of a `Stripe-Signature` header:
 *
 *   t=1614556800,v1=5257a8...,v1=aa9f0e...
 *
 * There can be more than one `v1` during a secret rotation, and any of them
 * matching is a valid request — dropping all but the first would break every
 * rotation. Unknown schemes (`v0`, used only for Connect's older test events)
 * are ignored rather than treated as failures.
 */
export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = Number.NaN
  const signatures: string[] = []
  for (const part of String(header ?? '').split(',')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') timestamp = Number(value)
    else if (key === 'v1' && value) signatures.push(value)
  }
  return { timestamp, signatures }
}

/** Default replay window, in seconds. Stripe's own libraries use five minutes. */
export const SIGNATURE_TOLERANCE_S = 300

/**
 * Is this really Stripe, and is it recent?
 *
 * The timestamp check is not ceremony: without it, a signature captured once
 * stays valid forever, so anyone who ever saw one request could replay "this
 * order was paid" indefinitely. The timestamp is inside the signed payload, so
 * it cannot be edited without invalidating the signature.
 *
 * TAKES SEVERAL SECRETS, and that is not only about rotation. A Connect
 * platform needs TWO endpoints: the charge and checkout events happen on the
 * platform account, while `account.updated` is about a connected account and
 * arrives only on a destination scoped to connected accounts. Stripe issues a
 * separate signing secret per endpoint, so a single-secret verifier silently
 * rejects every delivery from one of them — and the half that breaks is seller
 * onboarding, which presents as "verification never completes" with nothing in
 * the logs but a 401.
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

  const ageS = Math.abs(now() / 1000 - timestamp)
  if (ageS > toleranceS) return false

  // Every secret against every offered v1, without short-circuiting on the
  // first match, so neither the endpoint a request came from nor whether it
  // matched early is observable in the response time. safeEqual keeps each
  // individual comparison constant-time.
  let ok = false
  for (const key of keys) {
    const expected = await stripeSignature(`${timestamp}.${rawBody}`, key)
    for (const given of signatures) if (safeEqual(given, expected)) ok = true
  }
  return ok
}

/** One of our order ids, as it arrives from Stripe metadata. */
export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

// ------------------------------------------------------------------- money

/**
 * Below this, a sale costs more to process than it earns. Stripe takes
 * 2.9% + 30c of every charge and `controller.fees.payer = application` means we
 * pay it, so a $2 card would cost 36c to collect. Mirrored in 0006's
 * `open_order()`, which is the copy that is actually enforced — this one exists
 * so the UI can refuse before sending the user to a checkout that would fail.
 */
export const MIN_ORDER_CENTS = 500

/** Our cut of the item price. */
export const FEE_RATE = 0.08

/**
 * A floor on the fee, because a percentage alone does not survive contact with
 * card prices. At 8%, a $5 card earns 40c while Stripe takes 44.5c of the same
 * charge — every cheap sale would be a small donation. The floor is what makes
 * the low end break even; the percentage is what makes the high end worth
 * running.
 */
export const MIN_FEE_CENTS = 100

/**
 * What Cardstock keeps, in cents.
 *
 * Charged on the ITEM only, never on postage. Taking a cut of what someone
 * spends at the post office is the kind of detail people notice and resent, and
 * it earns almost nothing.
 *
 * Integer cents throughout, rounded once, at the end. Money that goes through a
 * float gets rounded twice somewhere and then two systems disagree by a cent
 * forever.
 */
export function feeFor(itemCents: number): number {
  if (!Number.isFinite(itemCents) || itemCents <= 0) return MIN_FEE_CENTS
  return Math.max(MIN_FEE_CENTS, Math.round(itemCents * FEE_RATE))
}

export interface Split {
  /** What the buyer is charged. */
  totalCents: number
  /** What we keep. */
  feeCents: number
  /** What is transferred to the seller on release. */
  sellerCents: number
}

/**
 * Split a sale three ways, or explain why it cannot be one.
 *
 * Returns null when the order is below the minimum or the numbers are not
 * whole, non-negative cents — a caller must treat null as "do not open this
 * order", never as zero.
 */
export function splitFor(itemCents: number, shippingCents: number): Split | null {
  // Type-checked BEFORE any coercion, not after. `Number('2000')` is a perfectly
  // good integer, so coercing first would accept a string amount off a JSON
  // body — and a string is how a client-supplied price arrives. An amount that
  // is not already a number is a caller bug, and quietly fixing it here is how
  // that bug reaches the ledger.
  const item = itemCents
  const shipping = shippingCents
  if (typeof item !== 'number' || typeof shipping !== 'number') return null
  if (!Number.isInteger(item) || !Number.isInteger(shipping)) return null
  if (item < 0 || shipping < 0) return null

  const totalCents = item + shipping
  if (totalCents < MIN_ORDER_CENTS) return null

  const feeCents = feeFor(item)
  // Cannot happen at the current constants, but the invariant the database
  // enforces is `fee < total`, and a future fee schedule must not be able to
  // breach it silently.
  if (feeCents >= totalCents) return null

  return { totalCents, feeCents, sellerCents: totalCents - feeCents }
}

// ------------------------------------------------------------------ events

export type Intent =
  /** The buyer paid: `pending` -> `paid`. */
  | { kind: 'paid'; orderId: string; sessionId: string; paymentIntentId: string }
  /** The checkout was abandoned or timed out: `pending` -> `cancelled`. */
  | { kind: 'cancelled'; orderId: string }
  /** A refund cleared: -> `refunded`. */
  | { kind: 'refunded'; orderId: string }
  /** A seller finished (or lost) Stripe verification. Not an order at all. */
  | { kind: 'account'; accountId: string; payoutsEnabled: boolean; chargesEnabled: boolean }
  /** The card network opened a chargeback. Reported, never auto-applied. */
  | { kind: 'chargeback'; orderId: string | null }

/**
 * What an event means for us, or null when it means nothing.
 *
 * Order id travels in `metadata.order_id`, set by us when the Checkout Session
 * is created, and is validated as a uuid before it is used. Taking it from
 * anywhere else — a client reference, an email, a line item description —
 * would let anyone who can guess an id talk about somebody else's order.
 *
 * A CHARGEBACK IS NOT A TRANSITION. `charge.dispute.created` is the card
 * network's decision, arrives on its own schedule, and can land long after the
 * money was released and the transfer settled. Mapping it onto our `disputed`
 * state — which exists to freeze an auto-release timer that has already fired —
 * would either fail as an illegal transition or, worse, quietly rewrite the
 * history of a closed sale. It is surfaced so a human sees it, and that is all.
 */
export function eventIntent(event: unknown): Intent | null {
  const e = event as any
  const type = String(e?.type ?? '')
  const object = e?.data?.object

  switch (type) {
    case 'checkout.session.completed': {
      // `paid` is the only status that means the money is really there;
      // `unpaid` arrives for asynchronous methods that can still fail.
      if (object?.payment_status !== 'paid') return null
      const orderId = String(object?.metadata?.order_id ?? '')
      if (!isUuid(orderId)) return null
      return {
        kind: 'paid',
        orderId,
        sessionId: String(object?.id ?? ''),
        paymentIntentId: String(object?.payment_intent ?? ''),
      }
    }

    case 'checkout.session.expired': {
      const orderId = String(object?.metadata?.order_id ?? '')
      if (!isUuid(orderId)) return null
      return { kind: 'cancelled', orderId }
    }

    case 'charge.refunded': {
      const orderId = String(object?.metadata?.order_id ?? '')
      if (!isUuid(orderId)) return null
      return { kind: 'refunded', orderId }
    }

    case 'charge.dispute.created': {
      const orderId = String(object?.metadata?.order_id ?? '')
      return { kind: 'chargeback', orderId: isUuid(orderId) ? orderId : null }
    }

    case 'account.updated': {
      const accountId = String(object?.id ?? '')
      if (!accountId.startsWith('acct_')) return null
      // `payouts_enabled` alone is not enough: an account can be payout-capable
      // while the `transfers` capability is still pending, and a Transfer to it
      // would be refused. Both, or the seller is not ready.
      const transfers = object?.capabilities?.transfers === 'active'
      return {
        kind: 'account',
        accountId,
        payoutsEnabled: object?.payouts_enabled === true && transfers,
        chargesEnabled: object?.charges_enabled === true,
      }
    }

    default:
      return null
  }
}

// ------------------------------------------------------------------ timers

/** Auto-release this long after the seller marked it shipped. */
export const AUTO_RELEASE_DAYS = 7
/** Auto-refund this long after payment if it was never shipped. */
export const AUTO_REFUND_DAYS = 14

export type SweepAction = 'release' | 'refund' | null

/**
 * What the timer sweep should do with one order, if anything.
 *
 * An escrow with no timer is one where a buyer who simply stops replying keeps
 * a seller's money forever — the commonest real failure, and worse than
 * releasing a few days early. The mirror case is a seller who takes the money
 * and never posts: that one refunds.
 *
 * `disputed` is absent from both branches on purpose. Raising a dispute freezes
 * the clock; a frozen clock that quietly expires anyway is not a freeze.
 */
export function sweepAction(
  order: { status: string; shippedAt: number | null; paidAt: number | null },
  now: number,
): SweepAction {
  const days = (then: number | null) => (then == null ? -1 : (now - then) / 86_400_000)

  if (order.status === 'shipped' && days(order.shippedAt) >= AUTO_RELEASE_DAYS) return 'release'
  if (order.status === 'paid' && days(order.paidAt) >= AUTO_REFUND_DAYS) return 'refund'
  return null
}
