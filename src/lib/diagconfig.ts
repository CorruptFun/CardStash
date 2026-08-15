/**
 * Where the anonymous diagnostics log goes: `ingest_events()` on Cardstock's
 * own Supabase project, the same one that already carries the vault, hosted
 * social and orders (migration `0007_analytics.sql`).
 *
 * THERE IS NO SEPARATE CREDENTIAL, and that is the point of putting it here.
 * The publishable key already ships in the bundle and is public by
 * construction; a bearer token for some other host would have been equally
 * readable in the same bundle, plus a second thing to rotate and a second thing
 * to forget. What actually defends the receiver is in the SQL — the function is
 * the only way in, it validates and caps every batch, and nothing but
 * `service_role` can read a row back.
 *
 * This used to be two text fields in Settings, an "ingest endpoint" and an
 * "ingest token", which made sharing theoretically opt-in and practically
 * impossible: no user has a token for our server, none can obtain one, so the
 * switch above them could be turned on and still send nothing forever. A
 * control that cannot succeed is worse than no control, because it reads as a
 * working one.
 *
 * Dormant when the build configured no project, exactly as the vault and hosted
 * social are: `flushTelemetry` returns immediately and the Settings row does not
 * render. Diagnostics are still COLLECTED locally either way and still shown in
 * Settings — the log has always been for the user first and us second.
 */

import { CLOUD_AVAILABLE, SUPABASE_URL } from './cloudconfig'

/** Can this build post diagnostics anywhere at all? */
export const DIAG_AVAILABLE = CLOUD_AVAILABLE

export const DIAG_ENDPOINT = `${SUPABASE_URL}/rest/v1/rpc/ingest_events`
