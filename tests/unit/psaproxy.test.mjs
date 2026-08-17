/**
 * The psa-proxy's pure half, held to by test.
 *
 * The function is anonymous by design, so the two things standing between the
 * open internet and our PSA credential are decided in its logic.ts and pinned
 * here: cert validation (nothing but bare, bounded digits may ride upstream
 * under our bearer) and the found/empty classification that picks a cache TTL
 * (a found cert is immutable; "no record" must be allowed to go stale,
 * because certs are minted every day).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const { certParam, certFromPath, certFound, MAX_CERT_DIGITS } = await bundleImport(
  'supabase/functions/psa-proxy/logic.ts',
)

test('a cert is bare digits, bounded, kept verbatim', () => {
  // Leading zeros survive — they are part of the number as printed, PSA
  // accepts them, and the digits double as the cache key.
  assert.equal(certParam('09472817'), '09472817')
  assert.equal(certParam('1'), '1')
  assert.equal(certParam(' 12345678 '), '12345678')
  assert.equal(certParam('9'.repeat(MAX_CERT_DIGITS)), '9'.repeat(MAX_CERT_DIGITS))
})

test('anything that is not bare digits is refused, not cleaned', () => {
  // psa.ts strips non-digits BEFORE it calls, so a forgiving parser here
  // would only be a second implementation waiting to drift.
  for (const bad of ['', '  ', '12 34', '12a4', '1.5', '-1', '+1', '1e4', '12%34', 'DROP TABLE', '9'.repeat(MAX_CERT_DIGITS + 1)]) {
    assert.equal(certParam(bad), null, JSON.stringify(bad))
  }
  // Strings only — a number has already been through somebody's coercion.
  assert.equal(certParam(12345678), null)
  assert.equal(certParam(null), null)
  assert.equal(certParam(undefined), null)
  assert.equal(certParam({ cert: '1' }), null)
})

test('the cert rides the path, last segment, however the gateway mounts us', () => {
  assert.equal(certFromPath('/psa-proxy/09472817'), '09472817')
  assert.equal(certFromPath('/functions/v1/psa-proxy/123'), '123')
  assert.equal(certFromPath('/psa-proxy/123/'), '123')
  // No cert at all — the function's own name is not digits.
  assert.equal(certFromPath('/psa-proxy'), null)
  assert.equal(certFromPath('/'), null)
  assert.equal(certFromPath(''), null)
  // Percent-escapes stay undecoded: encodeURIComponent never escapes a digit,
  // so an escaped "cert" is by definition not something our client sent.
  assert.equal(certFromPath('/psa-proxy/%31%32'), null)
})

test('a record naming the card is found, whatever the casing or wrapper', () => {
  assert.equal(certFound({ PSACert: { Subject: 'KEN GRIFFEY JR.' } }), true)
  assert.equal(certFound({ psaCert: { brand: 'UPPER DECK' } }), true)
  // Unwrapped bodies read the same — psa.ts tolerates both, so must this.
  assert.equal(certFound({ cardGrade: '10' }), true)
  // A grade spelled only in words still counts as an answer.
  assert.equal(certFound({ PSACert: { GradeDescription: 'GEM MT 10' } }), true)
})

test('an echo of the question is not an answer', () => {
  // PSA answering 200 with nothing but the cert number back is "no record" —
  // cached briefly, so a freshly graded slab is not frozen out for a month.
  assert.equal(certFound({ PSACert: { CertNumber: '09472817' } }), false)
  assert.equal(certFound({ PSACert: { Subject: '' } }), false)
  assert.equal(certFound({}), false)
  assert.equal(certFound(null), false)
  assert.equal(certFound('nope'), false)
  assert.equal(certFound([]), false)
})

test('the cert cap is wide enough for real certs and no wider', () => {
  // 8-9 digits today; 12 is headroom, not an invitation.
  assert.equal(MAX_CERT_DIGITS, 12)
})
