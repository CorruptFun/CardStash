/**
 * Stands in for the browser-only modules `messaging.ts` — and `social.ts`
 * behind it — pull in at import time: the auth session, the cloud config, the
 * settings store (zustand + localStorage, which cannot exist in node) and the
 * analytics writer (Dexie).
 *
 * `CLOUD_AVAILABLE` is TRUE and the stub is signed in, for the same reason the
 * referral stub says so: a test that finds a sanitizer rejecting something must
 * be finding it because the sanitizer rejected it, never because the stub had
 * the feature switched off and the assertion passed for the wrong reason.
 */

export const SETTINGS_DEFAULTS = {
  socialHandle: 'rae',
  messageUnread: 0,
  profileId: 'stub-profile',
  profileName: 'Rae',
  profileNote: '',
  profileLinks: [],
  shareScope: 'trade',
  referralFrom: '',
  referralAt: 0,
}

export function settings() {
  const store = (globalThis.__settings ??= { ...SETTINGS_DEFAULTS })
  return { ...store, set: (patch) => Object.assign(store, patch) }
}

export const SUPABASE_URL = 'https://example.test'
export const SUPABASE_KEY = 'sb_publishable_stub'
export const CLOUD_AVAILABLE = true

export class CloudError extends Error {}

export const isSignedIn = () => globalThis.__signedIn !== false
export const currentUserId = () => 'me'
export const freshToken = async () => 'stub-token'
export const authHeaders = (token) => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` })
export const readError = async () => 'refused'
export function onSignOut() {}

/** Every event this stub sees, so a test can assert nothing content-ful rode along. */
export function track(name, data) {
  ;(globalThis.__events ??= []).push({ name, data })
}
export function trackScreen() {}
export function amountBucket() {
  return 'n/a'
}
