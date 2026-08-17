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
 * One exception, and it is consent rather than enforcement: the first time an
 * active subscription is seen, `noteEntitlementSeen()` switches the cloud
 * rescue on for this device — once, and never again. See that function.
 *
 * Dormant wherever the cloud is: no project configured, no subscription UI, and
 * the app behaves exactly as it did before any of this existed.
 */

import { CloudError, freshToken, isSignedIn } from './authsession'
import { CLOUD_AVAILABLE, SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'
import { noteCap } from './rescuemeter'
import { settings } from './settings'

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
/** What a referrer earns per paying referral. Mirrors `referral_bounty_cents()`. */
export const REFERRAL_BOUNTY = '$2'

export interface SubscriptionState {
  /** Paid up right now. */
  active: boolean
  /** When it runs out, epoch ms — including the webhook's grace days. 0 = never granted. */
  expiresAt: number
  /** `stripe`, `square` (legacy), `manual` for a comped grant. */
  source: string
}

export const billingAvailable = (): boolean => CLOUD_AVAILABLE

/**
 * The one thing a subscription changes on the client by itself: the first time
 * THIS DEVICE sees an active entitlement, the cloud rescue's switch comes on.
 *
 * The rescue is the thing being bought — the pitch names it, the price is
 * justified by it — so the purchase is read as asking for it. But exactly
 * once, recorded in `rescueAutoOnAt`: a subscriber who then turns the rescue
 * off has answered, and no renewal, re-fetch, checkout return or later
 * sign-in flips it back. The switch stays the authority over the image
 * (settings.ts); the purchase throws it one time.
 *
 * Every path entitlement state lands through funnels here via
 * `subscriptionState()` — the Stripe return's `?subscribed=1` re-ask included
 * — rather than flipping the switch at its own call site. Yearly, founding
 * and comped grants all pass through, because all three are the same
 * entitlement row.
 */
export function noteEntitlementSeen(state: SubscriptionState): void {
  if (!state.active) return
  const config = settings()
  if (config.rescueAutoOnAt) return
  config.set({ cloudScanRescue: true, rescueAutoOnAt: Date.now() })
}

/**
 * The other fact an entitlement answer settles: which allowance the rescue
 * meter's `remaining` counts down from — 1,000 for a subscriber, 50 free.
 * Only a REAL answer lands here (a row, or a definitive no-row); offline and
 * server errors say nothing, for the same reason `subscriptionState()`
 * returns `none` without concluding anything from them. `noteCap` hands back
 * the same object when the cap already agrees, so this writes only on change.
 */
function noteRescueAllowance(active: boolean): void {
  const config = settings()
  const next = noteCap(config.rescueMeter, active)
  if (next !== config.rescueMeter) config.set({ rescueMeter: next })
}

/**
 * What this account has. Read straight from `entitlements`, which users may
 * SELECT for themselves and nobody may write through PostgREST (migration
 * 0005) — so this is honest without being authoritative.
 */
export async function subscriptionState(): Promise<SubscriptionState> {
  const none: SubscriptionState = { active: false, expiresAt: 0, source: '' }
  if (!CLOUD_AVAILABLE || !isSignedIn()) return none
  try {
    const token = await freshToken()
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/entitlements?feature=eq.cloud-scan&select=expires_at,source&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) return none
    const rows = (await res.json()) as { expires_at: string | null; source: string }[]
    const row = Array.isArray(rows) ? rows[0] : undefined
    if (!row) {
      // A definitive "never granted" — the free allowance is this account's.
      noteRescueAllowance(false)
      return none
    }
    // A null expiry is a comped grant with no end — see 0005.
    const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Number.POSITIVE_INFINITY
    if (!Number.isFinite(expiresAt) && row.expires_at) return none
    const state: SubscriptionState = {
      active: expiresAt > Date.now(),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      source: typeof row.source === 'string' ? row.source : '',
    }
    noteEntitlementSeen(state)
    noteRescueAllowance(state.active)
    return state
  } catch {
    // Offline is not "unsubscribed" — say nothing rather than the wrong thing.
    return none
  }
}

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
 */
export async function startSubscriptionCheckout(): Promise<{ url: string; managing: boolean }> {
  if (!CLOUD_AVAILABLE) throw new CloudError('Subscriptions are not switched on for this build')
  if (!isSignedIn()) throw new CloudError('Sign in first')
  const token = await freshToken()
  const res = await fetch(`${SUPABASE_URL}/functions/v1/stripe-billing/checkout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => null)
  if (!res) throw new CloudError('Could not reach the server — check your connection')
  if (res.status === 503) throw new CloudError('Subscriptions are not switched on yet')
  const payload = (await res.json().catch(() => null)) as { url?: string; managing?: boolean } | null
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
