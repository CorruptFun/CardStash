/**
 * What is still unconnected, and how often to say so.
 *
 * One module because the welcome screen and the recurring nudge must agree —
 * two copies of "are they set up?" drift, and the failure mode is telling
 * someone to do a thing they already did.
 *
 * ## The copy has to be true
 *
 * "Your data isn't saved" is the obvious thing to say and it is **wrong**:
 * cards live in IndexedDB and survive a reload perfectly well. Worse,
 * *signing in does not back anything up either* — the vault needs a passphrase
 * (`cloud.ts`), which is a second, deliberate act with no reset. A nudge that
 * claims otherwise is one the user can disprove by closing and reopening the
 * app, and a warning that cries wolf gets dismissed reflexively for the rest
 * of the product's life.
 *
 * So the steps are separate and named for what each one actually buys:
 *
 * | Step | What is missing | What doing it buys |
 * | ---- | --------------- | ------------------ |
 * | `signin` | no account | an identity that survives losing the device |
 * | `handle` | account, no handle | being findable, and receiving trades |
 * | `backup` | signed in, no Drive copy | a second copy in storage they own |
 *
 * `backup` is deliberately last, and since decision 15b it is also the mildest:
 * signing in already backs the collection up automatically, so this step is no
 * longer "you could lose everything" but "you may want a copy we do not hold".
 * Overstating it would be the exact failure this file warns about — a warning
 * the user can disprove is one they learn to dismiss.
 */

import { isSignedIn } from './authsession'
import { CLOUD_AVAILABLE } from './cloudconfig'
import { settings } from './settings'

export type ConnectStep = 'signin' | 'handle' | 'backup'

/** Three days, as asked for: often enough to matter, rare enough to read. */
export const NUDGE_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000

/**
 * A build with no Supabase project (a fork) has nothing to connect *to*, so
 * onboarding and the nudge both disappear rather than pointing at a sign-in
 * that cannot work.
 */
export function accountsAvailable(): boolean {
  return CLOUD_AVAILABLE
}

/** The next thing worth connecting, or null when everything is. */
export function nextConnectStep(): ConnectStep | null {
  if (!accountsAvailable()) return null
  if (!isSignedIn()) return 'signin'
  const config = settings()
  if (!config.socialHandle) return 'handle'
  // The automatic vault no longer counts here, because since 15b EVERY signed-in
  // user has one — testing for it would mean this step never fires, or fires for
  // everyone until their first sync lands. What is left worth nudging about is a
  // copy in storage the user owns, which is Drive.
  if (!config.driveBackup) return 'backup'
  return null
}

/** Has the welcome screen been answered — signed in *or* skipped? */
export function isOnboarded(): boolean {
  return settings().onboardedAt > 0
}

/**
 * Whether first run should take over the screen.
 *
 * Two escapes, both deliberate:
 *
 * - **`?welcome=0`** exists for the browser harnesses, which are first-time
 *   visitors by definition and would otherwise all have to learn to click
 *   through onboarding. It is not a security boundary — the screen is
 *   skippable anyway — but if `ALLOW_SKIP` in `Welcome.tsx` is ever turned
 *   off, this has to go with it or the "lock" is one query param wide.
 * - **`?demo=1`** seeds demo data for a look around; asking that visitor to
 *   make an account first defeats the point of the flag.
 */
export function shouldShowWelcome(search = location.search): boolean {
  if (!accountsAvailable() || isOnboarded()) return false
  const params = new URLSearchParams(search)
  return params.get('welcome') !== '0' && params.get('demo') !== '1'
}

/**
 * Whether the recurring nudge is due.
 *
 * Never before onboarding (the welcome is already asking), never when there
 * is nothing left to connect, and never twice inside the interval. The first
 * one is timed from `onboardedAt`, so someone who skips gets three days of
 * quiet rather than a banner on the same launch they just dismissed one.
 */
export function nudgeDue(now = Date.now()): ConnectStep | null {
  const config = settings()
  if (!isOnboarded()) return null
  const step = nextConnectStep()
  if (!step) return null
  const last = config.accountNudgeAt || config.onboardedAt
  return now - last >= NUDGE_INTERVAL_MS ? step : null
}

/** Push the next nudge out by one interval. */
export function snoozeNudge(now = Date.now()): void {
  settings().set({ accountNudgeAt: now })
}

/** A first handle suggestion from an email local-part, or '' if unusable. */
export function suggestHandle(email: string): string {
  const local = email.split('@')[0] ?? ''
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24)
  return cleaned.length >= 3 ? cleaned : ''
}
