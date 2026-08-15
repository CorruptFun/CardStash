/**
 * Where the anonymous diagnostics log is posted, when the user allows it.
 *
 * This used to be two text fields in Settings — an "ingest endpoint" and an
 * "ingest token" — which made sharing theoretically opt-in and practically
 * impossible: no user has an ingest token for our server, none can obtain one,
 * so the switch above them could be turned on and still send nothing forever.
 * A control that cannot succeed is worse than no control, because it reads as a
 * working one.
 *
 * So the destination is compiled in, exactly as `VITE_PSA_TOKEN` is, and the
 * only thing left in Settings is the question a user can actually answer: may
 * we have it. Read `VITE_DIAG_TOKEN` in `.env.example` before setting one — the
 * token ships readable inside a static bundle, and the consequences of that are
 * spelled out there.
 *
 * Empty token = dormant. `flushTelemetry` returns immediately, the Settings row
 * never renders, and the app makes no request. Diagnostics are still collected
 * locally and are still visible in Settings; the log has always been for the
 * user first and us second.
 */

const env = (import.meta.env ?? {}) as Record<string, string | undefined>

/**
 * No default, deliberately. The previous one —
 * `https://telemetry.corrupt.solutions/ingest/telemetry` — shipped in every
 * install and was never a receiver for this app: that host serves Family Hub,
 * and the path 404s (docs/roadmap.md found the same thing independently). A
 * plausible-looking constant pointing at somebody else's origin is how events
 * end up posted at a stranger. Configure both halves or stay dormant.
 */
export const DIAG_ENDPOINT: string = (env.VITE_DIAG_ENDPOINT ?? '').trim()

export const DIAG_TOKEN: string = (env.VITE_DIAG_TOKEN ?? '').trim()

/** Can this build post anything at all? Both halves are required. */
export const DIAG_AVAILABLE = Boolean(DIAG_ENDPOINT && DIAG_TOKEN)
