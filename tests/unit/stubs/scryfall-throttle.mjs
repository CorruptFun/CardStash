/**
 * fetchJson stub that records WHEN each request was made, so the Scryfall
 * request spacing is testable without a clock or a network, and can be told
 * to answer a given status.
 *
 * State hangs off globalThis on purpose: `bundleImport` bundles this module
 * INTO the module under test, so a test that imported it directly would be
 * holding a second, unrelated copy of the arrays and would watch nothing.
 */

const state = (globalThis.__scryfallStub ??= { calls: [], failWith: [] })

export const calls = state.calls
export const failWith = state.failWith

export async function fetchJson(url) {
  state.calls.push({ url, at: Date.now() })
  const status = state.failWith.shift()
  if (status) throw Object.assign(new Error(`HTTP ${status} for ${url}`), { status })
  return { data: [], object: 'list' }
}

export function httpStatus(err) {
  return typeof err?.status === 'number' ? err.status : null
}

export function isAbort(err) {
  const name = err?.name
  return name === 'AbortError' || name === 'TimeoutError'
}
