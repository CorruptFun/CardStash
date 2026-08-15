/**
 * Stands in for `cloudconfig.ts` so authsession.ts can be loaded in node without
 * `import.meta.env`. The values are arbitrary — every request is stubbed.
 */

export const SUPABASE_URL = 'https://project.test'
export const SUPABASE_KEY = 'test-publishable-key'
export const CLOUD_AVAILABLE = true
