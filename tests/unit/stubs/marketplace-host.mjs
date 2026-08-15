/**
 * Stands in for the two modules marketplace.ts pulls in at import time: the
 * auth session (localStorage) and the cloud config.
 *
 * `CLOUD_AVAILABLE` is deliberately TRUE here. The point of the test that uses
 * this stub is that the marketplace stays off even when everything else is
 * configured and the user is signed in — if the stub said the cloud was
 * unavailable, the assertion would pass for the wrong reason and keep passing
 * after somebody deleted the switch.
 */

export class CloudError extends Error {}

export const SUPABASE_URL = 'https://example.test'
export const SUPABASE_KEY = 'sb_publishable_stub'
export const CLOUD_AVAILABLE = true

export function isSignedIn() {
  return true
}

export async function freshToken() {
  return 'stub-token'
}
