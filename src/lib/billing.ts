/**
 * The subscription, from the client's side.
 *
 * Two jobs and no more: say whether this account currently has one, and open
 * Stripe's hosted page to start or manage it. Everything that decides ENTITLEMENT
 * still happens on the server — `consume_scan_credit()` and
 * `consume_build_credit()` read the table, and neither asks this file anything.
 * What is here is presentation: a client-side check is a suggestion, and the
 * only thing this one is allowed to do is choose which words to show.
 *
 * That distinction is why there is no caching and no "isSubscribed" gate around
 * the features themselves. Being wrong here shows the wrong button for a moment.
 * Being wrong in `scan-card` would give away a paid API call.
 *
 * Dormant wherever the cloud is: no project configured, no subscription UI, and
 * the app behaves exactly as it did before any of this existed.
 */

import { CloudError, freshToken, isSignedIn } from './authsession'
import { CLOUD_AVAILABLE, SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'

/** Features one subscription buys. Mirrors FEATURES in `stripe-billing`. */
const SUBSCRIPTION_FEATURES = ['cloud-scan', 'ai-builder'] as const

/**
 * The two prices, in words.
 *
 * Stripe holds the real ones — `STRIPE_PRICE_ID` and `STRIPE_FOUNDING_PRICE_ID`
 * on the `stripe-billing` function — and its hosted checkout is the authority,
 * so these are a COPY that has to move whenever a price does. They live here,
 * once, so there is exactly one line to move: quoting one number on this screen
 * and charging another at the till is the sort of thing a person discovers only
 * after paying, and never forgives.
 */
export const YEARLY_PRICE = '$11.99'
export const REFERRED_PRICE = '$9.99'
export const FOUNDING_PRICE = '$6.99'
/**
 * A dollar off the year, offered to someone the scanner has just failed
 * repeatedly — the one moment when "the cards this phone can't read" is a
 * description of what is happening rather than a sales line.
 *
 * TWO SWITCHES, SERVER FIRST, like the marketplace and the eBay comps.
 * `STRIPE_SCAN_OFFER_PRICE_ID` on `stripe-billing` is the real one: without it
 * the function REFUSES an offer checkout rather than falling back to the
 * standard price, because this panel quotes $10.99 out loud and a fallback
 * would charge $11.99 to someone who was told otherwise. `VITE_SCAN_OFFER=on`
 * only stops us making an offer the till would refuse.
 */
export const SCAN_OFFER_PRICE = '$10.99'
export const SCAN_OFFER_SAVING = '$1'
/** What a referrer earns per paying referral. Mirrors `referral_bounty_cents()`. */
export const REFERRAL_BOUNTY = '$2'

/** Reasons a checkout can be started at something other than the list price. */
export type CheckoutOffer = 'scan-miss'

const SCAN_OFFER_ON = ((import.meta.env ?? {}) as Record<string, string | undefined>).VITE_SCAN_OFFER === 'on'

export interface SubscriptionState {
  /** Paid up right now. */
  active: boolean
  /** When it runs out, epoch ms — including the webhook's grace days. 0 = never granted. */
  expiresAt: number
  /** `stripe`, `square` (legacy), `manual` for a comped grant. */
  source: string
}

export const billingAvailable = (): boolean => CLOUD_AVAILABLE

/** May we make the scan-miss offer at all — both switches, before any asking. */
export const scanOfferAvailable = (): boolean => CLOUD_AVAILABLE && SCAN_OFFER_ON

/**
 * What this account has. Read straight from `entitlements`, which users may
 * SELECT for themselves and nobody may write through PostgREST (migration
 * 0005) — so this is honest without being authoritative.
 *
 * `null` means WE COULD NOT ASK — offline, signed out, a failed request — which
 * is a different fact from "not subscribed" and the difference matters as soon
 * as anything is sold on the answer. `subscriptionState()` folds it back to a
 * blank state for the settings panel, which only ever renders words; the offer
 * path below keeps the distinction, because advertising a subscription to a
 * subscriber whose row we merely failed to fetch is a way to look like a liar.
 */
async function readEntitlement(): Promise<SubscriptionState | null> {
  if (!CLOUD_AVAILABLE || !isSignedIn()) return null
  try {
    const token = await freshToken()
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/entitlements?feature=eq.cloud-scan&select=expires_at,source&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) return null
    const rows = (await res.json()) as { expires_at: string | null; source: string }[]
    const row = Array.isArray(rows) ? rows[0] : undefined
    // No row IS an answer, and the only one that means "never had one".
    if (!row) return NOT_SUBSCRIBED
    // A null expiry is a comped grant with no end — see 0005.
    const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Number.POSITIVE_INFINITY
    if (!Number.isFinite(expiresAt) && row.expires_at) return NOT_SUBSCRIBED
    return {
      active: expiresAt > Date.now(),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      source: typeof row.source === 'string' ? row.source : '',
    }
  } catch {
    // Offline is not "unsubscribed" — say nothing rather than the wrong thing.
    return null
  }
}

const NOT_SUBSCRIBED: SubscriptionState = { active: false, expiresAt: 0, source: '' }

/** The settings panel's view: an unanswerable question reads as a blank state. */
export async function subscriptionState(): Promise<SubscriptionState> {
  return (await readEntitlement()) ?? NOT_SUBSCRIBED
}

/**
 * Is this account paid up — `null` when nobody could say.
 *
 * MEMOIZED, because the caller is a scan miss: a card that will not read is
 * read at again and again, and each attempt must not become a round trip. The
 * window is long on purpose. Being stale here shows the wrong words for a few
 * minutes; the checkout itself re-derives everything server-side and hands a
 * live subscriber the billing portal instead of a second sale.
 */
export async function isSubscribed(): Promise<boolean | null> {
  if (!CLOUD_AVAILABLE || !isSignedIn()) return null
  if (memo && Date.now() - memo.at < SUBSCRIPTION_MEMO_MS) return memo.active
  const state = await readEntitlement()
  if (!state) return null
  memo = { at: Date.now(), active: state.active }
  return state.active
}

const SUBSCRIPTION_MEMO_MS = 15 * 60_000
let memo: { at: number; active: boolean } | null = null

/**
 * Get the URL to start a subscription, or to manage an existing one.
 *
 * The server decides which: an account that already has a live Stripe
 * subscription is handed the billing portal instead of a second checkout, so
 * there is one button here rather than a state machine the client has to keep
 * in step with Stripe.
 *
 * Navigation is the caller's, deliberately — a redirect buried in a library is
 * a redirect nobody expects.
 *
 * `offer` is a REQUEST, never a price. The server reads `referral_tier` off the
 * caller's own JWT and sells whichever of the tiers is actually cheaper, so
 * asking for the scan-miss dollar off can only ever be ignored — a referred or
 * founding buyer keeps the better price they already had.
 */
export async function startSubscriptionCheckout(
  opts: { offer?: CheckoutOffer } = {},
): Promise<{ url: string; managing: boolean }> {
  if (!CLOUD_AVAILABLE) throw new CloudError('Subscriptions are not switched on for this build')
  if (!isSignedIn()) throw new CloudError('Sign in first')
  const token = await freshToken()
  const res = await fetch(`${SUPABASE_URL}/functions/v1/stripe-billing/checkout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.offer ? { offer: opts.offer } : {}),
  }).catch(() => null)
  if (!res) throw new CloudError('Could not reach the server — check your connection')
  const payload = (await res.json().catch(() => null)) as { url?: string; managing?: boolean; error?: string } | null
  // A refused OFFER is its own answer, and the honest one: the function will not
  // sell a discount it has no price for, so the alternative is the standard
  // price at a screen that just quoted a lower one.
  if (res.status === 503) {
    throw new CloudError(
      payload?.error === 'offer not configured'
        ? 'That offer isn’t available right now — the standard price is in Settings'
        : 'Subscriptions are not switched on yet',
    )
  }
  if (!res.ok || typeof payload?.url !== 'string' || !payload.url.startsWith('https://')) {
    throw new CloudError('Could not open the payment page')
  }
  return { url: payload.url, managing: payload.managing === true }
}

export interface ReferralEarnings {
  referrals: number
  earnedCents: number
  owedCents: number
  cap: number
}

/**
 * What this account has earned by introducing people.
 *
 * Recording is the server's — `record_referral_reward()` runs with the service
 * role after a payment clears — so this only reads. A founding purchase earns
 * the referrer nothing by design: a one-off lifetime fee has no recurring
 * revenue to share out of.
 */
export async function referralEarnings(): Promise<ReferralEarnings | null> {
  if (!CLOUD_AVAILABLE || !isSignedIn()) return null
  try {
    const token = await freshToken()
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/referral_earnings`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!res.ok) return null
    const rows = (await res.json()) as { referrals: number; earned_cents: number; owed_cents: number; cap: number }[]
    const row = Array.isArray(rows) ? rows[0] : undefined
    if (!row) return null
    return {
      referrals: Number(row.referrals) || 0,
      earnedCents: Number(row.earned_cents) || 0,
      owedCents: Number(row.owed_cents) || 0,
      cap: Number(row.cap) || 0,
    }
  } catch {
    return null
  }
}

export { SUBSCRIPTION_FEATURES }
