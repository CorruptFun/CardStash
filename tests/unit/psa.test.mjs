/**
 * The PSA response normalizer, held to by test.
 *
 * This layer exists because the live response shape could not be verified
 * from a build environment — PSA's field casing differs between their docs and
 * their endpoints. So it reads keys case-insensitively and tolerates missing
 * halves, and these cases pin that tolerance: the point is that a renamed or
 * absent field degrades to a blank rather than to a wrong card.
 *
 * The second half pins the WIRE contract, per build shape. A build carries a
 * token (direct to PSA, bearer header), an endpoint (our `psa-proxy`, keyless
 * — the whole point is that no credential exists in the page), or neither
 * (dormant). `bundleImport`'s `define` stands in for what Vite decides at
 * compile time, and the fetch stub records what would have gone out.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'stubs', 'psa-host.mjs')
const FETCH_STUB = join(HERE, 'stubs', 'psa-fetch.mjs')

const { normalizePsaCert, psaSport, psaToParsed, psaLookup, PSA_AVAILABLE } = await bundleImport('src/lib/psa.ts', {
  alias: { './db': STUB },
})

/** Bundle psa.ts as a specific build shape, with the recording fetch stub. */
const shaped = (envShape) =>
  bundleImport('src/lib/psa.ts', {
    alias: { './db': STUB, './fetchJson': FETCH_STUB },
    define: { 'import.meta.env': JSON.stringify(envShape) },
  })

/** What the stub saw for one lookup — reset, run, read back. */
async function wireCall(lookup, cert) {
  globalThis.__psaFetchLog = []
  const outcome = await lookup(cert)
  const calls = globalThis.__psaFetchLog
  delete globalThis.__psaFetchLog
  return { outcome, calls }
}

test('the documented PascalCase shape reads cleanly', () => {
  const cert = normalizePsaCert(
    {
      PSACert: {
        CertNumber: '09472817',
        Year: '1989',
        Brand: 'UPPER DECK',
        Subject: 'KEN GRIFFEY JR.',
        CardNumber: '1',
        Variety: 'RC',
        Category: 'Baseball Cards',
        CardGrade: '10',
        GradeDescription: 'GEM MT',
        TotalPopulation: 8000,
      },
      // extra keys must not confuse it
    },
    '09472817',
  )
  assert.equal(cert.year, 1989)
  assert.equal(cert.subject, 'KEN GRIFFEY JR.')
  assert.equal(cert.cardNumber, '1')
  assert.equal(cert.grade, 10)
  assert.equal(cert.totalPopulation, 8000)
})

test('camelCase and an unwrapped body read identically', () => {
  const cert = normalizePsaCert({ certNumber: '1', year: 2023, subject: 'Victor Wembanyama', cardGrade: 9 }, '1')
  assert.equal(cert.subject, 'Victor Wembanyama')
  assert.equal(cert.year, 2023)
})

test('a grade spelled only in words is still recovered', () => {
  // The numeric field is missing; "GEM MT 10" still carries the number.
  const cert = normalizePsaCert({ PSACert: { Subject: 'X', GradeDescription: 'GEM MT 10' } }, '5')
  assert.equal(cert.grade, 10)
})

test('junk in is a blank record, never a fabricated one', () => {
  assert.equal(normalizePsaCert(null, '1'), null)
  assert.equal(normalizePsaCert('nope', '1'), null)
  const empty = normalizePsaCert({}, '1')
  assert.equal(empty.subject, undefined)
  assert.equal(empty.grade, undefined)
})

test('PSA categories map onto our sports', () => {
  assert.equal(psaSport('Baseball Cards'), 'baseball')
  assert.equal(psaSport('Basketball Cards'), 'basketball')
  assert.equal(psaSport('Non-Sports Cards'), 'other')
  assert.equal(psaSport(undefined), 'other')
})

test('a cert becomes the same parsed shape an OCR read produces', () => {
  const parsed = psaToParsed({
    cert: '09472817',
    year: 1989,
    brand: 'UPPER DECK',
    subject: 'Ken Griffey Jr.',
    cardNumber: '1',
    variety: 'RC',
    category: 'Baseball Cards',
  })
  assert.equal(parsed.brand, 'Upper Deck')
  assert.equal(parsed.player, 'Ken Griffey Jr.')
  assert.equal(parsed.sport, 'baseball')
  assert.equal(parsed.rookie, true)
  // A cert lookup is authoritative, not a guess.
  assert.equal(parsed.confidence, 1)
})

test('with neither token nor endpoint the module is dormant', async () => {
  assert.equal(PSA_AVAILABLE, false)
  const outcome = await psaLookup('09472817')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'not-configured')
})

test('an endpoint alone makes lookups available, and no credential is sent', async () => {
  // This is the deployed shape: VITE_PSA_ENDPOINT points at psa-proxy, no
  // VITE_PSA_TOKEN exists anywhere in the bundle. Before the proxy landed,
  // psa.ts stayed dormant unless a token was ALSO compiled in — which would
  // have made "point the endpoint at a proxy" a no-op.
  const proxy = await shaped({ VITE_PSA_ENDPOINT: 'https://proxy.test/functions/v1/psa-proxy/' })
  assert.equal(proxy.PSA_AVAILABLE, true)
  const { outcome, calls } = await wireCall(proxy.psaLookup, '0947-2817')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.cert.subject, 'Test Subject')
  assert.equal(calls.length, 1)
  // Trailing slash trimmed, non-digits stripped, cert as the last segment —
  // exactly the GET the proxy's certFromPath expects.
  assert.equal(calls[0].url, 'https://proxy.test/functions/v1/psa-proxy/09472817')
  // Keyless: no Authorization, no apikey, no headers at all. A bare GET stays
  // a CORS simple request and nothing secret exists in the page to leak.
  assert.equal(calls[0].headers, null)
})

test('a compiled-in token is still never sent to the proxy', async () => {
  // Both values configured: the endpoint wins, and the token stays home — a
  // credential does not belong in requests to another host.
  const both = await shaped({
    VITE_PSA_ENDPOINT: 'https://proxy.test/psa-proxy',
    VITE_PSA_TOKEN: 'oops-still-here',
  })
  const { calls } = await wireCall(both.psaLookup, '123')
  assert.equal(calls[0].url, 'https://proxy.test/psa-proxy/123')
  assert.equal(calls[0].headers, null)
})

test('the direct-to-PSA shape is untouched: default endpoint, bearer header', async () => {
  const direct = await shaped({ VITE_PSA_TOKEN: 'test-token' })
  assert.equal(direct.PSA_AVAILABLE, true)
  const { outcome, calls } = await wireCall(direct.psaLookup, '09472817')
  assert.equal(outcome.ok, true)
  assert.equal(calls[0].url, 'https://api.psacard.com/publicapi/cert/GetByCertNumber/09472817')
  assert.deepEqual(calls[0].headers, { Authorization: 'bearer test-token' })
})
