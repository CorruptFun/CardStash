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
    if (!row) return none
    // A null expiry is a comped grant with no end — see 0005.
    const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Number.POSITIVE_INFINITY
    if (!Number.isFinite(expiresAt) && row.expires_at) return none
    return {
      active: expiresAt > Date.now(),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      source: typeof row.source === 'string' ? row.source : '',
    }
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

export { SUBSCRIPTION_FEATURES }
