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
 * Entitlement has no authority in this architecture yet, and that is a real
 * decision rather than an oversight: the deployed app is a static gh-pages
 * bundle with no backend, and `server/` is a sync box the user hosts
 * themselves, so it can never be the authority on whether that same user has
 * paid. CLAUDE.md lays out the three honest options. Whichever is chosen, two
 * properties are not negotiable — scanning keeps working offline, and
 * analytics stay content-free.
 */

export type PaidFeature = 'photo-upload' | 'page-scan'

/**
 * Flip a feature to `true` and it becomes the paid tier's. Deliberately a
 * plain table and not a settings flag: nothing reads a stored entitlement yet,
 * and inventing storage for one would be picking an answer to the question
 * above by accident.
 */
const GATED: Record<PaidFeature, boolean> = {
  'photo-upload': false,
  'page-scan': false,
}

export function isEntitled(feature: PaidFeature): boolean {
  return !GATED[feature]
}
