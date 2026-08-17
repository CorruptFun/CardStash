/**
 * Stands in for `./fetchJson` when unit-testing psa.ts's wire contract.
 * Records what the module sends — URL shape and headers — and answers with a
 * canned PSA body, so tests can pin the request itself (the thing the proxy
 * depends on) without a network. The bundle swallows this module whole, so
 * the log rides `globalThis` for the test to read back out.
 */
export async function fetchJson(url, options = {}) {
  const log = (globalThis.__psaFetchLog ??= [])
  log.push({ url, headers: options.headers ?? null })
  return { PSACert: { CertNumber: '9', Subject: 'Test Subject', Brand: 'TEST BRAND', CardGrade: '10' } }
}

export function isAbort() {
  return false
}
