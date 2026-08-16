/**
 * Referrals, and the first hundred seats.
 *
 * THE OFFER: someone who arrives through a friend's link may buy lifetime
 * access once, for a one-off fee, while any of the 100 founding seats remain;
 * everyone else buys the yearly subscription. `supabase/migrations/0014` holds
 * every rule that decides money — who was referred, whether a seat is free,
 * which price Stripe is handed. Nothing in this file decides anything. It
 * carries a handle from a link to `claim_referral()`, and afterwards asks the
 * server what the offer looks like.
 *
 * ## Why the handle is STORED rather than read where it is used
 *
 * A referral arrives in a URL on a device with **no account** — the person
 * being referred does not exist yet, and `claim_referral()` needs an
 * `auth.uid()`. Between the link opening and the account existing sits sign-in,
 * and sign-in destroys the URL: `startGoogleSignIn()` sends the browser away
 * and comes back to `origin + pathname`, so the query string and the fragment
 * are both gone, and `adoptOAuthRedirect()` rewrites what is left before the
 * router ever reads it. Code that read the URL at the moment of claiming would
 * work perfectly with an emailed code and silently never fire for Google.
 *
 * So: capture at boot into settings (`captureReferral`, called from main.tsx
 * ahead of everything that touches the URL), redeem once there is an account
 * (`redeemReferral`, after sign-in and after a handle is claimed).
 *
 * ## Failure is always silent
 *
 * A referral is a nicety that changes a price. Onboarding must never wait on
 * it, never fail because of it and never show an error about it: the person
 * reading that error cannot act on it, and interrupting a sign-in to explain a
 * discount costs more than the discount is worth.
 *
 * ## Nothing here is tracked
 *
 * A handle is identity, so it must not ride a diagnostic event — `redact()`
 * drops the key already, and hashing one into an event instead would be the
 * same leak wearing a hat. There are no `track()` calls in this file on
 * purpose.
 *
 * Dormant with no cloud configured, like everything else that needs the project.
 */

import { freshToken, isSignedIn, onSignOut } from './authsession'
import { CLOUD_AVAILABLE, SUPABASE_KEY, SUPABASE_URL } from './cloudconfig'
import { settings } from './settings'

/**
 * The query key a referral rides on: `?via=rae`.
 *
 * It is **not** in the fragment, where the share payload lives. A binder link
 * is `…/?via=rae#/x?d=<blob>`: `parseRoute` reads the fragment and
 * `decodeShareText` scans it for `[?&]d=`, so a key in the search string cannot
 * be mistaken for a payload by either, and no payload can be mistaken for a
 * referral. Putting it in front of the `#` also puts it in front of the blob,
 * which matters because a binder link runs to `LONG_LINK_CHARS` — a chat app
 * that truncates one eats whatever is at the END of the URL.
 *
 * `ref` was the obvious name, and is the conventional name for an ad-tracking
 * parameter — the thing link scrubbers and "copy clean link" features look for.
 * A referral quietly stripped in transit is exactly the bug this file exists to
 * fix, so the name says what it means instead.
 */
export const REFERRAL_PARAM = 'via'

/**
 * A handle as it may appear in a link, or '' if it cannot be one.
 *
 * The same alphabet as `normalizeHandle` in socialcloud.ts, deliberately
 * copied rather than imported: this runs at boot on a URL from a stranger, and
 * socialcloud pulls the whole hosted transport (and Dexie) in behind it. The
 * bounds are the server's own (`bad_handle`, 3–24), so anything outside them
 * is junk that would only be stored to be refused later. The value is never
 * trusted regardless — `claim_referral()` resolves it against `profiles` and
 * returns false for anything that is not a real collector.
 */
export function normalizeReferral(raw: string | null | undefined): string {
  const clean = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_]/g, '')
  return clean.length >= 3 && clean.length <= 24 ? clean : ''
}

/**
 * The referral a URL carries, or ''.
 *
 * Both halves are read even though only the search half is ever written: a link
 * that has been rewritten by a chat app, or hand-built onto an existing
 * `#/x?d=…`, still works. There is no ambiguity to worry about — a blob is
 * base64url and can hold neither `?` nor `&`, so `via=` inside one can never
 * begin a parameter.
 */
export function referralFromUrl(search = location.search, hash = location.hash): string {
  const inHash = hash.includes('?') ? new URLSearchParams(hash.slice(hash.indexOf('?') + 1)) : null
  for (const raw of [new URLSearchParams(search).get(REFERRAL_PARAM), inHash?.get(REFERRAL_PARAM)]) {
    const clean = normalizeReferral(raw)
    if (clean) return clean
  }
  return ''
}

/**
 * The query a share link carries for `handle` — '' when there is nothing to say.
 *
 * The empty case is the important one: a collector with no handle is the
 * serverless default the whole product rests on, and their link must come out
 * byte-identical to the one they got before any of this existed.
 */
export function referralQuery(handle: string): string {
  const clean = normalizeReferral(handle)
  return clean ? `?${REFERRAL_PARAM}=${clean}` : ''
}

/**
 * Remember the referral this launch arrived with; returns what is now stored.
 *
 * THE FIRST LINK WINS, permanently. `claim_referral()` records one referrer per
 * account for ever and refuses to change it, so overwriting here would leave
 * the app crediting a friend the server does not — the app and the database
 * disagreeing about who introduced someone is worse than either answer.
 */
export function captureReferral(search = location.search, hash = location.hash): string {
  if (!CLOUD_AVAILABLE) return ''
  const config = settings()
  if (config.referralFrom) return config.referralFrom
  const found = referralFromUrl(search, hash)
  if (found) config.set({ referralFrom: found })
  return found
}

/**
 * Hand the stored referral to `claim_referral()`, once there is an account.
 *
 * Safe to call as often as anything likes: the RPC is idempotent by
 * construction (one row per account, never updated) and `referralAt` stops the
 * request being re-sent on every launch for the rest of the install's life.
 *
 * **Any HTTP answer is a final answer.** `claim_referral()` returns false
 * rather than erroring when it declines, and every reason it declines —
 * already referred, self-referral, no such handle — is permanent. Only a
 * transport failure leaves the flag clear, so the retry is for being offline
 * and nothing else.
 */
export async function redeemReferral(): Promise<void> {
  if (!CLOUD_AVAILABLE || !isSignedIn()) return
  const config = settings()
  if (!config.referralFrom || config.referralAt) return
  try {
    const token = await freshToken()
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_referral`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_handle: config.referralFrom }),
    })
    if (res.ok) settings().set({ referralAt: Date.now() })
  } catch {
    /* offline: leave it pending and try again next launch */
  }
}

// A device outlives an account. The next person to sign in here has their own
// referral to redeem, and a settled flag left by the previous account would
// swallow it without a sound.
onSignOut(() => {
  settings().set({ referralAt: 0 })
})

export interface FoundingOffer {
  /** The server holds a referral row for whoever is signed in. */
  referred: boolean
  /** How many of the hundred are still available. */
  seatsLeft: number
}

/**
 * What the founding offer looks like for the signed-in account, or null when
 * there is nothing to say.
 *
 * BOTH ANSWERS COME FROM THE SERVER, never from the settings above. `referrals`
 * is read-own under RLS, so this is the same fact `reserve_founding_seat()`
 * will check at checkout: an account referred on another phone still sees the
 * offer here, and a settings key someone hand-edited buys nothing but different
 * words on a screen. That is billing.ts's rule as well — a client-side check is
 * a suggestion, and the only thing it may do is choose which words to show.
 *
 * The cheap question is asked first because most people were not referred and
 * never need the seat count.
 */
export async function foundingOffer(): Promise<FoundingOffer | null> {
  if (!CLOUD_AVAILABLE || !isSignedIn()) return null
  try {
    const token = await freshToken()
    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` }
    const mine = await fetch(`${SUPABASE_URL}/rest/v1/referrals?select=user_id&limit=1`, { headers })
    if (!mine.ok) return null
    const rows = (await mine.json().catch(() => [])) as unknown[]
    if (!Array.isArray(rows) || !rows.length) return { referred: false, seatsLeft: 0 }

    const seats = await fetch(`${SUPABASE_URL}/rest/v1/rpc/founding_seats_left`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!seats.ok) return null
    // Clamped because it lands in a sentence: a number the server got wrong
    // should read as "none left", never as "-3 places remain".
    const left = Number(await seats.json().catch(() => 0))
    return { referred: true, seatsLeft: Number.isFinite(left) ? Math.min(100, Math.max(0, Math.trunc(left))) : 0 }
  } catch {
    // Offline is not "you were never referred" — say nothing rather than
    // withdraw an offer the account actually holds.
    return null
  }
}
