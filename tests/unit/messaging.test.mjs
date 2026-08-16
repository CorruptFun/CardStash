/**
 * Messages: what a server row is allowed to become on somebody's screen.
 *
 * A message is the one place in this app where a stranger's free text reaches
 * another user, and the row carrying it comes back over HTTP like any other —
 * so it goes through a sanitizer, exactly as a pasted link does (decision 7).
 * These pin the parts that would fail silently: a body is a bounded string, a
 * malformed row is dropped rather than half-rendered, and the attached card
 * goes through `sanitizeSharedCard` — the SAME door a `#/x?d=…` link uses —
 * so a message cannot smuggle in a card shape a share link could not.
 *
 * The last test is about analytics rather than rendering, and it is here
 * because it is the easy thing to break: a handle is identity (decision 20),
 * and an event that carried who was messaged would be exactly the tie between
 * a person and a counter that the content-free rule exists to prevent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STUB = join(HERE, 'stubs', 'messaging-host.mjs')

const { MESSAGE_MAX_CHARS, sanitizeMessage, sanitizeThread, sendMessage } = await bundleImport('src/lib/messaging.ts', {
  alias: {
    './analytics': STUB,
    './authsession': STUB,
    './cloudconfig': STUB,
    './settings': STUB,
  },
})

const row = (over = {}) => ({
  id: 7,
  thread_id: 3,
  sender: '11111111-1111-1111-1111-111111111111',
  body: 'Is the Lotus still available?',
  created_at: '2026-08-16T10:00:00Z',
  ...over,
})

test('an ordinary message survives intact', () => {
  const message = sanitizeMessage(row())
  assert.equal(message.id, 7)
  assert.equal(message.threadId, 3)
  assert.equal(message.body, 'Is the Lotus still available?')
  assert.equal(message.about, undefined)
  assert.equal(message.at, Date.parse('2026-08-16T10:00:00Z'))
})

test('a row missing anything it is rendered by is dropped, not half-rendered', () => {
  assert.equal(sanitizeMessage(null), null)
  assert.equal(sanitizeMessage('a string'), null)
  assert.equal(sanitizeMessage(row({ id: 0 })), null)
  assert.equal(sanitizeMessage(row({ thread_id: null })), null)
  assert.equal(sanitizeMessage(row({ sender: '' })), null)
  assert.equal(sanitizeMessage(row({ body: '   ' })), null)
})

test('a body is bounded at the length the column is', () => {
  const long = sanitizeMessage(row({ body: 'x'.repeat(MESSAGE_MAX_CHARS + 500) }))
  assert.equal(long.body.length, MESSAGE_MAX_CHARS)
})

test('an unparseable timestamp becomes now rather than 1970', () => {
  const message = sanitizeMessage(row({ created_at: 'whenever' }))
  assert.ok(message.at > Date.parse('2020-01-01'), message.at)
})

test('THE ATTACHED CARD GOES THROUGH THE SHARE-LINK SANITIZER', () => {
  const message = sanitizeMessage(
    row({
      about: {
        cardId: 'mtg:abc',
        name: 'Black Lotus',
        finish: 'nonfoil',
        condition: 'NM',
        qty: 3,
        forTrade: 99,
        // A data URL is somebody's own photograph and must never travel; the
        // shared sanitizer drops anything that is not https, and this is that
        // same sanitizer rather than a second one that forgot.
        image: 'data:image/png;base64,AAAA',
        price: -5,
      },
    }),
  )
  assert.equal(message.about.cardId, 'mtg:abc')
  assert.equal(message.about.game, 'mtg')
  assert.equal(message.about.image, undefined)
  assert.equal(message.about.forTrade, 3, 'forTrade clamps to qty')
  assert.equal(message.about.price, undefined, 'a negative price is not a price')
})

test('an attachment that is not a card at all is simply absent', () => {
  assert.equal(sanitizeMessage(row({ about: { nonsense: true } })).about, undefined)
  assert.equal(sanitizeMessage(row({ about: 'mtg:abc' })).about, undefined)
})

test('a thread row needs an identity before it can be listed', () => {
  const thread = sanitizeThread({
    thread_id: 4,
    other_id: '22222222-2222-2222-2222-222222222222',
    handle: 'rae',
    display_name: 'Rae',
    last_at: '2026-08-16T10:00:00Z',
    last_preview: 'Yes — $12 shipped.',
    last_sender: '22222222-2222-2222-2222-222222222222',
    unread: 2,
  })
  assert.equal(thread.id, 4)
  assert.equal(thread.handle, 'rae')
  assert.equal(thread.unread, 2)
  assert.equal(sanitizeThread({ thread_id: 4, other_id: 'x' }), null, 'no handle, not renderable')
  assert.equal(sanitizeThread({ other_id: 'x', handle: 'rae' }), null, 'no thread id, not openable')
})

test('a missing display name falls back to the handle rather than to blank', () => {
  const thread = sanitizeThread({ thread_id: 4, other_id: 'u', handle: 'rae', unread: 'lots' })
  assert.equal(thread.displayName, '@rae')
  assert.equal(thread.unread, 0, 'a non-numeric count is zero, never NaN in a badge')
})

test('SENDING TELLS THE LOG NOTHING ABOUT WHO OR WHAT', async () => {
  const calls = []
  globalThis.__events = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, text: async () => '12' }
  }
  const threadId = await sendMessage('22222222-2222-2222-2222-222222222222', '  Is it still available?  ', {
    cardId: 'mtg:abc',
    game: 'mtg',
    name: 'Black Lotus',
    finish: 'nonfoil',
    condition: 'NM',
    qty: 1,
    forTrade: 1,
  })
  assert.equal(threadId, 12)
  assert.equal(calls[0].body.p_body, 'Is it still available?', 'the body is trimmed before it is sent')

  const [event] = globalThis.__events
  assert.equal(event.name, 'message_sent')
  // Whether a card was attached, and nothing else. A recipient id or a handle
  // here would tie a person to a counter, which is the one thing decision 20
  // says this log must never do; a card name would break the content-free rule.
  assert.deepEqual(Object.keys(event.data), ['about'])
  assert.equal(event.data.about, true)
  const serialized = JSON.stringify(event.data)
  assert.ok(!serialized.includes('2222'), serialized)
  assert.ok(!serialized.includes('Lotus'), serialized)
})
