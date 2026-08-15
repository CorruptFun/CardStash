/**
 * Buying a card from a friend — the client side.
 *
 * NO LOCAL MIRROR, and that is a decision rather than an omission. Every other
 * feature in this app is local-first because the user's collection is theirs
 * and must work on a train. An order is the opposite: it is a shared fact
 * between two people and a payment processor, and the server is the only thing
 * that can be right about it. Mirroring it into Dexie would buy an offline view
 * of a screen whose every button needs the network anyway, and would cost a
 * schema version, a sanitizer, and three more places (`exportBackup`,
 * `importBackup`, `clearAllData`) for an amount of money to leak into a file
 * the user hands around. So orders are fetched, never stored.
 *
 * Everything the server returns still goes through the sanitizers below
 * (decision 7). Hosting earns the server no trust it would not extend to a
 * pasted string — and here the strings describe money.
 *
 * The provider is not visible from this file. It talks to our own edge
 * function, which is the only code in the repo that knows what Stripe is.
 */

import { CloudError, freshToken, isSignedIn } from './authsession'
import { CLOUD_AVAILABLE, SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'

/** Where an order has got to. Mirrors the `status` check in migration 0006. */
export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'released'
  | 'refunded'
  | 'cancelled'
  | 'disputed'

const STATUSES: OrderStatus[] = [
  'pending',
  'paid',
  'shipped',
  'delivered',
  'released',
  'refunded',
  'cancelled',
  'disputed',
]

export interface Order {
  id: string
  buyer: string | null
  seller: string | null
  status: OrderStatus
  cardId: string
  cardName: string
  qty: number
  /** All amounts are integer cents, USD. Never floats — see decision 19. */
  itemCents: number
  shippingCents: number
  feeCents: number
  tracking?: string
  createdAt: number
  paidAt?: number
  shippedAt?: number
  deliveredAt?: number
  releasedAt?: number
  refundedAt?: number
  disputedAt?: number
}

/** A postal address, as Stripe collected it. Never stored, only displayed. */
export interface ShippingAddress {
  name?: string
  line1?: string
  line2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

// ---------------------------------------------------------------- sanitizers

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const asStr = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim().slice(0, max)
  return trimmed || undefined
}

/**
 * Cents, as they arrive from Postgres. Must be a whole, non-negative number
 * within a sane range — a NaN here would render as "$NaN" next to a Pay button,
 * and a negative would render as a refund the user is not getting.
 */
const asCents = (v: unknown): number => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) return 0
  return Math.round(n)
}

const asTime = (v: unknown): number | undefined => {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

/** One order row, or null if it is not one. */
export function sanitizeOrder(raw: unknown): Order | null {
  if (!isRecord(raw)) return null
  const id = asStr(raw.id, 64)
  const cardId = asStr(raw.card_id, 160)
  const cardName = asStr(raw.card_name, 200)
  if (!id || !cardId || !cardName) return null

  const status = STATUSES.includes(raw.status as OrderStatus) ? (raw.status as OrderStatus) : 'pending'
  const qty = Math.max(1, Math.min(99, Math.floor(Number(raw.qty) || 1)))

  return {
    id,
    buyer: asStr(raw.buyer, 64) ?? null,
    seller: asStr(raw.seller, 64) ?? null,
    status,
    cardId,
    cardName,
    qty,
    itemCents: asCents(raw.item_cents),
    shippingCents: asCents(raw.shipping_cents),
    feeCents: asCents(raw.fee_cents),
    tracking: asStr(raw.tracking, 64),
    createdAt: asTime(raw.created_at) ?? Date.now(),
    paidAt: asTime(raw.paid_at),
    shippedAt: asTime(raw.shipped_at),
    deliveredAt: asTime(raw.delivered_at),
    releasedAt: asTime(raw.released_at),
    refundedAt: asTime(raw.refunded_at),
    disputedAt: asTime(raw.disputed_at),
  }
}

/**
 * An address, capped hard. It is rendered into the page, so every field is
 * length-bounded — an unbounded "city" is a way to push the rest of the screen
 * off it, and a friend is not automatically a trustworthy source of strings.
 */
export function sanitizeAddress(raw: unknown): ShippingAddress | null {
  if (!isRecord(raw)) return null
  const a = isRecord(raw.address) ? raw.address : raw
  const out: ShippingAddress = {
    name: asStr(raw.name, 100),
    line1: asStr(a.line1, 200),
    line2: asStr(a.line2, 200),
    city: asStr(a.city, 100),
    state: asStr(a.state, 100),
    postalCode: asStr(a.postal_code, 32),
    country: asStr(a.country, 8),
  }
  return out.line1 || out.city || out.postalCode ? out : null
}

// ------------------------------------------------------------------ transport

/**
 * Short machine codes come back from the SQL and from the function; the copy
 * lives here, next to the UI, exactly as `RPC_MESSAGES` does in socialcloud.ts.
 * A user should never see `seller_not_ready`.
 */
const MESSAGES: Record<string, string> = {
  not_signed_in: 'Sign in first',
  bad_parties: 'That sale does not have two sides',
  not_friends: 'You can only buy from people you have added as friends',
  seller_not_ready: 'They have not finished setting up payments yet',
  bad_quantity: 'That quantity is not possible',
  bad_amount: 'That price is not possible',
  below_minimum: 'Sales start at $5 — below that the card costs more to process than it is worth',
  bad_fee: 'That price and fee do not add up',
  no_such_order: 'That order no longer exists',
  not_your_order: 'That is not your order',
  bad_transition: 'That order has already moved on — pull to refresh',
  not_shippable: 'There is nothing to post on this order',
  no_address: 'No address on this order yet',
  not_configured: 'Buying is not switched on for this build',
  sign_in_required: 'Sign in first',
}

const humanize = (code: string): string =>
  MESSAGES[code] ?? (code && code.length < 80 && !code.includes(' ') ? 'That did not work' : code || 'That did not work')

/** Is the marketplace even reachable in this build? */
export function marketAvailable(): boolean {
  return CLOUD_AVAILABLE
}

/** Can this device do anything with money right now? */
export function marketReady(): boolean {
  return CLOUD_AVAILABLE && isSignedIn()
}

async function call<T>(route: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!CLOUD_AVAILABLE) throw new CloudError('Buying is not switched on for this build')
  const token = await freshToken()
  const res = await fetch(`${SUPABASE_URL}/functions/v1/stripe-escrow/${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null)

  if (!res) throw new CloudError('Could not reach the server — check your connection')
  const payload = await res.json().catch(() => null)
  if (!res.ok) throw new CloudError(humanize(String((payload as any)?.error ?? '')))
  return payload as T
}

/**
 * One authenticated PostgREST call, shaped like `rest()` in socialcloud.ts.
 * Orders are read live every time and never cached — the server is the only
 * thing that can be right about where an order has got to.
 */
async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!CLOUD_AVAILABLE) throw new CloudError('Buying is not switched on for this build')
  const token = await freshToken()
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  }).catch(() => null)
  if (!res) throw new CloudError('Could not reach the server — check your connection')
  const body = await res.json().catch(() => null)
  // PostgREST puts a raised machine code in `message`; the function puts it in
  // `error`. Look in both so neither surfaces raw.
  if (!res.ok) throw new CloudError(humanize(String((body as any)?.message ?? (body as any)?.error ?? '')))
  return body
}

const rpc = (fn: string, args: Record<string, unknown>): Promise<unknown> =>
  rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })

// -------------------------------------------------------------------- selling

/**
 * Start (or resume) Connect onboarding. Returns the URL to send them to —
 * navigation is the caller's, because a redirect buried in a library is a
 * redirect nobody expects.
 */
export async function startSellerOnboarding(): Promise<string> {
  const { url } = await call<{ url: string }>('onboard')
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new CloudError('The payment provider returned something unexpected')
  }
  return url
}

/** Has this user finished verification and can they actually be paid? */
export async function sellerReady(): Promise<boolean> {
  if (!marketReady()) return false
  try {
    const { ready } = await call<{ ready: boolean }>('account')
    return ready === true
  } catch {
    // Not being able to answer is not the same as "no", but the only thing the
    // UI does with a false is hide a button, and hiding it on a flaky
    // connection is better than a Sell button that errors when tapped.
    return false
  }
}

/**
 * Can the signed-in user buy from this person? Answers a boolean without
 * revealing anything about their payment setup — see `can_sell()` in 0006.
 */
export async function canBuyFrom(userId: string): Promise<boolean> {
  if (!marketReady() || !userId) return false
  try {
    return (await rpc('can_sell', { p_user: userId })) === true
  } catch {
    // A network failure is not a "no", but the only thing the UI does with
    // false is hide the Buy button, and hiding it beats offering one that
    // errors when tapped.
    return false
  }
}

// -------------------------------------------------------------------- buying

export interface CheckoutRequest {
  sellerId: string
  cardId: string
  cardName: string
  qty: number
  itemCents: number
  shippingCents: number
}

/**
 * Open an order and get the hosted checkout URL.
 *
 * The amounts are sent, but they are not believed: `open_order()` recomputes
 * the floor and the fee and refuses anything that does not add up, so the worst
 * a tampered client achieves is an order the database declines to open.
 */
export async function startCheckout(req: CheckoutRequest): Promise<{ url: string; orderId: string }> {
  const out = await call<{ url: string; orderId: string }>('checkout', {
    sellerId: req.sellerId,
    cardId: req.cardId,
    cardName: req.cardName,
    qty: req.qty,
    itemCents: req.itemCents,
    shippingCents: req.shippingCents,
  })
  if (typeof out?.url !== 'string' || !out.url.startsWith('https://')) {
    throw new CloudError('The payment provider returned something unexpected')
  }
  return out
}

// --------------------------------------------------------------------- orders

/** Every order this user is on, either side, newest first. */
export async function listOrders(): Promise<Order[]> {
  if (!marketReady()) return []
  const rows = await rest('orders?select=*&order=created_at.desc&limit=100')
  if (!Array.isArray(rows)) return []
  return rows.map(sanitizeOrder).filter((o): o is Order => o !== null)
}

export async function getOrder(id: string): Promise<Order | null> {
  if (!marketReady() || !id) return null
  const rows = await rest(`orders?id=eq.${encodeURIComponent(id)}&select=*&limit=1`)
  return Array.isArray(rows) && rows.length ? sanitizeOrder(rows[0]) : null
}

const orderRpc = async (fn: string, args: Record<string, unknown>): Promise<Order | null> => {
  const body = await rpc(fn, args)
  return sanitizeOrder(Array.isArray(body) ? body[0] : body)
}

/** Seller: it is in the post. */
export const markShipped = (orderId: string, tracking?: string): Promise<Order | null> =>
  orderRpc('mark_shipped', { p_order: orderId, p_tracking: tracking?.trim() || null })

/** Buyer: something is wrong. Freezes the auto-release clock for a human. */
export const raiseDispute = (orderId: string, reason?: string): Promise<Order | null> =>
  orderRpc('raise_dispute', { p_order: orderId, p_reason: reason?.slice(0, 500) || null })

/**
 * Buyer: it arrived and I am happy. This both records delivery AND pays the
 * seller, which is why it goes through the edge function rather than straight
 * to the RPC — creating the Stripe transfer is not something the client can do.
 */
export async function confirmReceipt(orderId: string): Promise<{ status: string; payout?: string }> {
  return call<{ status: string; payout?: string }>('confirm', { orderId })
}

/**
 * The buyer's address, for the seller, fetched fresh every time. We never hold
 * one — see decision 19. Only valid while there is something left to post.
 */
export async function fetchShippingAddress(orderId: string): Promise<ShippingAddress | null> {
  const { shipping } = await call<{ shipping: unknown }>('address', { orderId })
  return sanitizeAddress(shipping)
}

// ----------------------------------------------------------------- presenting

export function orderTotalCents(order: Order): number {
  return order.itemCents + order.shippingCents
}

/** What the seller receives on release. */
export function sellerProceedsCents(order: Order): number {
  return Math.max(0, orderTotalCents(order) - order.feeCents)
}

const LABELS: Record<OrderStatus, string> = {
  pending: 'Awaiting payment',
  paid: 'Paid — awaiting postage',
  shipped: 'In the post',
  delivered: 'Delivered',
  released: 'Complete',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
  disputed: 'Issue raised',
}

export const orderStatusLabel = (status: OrderStatus): string => LABELS[status] ?? status

/**
 * What is actually going on, in a sentence, from one side's point of view. The
 * status alone is ambiguous — "Paid" means "post it" to a seller and "wait" to
 * a buyer, and a screen that says the same thing to both is a screen that has
 * not decided who it is for.
 */
export function orderNarrative(order: Order, iAmSeller: boolean): string {
  switch (order.status) {
    case 'pending':
      return iAmSeller ? 'They have not paid yet.' : 'Not paid yet — the checkout may still be open.'
    case 'paid':
      return iAmSeller
        ? 'The money is held. Post the card, then mark it sent.'
        : 'Your money is held safely. They have been asked to post it.'
    case 'shipped':
      return iAmSeller
        ? 'On its way. You will be paid once they confirm it arrived, or automatically after 7 days.'
        : 'On its way. Confirm when it arrives — or we will release payment automatically after 7 days.'
    case 'delivered':
      return iAmSeller ? 'Delivered. Payment is on its way to you.' : 'Delivered. Payment has been released.'
    case 'released':
      return iAmSeller ? 'Paid out. This one is done.' : 'Done — the seller has been paid.'
    case 'refunded':
      return iAmSeller ? 'Refunded to the buyer.' : 'Refunded. The money is on its way back to you.'
    case 'cancelled':
      return 'Cancelled before payment. Nothing was charged.'
    case 'disputed':
      return iAmSeller
        ? 'The buyer has raised a problem. Payment is on hold until it is sorted out.'
        : 'You raised a problem. Payment is on hold while we look at it.'
  }
}
