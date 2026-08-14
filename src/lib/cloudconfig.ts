/**
 * Where the cloud vault lives.
 *
 * Both values are **designed to be public**: the publishable key identifies
 * the project, and row-level security is the actual boundary — every request
 * is authorised by the signed-in user's JWT against the policy in
 * `supabase/schema.sql`, not by possession of this key. That is why they can
 * sit in a static bundle on gh-pages at all.
 *
 * Two consequences worth stating, because both are load-bearing:
 *
 * - **The RLS policy is the security model.** If `supabase/schema.sql` has not
 *   been applied, or its policy is dropped, this key is enough for anyone to
 *   read the table. The schema is not optional setup; it is the lock.
 * - **The server still cannot read collections.** Vault rows hold ciphertext
 *   from `crypto.ts`, keyed by a passphrase that never leaves the device.
 *
 * A build can override both with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
 * — a fork pointing at its own project changes nothing else. Empty values
 * simply mean the sync UI never appears, keeping decision 11 intact: the app
 * is fully usable with no cloud at all.
 */

const env = import.meta.env ?? {}

export const SUPABASE_URL: string = (env.VITE_SUPABASE_URL ?? 'https://xvfuyvaehtdxroyzixak.supabase.co').replace(
  /\/+$/,
  '',
)

export const SUPABASE_KEY: string = env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_G3bgfYDZWuFYzEufHf793A_i4Po9Y3E'

/** Sync is offered only when a project is configured. */
export const CLOUD_AVAILABLE = Boolean(SUPABASE_URL && SUPABASE_KEY)
