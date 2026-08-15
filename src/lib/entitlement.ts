/**
 * The seam for the planned paid tier — photo upload and binder/multi-card
 * scanning (see CLAUDE.md). NOTHING is gated today, and nothing should be
 * while these features are still being built. This module exists so the
 * decision has ONE place to land rather than being retrofitted across the
 * call sites once it is made.
 *
 * Where the seam goes matters more than the flag. It belongs on the ENTRY
 * POINTS — the upload control and the page-scan path — and NEVER on
 * `detectCardRegions`. That primitive is shared: it is also the fix for
 * ordinary single-card detection over-reaching on cluttered backgrounds,
 * which is the free path and the dominant real-world failure (scan-harness
 * lessons 32 and 34-38). Gating it would quietly degrade free scanning for
 * everyone who never buys anything.
 *
 * Entitlement now HAS an authority, and it is the third of CLAUDE.md's three
 * options: a first-party backend (decision 2a). It is deliberately not this
 * file. The Supabase project that already carries the vault and hosted social
 * holds the `entitlements` table, the monthly meter, and the model key that
 * costs money; `scan-card` checks all three before it calls anything. That is
 * the only arrangement in which the answer cannot simply be edited in devtools.
 *
 * Two properties stayed non-negotiable through that change, and still are:
 * scanning keeps working offline with no account, and analytics stay
 * content-free regardless of subscription state.
 */

export type PaidFeature = 'photo-upload' | 'page-scan' | 'cloud-scan'

/**
 * Which features THIS CLIENT refuses on its own. Flip one to `true` and the
 * entry points stop offering it.
 *
 * `cloud-scan` is false, and that is not an oversight — it is the difference
 * between the two kinds of paid feature this app now has:
 *
 *   * `photo-upload` and `page-scan` cost US nothing to run. If they are ever
 *     gated, this table is the gate, and it is soft by nature: a flag in a
 *     static bundle is one devtools tab from being true, which is a price
 *     worth paying for a feature that works offline. Whether they become paid
 *     at all is still an open product decision — that is why they are here and
 *     still false.
 *   * `cloud-scan` spends a real API key on a real bill, so it cannot be
 *     defended from the client at all. `scan-card` checks entitlement and the
 *     monthly allowance itself, with the service role, and answers 403/429 to
 *     anyone who is not owed a scan. Pre-checking it here would add no
 *     security and one new way to be locally WRONG — refusing a subscriber
 *     whose row this device has not seen yet, or refusing the bring-your-own
 *     -key user who owes us nothing because they pay Google directly.
 *
 * So `cloud-scan` is listed to say that it IS a paid feature and that the
 * decision has a home, while the enforcement stays where it can be enforced.
 * The switch a user actually holds is `cloudScanRescue` in settings, and that
 * one is about consent to upload rather than about payment.
 */
const GATED: Record<PaidFeature, boolean> = {
  'photo-upload': false,
  'page-scan': false,
  'cloud-scan': false,
}

export function isEntitled(feature: PaidFeature): boolean {
  return !GATED[feature]
}
