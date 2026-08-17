/**
 * Stands in for the three modules `referral.ts` and `billing.ts` — and
 * `social.ts` behind them — pull in at import time: the auth session, the
 * cloud config, and the settings store, which is zustand + localStorage and
 * cannot exist in node at all.
 *
 * `CLOUD_AVAILABLE` is deliberately TRUE here, for the same reason the
 * marketplace stub says so: a test that finds nothing sent must be finding it
 * because the code decided not to send, never because the stub had the cloud
 * switched off and the assertion passed for the wrong reason.
 *
 * The MUTABLE halves hang off globals rather than module state, because the
 * test imports a BUNDLE — esbuild inlines this file into it, so a copy the test
 * imported directly would be a different module holding different variables.
 */

export const SETTINGS_DEFAULTS = {
  referralFrom: '',
  referralAt: 0,
  socialHandle: '',
  profileId: 'stub-profile',
  profileName: 'Rae',
  profileNote: '',
  shareScope: 'trade',
  cloudScanRescue: false,
  rescueAutoOnAt: 0,
  // Never mutated in place — noteCap/noteRemaining always mint a new object —
  // so the shared reference across {...SETTINGS_DEFAULTS} resets is safe.
  rescueMeter: { month: '', remaining: 0, cap: 0 },
  rescueHintDismissedAt: 0,
}

export function settings() {
  const store = (globalThis.__settings ??= { ...SETTINGS_DEFAULTS })
  return { ...store, set: (patch) => Object.assign(store, patch) }
}

export const SUPABASE_URL = 'https://example.test'
export const SUPABASE_KEY = 'sb_publishable_stub'
export const CLOUD_AVAILABLE = true

export class CloudError extends Error {}

export function isSignedIn() {
  return globalThis.__signedIn !== false
}

export async function freshToken() {
  return 'stub-token'
}

/** The real one registers a hook that clears the settled flag on sign-out. */
export function onSignOut() {}
