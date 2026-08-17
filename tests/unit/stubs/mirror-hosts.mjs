/**
 * Host stubs for bundling lib/catalog.ts in node tests: settings, analytics,
 * cloud config, and the auth error shapes.
 */

/* ./settings */
export const settings = () => globalThis.__mirrorSettings ?? { cardSourceLookup: true }

/* ./analytics */
export const track = (t, data = {}) => {
  ;(globalThis.__mirrorTracked ??= []).push({ t, ...data })
}

/* ./cloudconfig */
export const SUPABASE_URL = 'https://mirror.invalid'
export const SUPABASE_KEY = 'pk_test'
export const CLOUD_AVAILABLE = true

/* ./authsession */
export class CloudError extends Error {}
export const readError = async (_res, fallback) => fallback

