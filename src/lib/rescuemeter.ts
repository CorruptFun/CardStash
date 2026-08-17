/**
 * The rescue meter: what this account has left of the month's cloud rescues,
 * as last reported by the server — cached so the app can SAY it.
 *
 * The number exists because every successful `scan-card` 200 carries
 * `remaining` (the CloudCardRead contract), and until now the client dropped
 * it on the floor. That made the rescue invisible: a subscriber watched cards
 * identify and never learned the cloud did it, and a free account never saw
 * the 50-a-month allowance move. This module is the fix — pure functions only,
 * so node can test the month arithmetic; the settings writes live with the
 * callers (`gemini.ts` notes `remaining`, `billing.ts` notes the cap).
 *
 * Three rules keep it honest rather than decorative:
 *
 * - **The server's number is the only number.** Nothing here counts scans;
 *   `remaining` is stored as answered and keyed to the UTC month
 *   (`consume_scan_credit` buckets by `to_char(now() at time zone 'utc',
 *   'YYYY-MM')`, and `meterMonth` matches it). Another device draws on the
 *   same allowance, which is exactly why a locally-kept count would lie.
 * - **A stale month is no answer.** `readRescueMeter` returns null once the
 *   month rolls over — the surfaces show nothing rather than last month's
 *   figure, until the next rescue reports in.
 * - **The cap is derived, never guessed.** A 200 with `remaining` ≥ 50 can
 *   only be the subscriber pool (the free pool answers 49 at most, because the
 *   server consumes before it counts); anything smaller is ambiguous, so the
 *   cap comes from a real entitlement answer (`noteCap`, fed by
 *   `subscriptionState()`) or stays 0 = unknown and the copy goes capless —
 *   "37 left this month" is true with no cap at all.
 *
 * And one contract inherited from `scan-card`'s header: every non-200 is a
 * plain local miss to the client, so nothing in this file — and nothing fed by
 * it — may branch the viewfinder on a status code. The meter only ever moves
 * on a SUCCESS; exhaustion talk belongs to the Settings screen and the
 * subscription panel, never to someone holding a card.
 */

export interface RescueMeter {
  /** UTC month the sample belongs to ('2026-08'), '' = no sample yet. */
  month: string
  /** Rescues left after the last successful one, as the server answered. */
  remaining: number
  /** The month's allowance behind that number — 50, 1000, or 0 = unknown. */
  cap: number
}

/**
 * Copies of the server's own defaults (`SCAN_FREE_MONTHLY_LIMIT` and
 * `SCAN_MONTHLY_LIMIT` on the `scan-card` function), on the same terms as the
 * price strings in billing.ts: the server is the authority, these exist so the
 * UI can name the number, and they have to move when the env does.
 */
export const FREE_MONTHLY_RESCUES = 50
export const SUBSCRIBER_MONTHLY_RESCUES = 1000

export const EMPTY_RESCUE_METER: RescueMeter = { month: '', remaining: 0, cap: 0 }

/** The server's month key, exactly: UTC, 'YYYY-MM'. */
export function meterMonth(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 7)
}

/**
 * Rehydration door (settings.ts merge), same reasoning as `profileLinks`:
 * localStorage is editable by anyone with devtools and these digits end up
 * rendered as text, so junk collapses to "no sample" and the cap may only be
 * a value the product actually has — never a number somebody typed.
 */
export function sanitizeRescueMeter(value: unknown): RescueMeter {
  const raw = (value ?? {}) as Partial<RescueMeter>
  const cap = raw.cap === FREE_MONTHLY_RESCUES || raw.cap === SUBSCRIBER_MONTHLY_RESCUES ? raw.cap : 0
  const month = typeof raw.month === 'string' && /^\d{4}-\d{2}$/.test(raw.month) ? raw.month : ''
  const remaining =
    typeof raw.remaining === 'number' && Number.isFinite(raw.remaining) && raw.remaining >= 0
      ? Math.floor(raw.remaining)
      : 0
  return month ? { month, remaining, cap } : { month: '', remaining: 0, cap }
}

/**
 * A rescue succeeded and the server said what is left. Returns the meter to
 * store, or null when the value is not a usable number — the caller writes
 * nothing rather than a guess.
 *
 * Last write wins, deliberately: a binder page runs rescues concurrently and
 * two answers can land out of order, but the skew is one credit and the next
 * rescue rights it — where a monotonic clamp would pin the meter low for the
 * rest of the month after a mid-month subscription jumps the number UP.
 */
export function noteRemaining(prev: RescueMeter | undefined, remaining: unknown, at?: number): RescueMeter | null {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0) return null
  const base = sanitizeRescueMeter(prev)
  const value = Math.floor(remaining)
  // ≥ 50 proves the subscriber pool. Below that the cap already known stands —
  // including a lapsed subscription's 1000 until the next entitlement answer
  // corrects it (noteCap), which is the least wrong the client can be offline.
  const cap = value >= FREE_MONTHLY_RESCUES ? SUBSCRIBER_MONTHLY_RESCUES : base.cap
  return { month: meterMonth(at), remaining: value, cap }
}

/**
 * A real entitlement answer arrived (a row, or a definitive no-row) — the one
 * honest source for the cap below 50. Returns `prev` UNCHANGED (same
 * reference, so callers can skip the write) when the cap already agrees; a cap
 * that CHANGES drops the sample with it, because a `remaining` measured under
 * the other tier's allowance is a different pool's number and pairing them
 * would misstate usage — "49 left" under cap 50 must not become "used 951 of
 * 1,000" the moment someone subscribes.
 */
export function noteCap(prev: RescueMeter | undefined, active: boolean): RescueMeter {
  const base = sanitizeRescueMeter(prev)
  const cap = active ? SUBSCRIBER_MONTHLY_RESCUES : FREE_MONTHLY_RESCUES
  if (base.cap === cap && prev) return prev
  return { month: '', remaining: 0, cap }
}

/**
 * The meter, if this month has a real sample; null otherwise, and the surfaces
 * show nothing. A `remaining` above the stored cap (possible only through a
 * hand-edited store) downgrades the cap to unknown rather than rendering an
 * impossibility.
 */
export function readRescueMeter(meter: RescueMeter | undefined, at?: number): { remaining: number; cap: number } | null {
  const base = sanitizeRescueMeter(meter)
  if (!base.month || base.month !== meterMonth(at)) return null
  const cap = base.cap > 0 && base.remaining <= base.cap ? base.cap : 0
  return { remaining: base.remaining, cap }
}

/**
 * The moment line for the scan screen's toast when a card was identified
 * `via: 'cloud'` — passive, no action, and it degrades by what is actually
 * known: cap and count, count alone, or just the fact the cloud answered.
 */
export function rescueMomentText(meter: RescueMeter | undefined, at?: number): string {
  const now = readRescueMeter(meter, at)
  if (!now) return 'Read in the cloud'
  if (!now.cap) return `Read in the cloud — ${now.remaining.toLocaleString()} left this month`
  return `Read in the cloud — ${now.remaining.toLocaleString()} of ${now.cap.toLocaleString()} left this month`
}
