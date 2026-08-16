/**
 * Referrals: reading one off a link, banking it, and spending it.
 *
 * The two tests that matter most are the least exciting. **A collector with no
 * handle must get byte-identical share links** — that is the serverless default
 * the whole product rests on, and it must not acquire an account-shaped
 * dependency by accident. And **a share payload must never be mistaken for a
 * referral, nor a referral for a payload**: the two ride the same URL, one in
 * the query string and one in the fragment, and the day they are confused is
 * the day a binder link stops importing.
 *
 * The rest pins the round trip that made this feature necessary: the referral
 * arrives before there is an account to attach it to, so it is stored, and a
 * stored thing has rules — the first link wins, the server is asked once, and
 * being offline is a retry rather than an answer.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'
import { SETTINGS_DEFAULTS } from './stubs/referral-host.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'stubs', 'referral-host.mjs')
const DORMANT = join(HERE, 'stubs', 'referral-nocloud.mjs')
const hosts = (stub) => ({ './authsession': stub, './cloudconfig': stub, './settings': stub })

const {
  REFERRAL_PARAM,
  captureReferral,
  foundingOffer,
  normalizeReferral,
  redeemReferral,
  referralFromUrl,
  referralQuery,
} = await bundleImport('src/lib/referral.ts', { alias: hosts(STUB) })

const dormant = await bundleImport('src/lib/referral.ts', { alias: hosts(DORMANT) })

const { decodeShareText, encodeBlob, shareUrl } = await bundleImport('src/lib/social.ts', { alias: hosts(STUB) })

/** Fresh settings + a signed-in account before every test that touches either. */
function reset(over = {}) {
  globalThis.__settings = { ...SETTINGS_DEFAULTS, ...over }
  globalThis.__signedIn = true
  return globalThis.__settings
}

/** Record every request and answer it with `replies` in order. */
function fakeFetch(...replies) {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), ...init })
    const reply = replies.shift() ?? { ok: true, body: null }
    if (reply instanceof Error) throw reply
    return {
      ok: reply.ok !== false,
      status: reply.ok === false ? 500 : 200,
      json: async () => reply.body,
    }
  }
  return sent
}

// ------------------------------------------------------------ what is a code

test('a handle is normalized the way the server will normalize it', () => {
  assert.equal(normalizeReferral('@Rae'), 'rae')
  assert.equal(normalizeReferral('  RAE_99  '), 'rae_99')
  // Punctuation a chat app or a shell may have glued on, stripped rather than
  // stored — the stored value is posted straight back as `p_handle`.
  assert.equal(normalizeReferral('rae!'), 'rae')
  assert.equal(normalizeReferral('rae%20'), 'rae20')
})

test('anything that could not be a handle is not stored as one', () => {
  // 3–24 is the server's own bound (`bad_handle`); outside it there is nothing
  // to claim and storing it only defers the refusal.
  for (const junk of ['', null, undefined, 'ra', '@@', 'x'.repeat(25), '!!!!']) {
    assert.equal(normalizeReferral(junk), '', `${junk} must not become a code`)
  }
})

// ------------------------------------------------------------ reading a link

test('the code is read off the query string', () => {
  assert.equal(referralFromUrl('?via=rae', ''), 'rae')
  assert.equal(referralFromUrl(`?${REFERRAL_PARAM}=Rae&other=1`, ''), 'rae')
  assert.equal(referralFromUrl('', ''), '')
  assert.equal(referralFromUrl('?other=1', '#/collection'), '')
})

test('a code written into the fragment is read too', () => {
  // Not how links are built, but hand-edited and chat-mangled ones exist and
  // cost three lines to honour.
  assert.equal(referralFromUrl('', '#/x?d=DabcDEF&via=rae'), 'rae')
})

test('a share payload is never mistaken for a code', () => {
  // The blob alphabet is base64url, which holds neither `?` nor `&`, so `via=`
  // inside one can never begin a parameter.
  assert.equal(referralFromUrl('', '#/x?d=Dvia-rae_qqqvia=nope'), '')
  assert.equal(referralFromUrl('?d=Dsomeblob', ''), '')
})

// ----------------------------------------------------------- building a link

test('a collector WITHOUT a handle shares exactly the URL they always did', () => {
  reset()
  globalThis.location = { origin: 'https://cards.test', pathname: '/app/' }
  assert.equal(referralQuery(''), '')
  assert.equal(shareUrl('Dblob'), 'https://cards.test/app/#/x?d=Dblob')
})

test('a collector with a handle carries their code AHEAD of the payload', () => {
  reset({ socialHandle: 'rae' })
  globalThis.location = { origin: 'https://cards.test', pathname: '/app/' }
  assert.equal(shareUrl('Dblob'), 'https://cards.test/app/?via=rae#/x?d=Dblob')
})

test('and the link still imports — the payload survives the referral', async () => {
  reset({ socialHandle: 'rae' })
  globalThis.location = { origin: 'https://cards.test', pathname: '/app/' }
  const url = shareUrl(await encodeBlob({ kind: 'profile', id: 'p1', name: 'Rae', scope: 'trade', at: 0, cards: [] }))
  const decoded = await decodeShareText(url)
  assert.equal(decoded.kind, 'profile')
  assert.equal(decoded.name, 'Rae')
  // Both halves readable from the one string, neither eating the other.
  assert.equal(referralFromUrl('?via=rae', url.slice(url.indexOf('#'))), 'rae')
})

// --------------------------------------------------------------- banking one

test('the first link wins, and nothing later overwrites it', () => {
  reset()
  assert.equal(captureReferral('?via=rae', ''), 'rae')
  assert.equal(globalThis.__settings.referralFrom, 'rae')
  // `claim_referral()` records one referrer per account for ever, so a second
  // link must not leave the app crediting someone the server does not.
  assert.equal(captureReferral('?via=mo', ''), 'rae')
  assert.equal(globalThis.__settings.referralFrom, 'rae')
})

test('junk in the parameter is not banked', () => {
  reset()
  assert.equal(captureReferral('?via=x', ''), '')
  assert.equal(globalThis.__settings.referralFrom, '')
})

// ----------------------------------------------------------------- dormancy

test('with no cloud configured nothing is captured and nothing is sent', async () => {
  reset({ referralFrom: 'rae' })
  const sent = fakeFetch()
  assert.equal(dormant.captureReferral('?via=rae', ''), '')
  await dormant.redeemReferral()
  assert.equal(await dormant.foundingOffer(), null)
  assert.equal(sent.length, 0, 'a build with no project must contact nothing')
  assert.equal(globalThis.__settings.referralAt, 0)
})

// -------------------------------------------------------------- redeeming it

test('claim_referral is sent once, with the banked handle', async () => {
  reset({ referralFrom: 'rae' })
  const sent = fakeFetch({ body: true })
  await redeemReferral()
  assert.equal(sent.length, 1)
  assert.match(sent[0].url, /\/rest\/v1\/rpc\/claim_referral$/)
  assert.equal(JSON.parse(sent[0].body).p_handle, 'rae')
  assert.equal(sent[0].headers.Authorization, 'Bearer stub-token')
  assert.ok(globalThis.__settings.referralAt > 0, 'an answered call must not be repeated')

  await redeemReferral()
  assert.equal(sent.length, 1, 'the second launch must not ask again')
})

test('a refusal is still an answer; only an unreachable server is retried', async () => {
  // `claim_referral()` returns FALSE rather than erroring when it declines, and
  // every reason it declines — already referred, self-referral, no such handle
  // — is permanent. Retrying those for ever would be a request per launch for
  // the life of the install.
  reset({ referralFrom: 'rae' })
  fakeFetch({ body: false })
  await redeemReferral()
  assert.ok(globalThis.__settings.referralAt > 0)

  reset({ referralFrom: 'rae' })
  fakeFetch({ ok: false })
  await redeemReferral()
  assert.equal(globalThis.__settings.referralAt, 0, 'a 500 must leave it pending')

  reset({ referralFrom: 'rae' })
  fakeFetch(new Error('offline'))
  await redeemReferral()
  assert.equal(globalThis.__settings.referralAt, 0, 'offline is not an answer')
})

test('nothing is sent when there is nothing to redeem, or nobody to redeem it', async () => {
  reset()
  let sent = fakeFetch()
  await redeemReferral()
  assert.equal(sent.length, 0, 'no referral banked')

  reset({ referralFrom: 'rae' })
  globalThis.__signedIn = false
  sent = fakeFetch()
  await redeemReferral()
  assert.equal(sent.length, 0, 'no account to attach it to yet')
})

// ---------------------------------------------------------------- the offer

test('the offer is the SERVER’s answer, not the settings key', async () => {
  // Read-own RLS on `referrals` means an account referred on another phone
  // still qualifies here, and a hand-edited settings key still buys nothing.
  reset()
  const sent = fakeFetch({ body: [{ user_id: 'u1' }] }, { body: 'founding' }, { body: 7 })
  assert.deepEqual(await foundingOffer(), { referred: true, seatsLeft: 7, tier: 'founding' })
  assert.match(sent[0].url, /\/rest\/v1\/referrals\?/)
  // The tier comes from the SAME function /checkout asks, so the price quoted
  // on screen is the price charged at the till.
  assert.match(sent[1].url, /\/rpc\/referral_tier$/)
  assert.match(sent[2].url, /\/rpc\/founding_seats_left$/)
})

test('an account nobody referred costs one request, not two', async () => {
  reset()
  const sent = fakeFetch({ body: [] })
  assert.deepEqual(await foundingOffer(), { referred: false, seatsLeft: 0, tier: 'standard' })
  // Nobody referred them, so their tier is 'standard' by definition and the
  // server would only agree. Most accounts take this branch.
  assert.equal(sent.length, 1, 'the seat count is nobody else’s business')
})

test('a nonsense seat count is clamped before it reaches a sentence', async () => {
  for (const [answer, expected] of [
    [-3, 0],
    [1e9, 100],
    ['lots', 0],
    [null, 0],
    [12.7, 12],
  ]) {
    reset()
    fakeFetch({ body: [{ user_id: 'u1' }] }, { body: 'founding' }, { body: answer })
    const offer = await foundingOffer()
    assert.equal(offer.seatsLeft, expected, `${answer} must render as ${expected}`)
  }
})

test('offline says nothing rather than withdrawing an offer the account holds', async () => {
  reset()
  fakeFetch(new Error('offline'))
  assert.equal(await foundingOffer(), null)

  reset()
  fakeFetch({ body: [{ user_id: 'u1' }] }, { body: 'founding' }, { ok: false })
  assert.equal(await foundingOffer(), null, 'half an answer is not an answer')

  reset()
  globalThis.__signedIn = false
  const sent = fakeFetch()
  assert.equal(await foundingOffer(), null)
  assert.equal(sent.length, 0)
})

test('a referred account with the seats gone is offered the middle price', async () => {
  // The tier the SQL reports is taken as given rather than re-derived from the
  // seat count: `referral_tier()` already weighs "referred" against "is a seat
  // free", and computing it a second time here is how the quote on this screen
  // and the price at the till come to disagree.
  reset()
  fakeFetch({ body: [{ user_id: 'u1' }] }, { body: 'referred' }, { body: 0 })
  assert.deepEqual(await foundingOffer(), { referred: true, seatsLeft: 0, tier: 'referred' })
})

test('an unrecognised tier falls back to standard, never to a discount', async () => {
  // A tier we do not understand must not be read as the cheapest one. Being
  // wrong towards full price is recoverable; being wrong towards a discount
  // means undercharging silently and finding out from the books.
  reset()
  fakeFetch({ body: [{ user_id: 'u1' }] }, { body: 'platinum' }, { body: 5 })
  assert.equal((await foundingOffer()).tier, 'standard')
})
