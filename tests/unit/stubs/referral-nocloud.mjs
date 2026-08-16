/**
 * The same host with no Supabase project configured — a fork, or a build that
 * never filled the keys in. Everything referral must be inert there, and the
 * only difference between this file and its sibling is the one flag, so a test
 * using it cannot be passing for any other reason.
 */

export {
  CloudError,
  SETTINGS_DEFAULTS,
  SUPABASE_KEY,
  SUPABASE_URL,
  freshToken,
  isSignedIn,
  onSignOut,
  settings,
} from './referral-host.mjs'

export const CLOUD_AVAILABLE = false
