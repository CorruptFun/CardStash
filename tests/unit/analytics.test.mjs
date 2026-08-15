/**
 * The analytics contract, held to by test: events carry counts, never
 * content. Everything here is a pure rule out of analytics.ts — the redactor
 * every track() call passes through, the hash that lets failing cards be
 * grouped without naming them, and the aggregators the diagnostics screen
 * and the ingest both read.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'stubs', 'analytics-host.mjs')

const {
  EVENT_TYPES,
  redact,
  hashToken,
  sizeBucket,
  amountBucket,
  describeDevice,
  failureStats,
  usageStats,
} = await bundleImport('src/lib/analytics.ts', { alias: { dexie: STUB, './settings': STUB } })

const IOS_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const WIN_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

test('redaction keeps counts and drops anything that could carry content', () => {
  assert.deepEqual(
    redact({
      name: 'Black Lotus',
      query: 'charizard',
      apiKey: 'sk-live-123',
      url: 'https://example.test/x',
      email: 'a@b.test',
      game: 'mtg',
      ms: 12.345,
      ok: true,
    }),
    { game: 'mtg', ms: 12.35, ok: true },
  )
})

test('a value that reads like prose is dropped even under an allowed key', () => {
  assert.deepEqual(redact({ stage: 'no-match' }), { stage: 'no-match' })
  // Spaces and punctuation are exactly how a card name or an error message
  // would arrive if one ever leaked into a call site.
  assert.deepEqual(redact({ stage: 'Could not read Black Lotus' }), {})
  assert.deepEqual(redact({ stage: 'x'.repeat(33) }), {})
  // Unknown-shaped keys never make it either, whatever they hold.
  assert.deepEqual(redact({ Screen: 'scan', _internal: 'scan' }), {})
})

test('hashToken groups one card and separates two, without carrying the name', () => {
  assert.match(hashToken('Black Lotus'), /^[0-9a-f]{8}$/)
  assert.equal(hashToken('Charizard ex'), hashToken('  charizard   EX '))
  assert.equal(hashToken('Charizard ex'), hashToken('Charizard-ex'))
  assert.notEqual(hashToken('Charizard ex'), hashToken('Charizard'))
  // Accents fold, so a localized read lands in the same bucket as the EN one
  // it resolves to.
  assert.equal(hashToken('Dracaufeu'), hashToken('Drácaufeu'))
  assert.equal(hashToken('   '), '')
})

test('collection sizes leave as buckets, never as counts', () => {
  assert.equal(sizeBucket(0), '0')
  assert.equal(sizeBucket(1), '1-9')
  assert.equal(sizeBucket(9), '1-9')
  assert.equal(sizeBucket(10), '10-49')
  assert.equal(sizeBucket(4999), '1k-5k')
  assert.equal(sizeBucket(5000), '5k-up')
  assert.equal(sizeBucket(Number.NaN), '0')
})

test('a postal address is dropped even though none of it looks like content', () => {
  // Every one of these satisfies SAFE_STRING, so the string rule would have
  // passed them all. Only the forbidden list stops them, which is why it has
  // to name them explicitly rather than rely on the shape of the value.
  assert.deepEqual(
    redact({
      line1: '38-Oak-St',
      city: 'Austin',
      state: 'TX',
      zip: '94110',
      postcode: 'SW1A-1AA',
      country: 'US',
      phone: '5551234567',
      recipient: 'rae',
      tracking: '9400111899223',
      game: 'mtg',
    }),
    { game: 'mtg' },
  )
})

test('an exact money figure is dropped; a bucket is how value travels', () => {
  assert.deepEqual(redact({ amount: 42.5, price: 12, total: 99, fee: 1.5, payout: 40, ok: true }), { ok: true })
  // The supported route. Numbers are fine as counts — it is the naming of a
  // figure as somebody's money that the contract refuses.
  assert.deepEqual(redact({ band: amountBucket(42.5), cards: 3 }), { band: '25-50', cards: 3 })
})

test('order values leave as buckets, and the labels survive SAFE_STRING', () => {
  assert.equal(amountBucket(0), '0')
  assert.equal(amountBucket(4.99), 'u5')
  assert.equal(amountBucket(5), '5-10')
  assert.equal(amountBucket(249.99), '100-250')
  assert.equal(amountBucket(250), '250-up')
  assert.equal(amountBucket(Number.NaN), '0')
  assert.equal(amountBucket(-3), '0')
  // A label that redact() would drop is a metric that silently disappears —
  // no '$', no '+', nothing outside the allowed character class.
  for (const usd of [0, 3, 7, 20, 40, 80, 150, 900]) {
    const band = amountBucket(usd)
    assert.deepEqual(redact({ band }), { band }, `bucket ${band} must survive redaction`)
  }
})

test('device shape reads platform and browser off the user agent', () => {
  const ios = describeDevice({ userAgent: IOS_SAFARI, language: 'en-GB' }, {})
  assert.equal(ios.platform, 'ios')
  assert.equal(ios.browser, 'safari')
  assert.equal(ios.lang, 'en-GB')
  // Android's UA also says "Linux", and Chrome's also says "Safari".
  const android = describeDevice({ userAgent: ANDROID_CHROME }, {})
  assert.equal(android.platform, 'android')
  assert.equal(android.browser, 'chrome')
  // Edge's UA says "Chrome" too — the impostor has to lose.
  const edge = describeDevice({ userAgent: WIN_EDGE }, {})
  assert.equal(edge.platform, 'windows')
  assert.equal(edge.browser, 'edge')
  assert.deepEqual(describeDevice({}, {}).platform, 'other')
})

test('an installed copy is recognised from either signal', () => {
  assert.equal(describeDevice({ standalone: true }, {}).standalone, true)
  assert.equal(describeDevice({}, { matchMedia: () => ({ matches: true }) }).standalone, true)
  assert.equal(describeDevice({}, { matchMedia: () => ({ matches: false }) }).standalone, false)
  assert.equal(describeDevice({}, {}).standalone, false)
})

test('a language tag survives, anything else in the field does not', () => {
  assert.equal(describeDevice({ language: 'pt-BR' }, {}).lang, 'pt-BR')
  assert.equal(describeDevice({ language: '' }, {}).lang, 'unknown')
  // Bounded first, then stripped to letters and hyphens — whatever arrives in
  // the field, what leaves is tag-shaped and short.
  const junk = describeDevice({ language: 'en-US; drop table' }, {}).lang
  assert.equal(junk, 'en-USdrop')
  assert.match(junk, /^[A-Za-z-]{1,12}$/)
})

const failure = (data) => ({ t: 'scan_failure', at: 0, data })

test('failures rank the cards that keep failing, by hash', () => {
  const stats = failureStats([
    failure({ stage: 'no-match', game: 'pokemon', card: 'aaaa1111' }),
    failure({ stage: 'no-match', game: 'pokemon', card: 'aaaa1111' }),
    failure({ stage: 'no-match', game: 'mtg', card: 'bbbb2222' }),
    // Read nothing at all: it still counts as a failure, but there is no card
    // to blame it on.
    failure({ stage: 'no-text', game: 'mtg' }),
    { t: 'scan_attempt', at: 0, data: { outcome: 'hit' } },
  ])
  assert.equal(stats.total, 4)
  assert.deepEqual(stats.byStage, { 'no-match': 3, 'no-text': 1 })
  assert.deepEqual(stats.byGame, { pokemon: 2, mtg: 2 })
  assert.deepEqual(stats.cards, [
    { card: 'aaaa1111', game: 'pokemon', n: 2 },
    { card: 'bbbb2222', game: 'mtg', n: 1 },
  ])
})

test('the failing-card list is capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => failure({ stage: 'no-match', game: 'mtg', card: `c${i}` }))
  assert.equal(failureStats(many).cards.length, 8)
  assert.equal(failureStats(many, 3).cards.length, 3)
})

test('usage counts visits, screens, platforms and installed copies', () => {
  const stats = usageStats([
    { t: 'app_open', at: 0, data: { platform: 'ios', standalone: true } },
    { t: 'app_open', at: 0, data: { platform: 'android', standalone: false } },
    { t: 'screen_view', at: 0, data: { screen: 'scan' } },
    { t: 'screen_view', at: 0, data: { screen: 'scan' } },
    { t: 'screen_view', at: 0, data: { screen: 'collection' } },
    { t: 'session_end', at: 0, data: { secs: 30 } },
    { t: 'session_end', at: 0, data: { secs: 90 } },
  ])
  assert.equal(stats.sessions, 2)
  assert.equal(stats.installs, 1)
  assert.deepEqual(stats.platforms, { ios: 1, android: 1 })
  assert.deepEqual(stats.screens, { scan: 2, collection: 1 })
  assert.equal(stats.medianSecs, 30)
})

test('the event whitelist covers who, what and why-it-failed', () => {
  for (const name of ['app_open', 'session_end', 'screen_view', 'scan_attempt', 'scan_failure', 'error'])
    assert.ok(EVENT_TYPES.includes(name), `${name} missing from the whitelist`)
})
