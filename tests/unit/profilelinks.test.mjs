/**
 * Social profile links: the handle someone typed, and where the icon goes.
 *
 * The test that matters most is the dull one — **a stored link can never point
 * somewhere its icon does not claim**. Every handle-kind link stores a HANDLE
 * and the URL is rebuilt from a table here, so a payload that arrives over the
 * wire carrying `javascript:` or a lookalike domain cannot become an `<a href>`
 * under an Instagram glyph in somebody else's app. That property is one
 * `sanitizeLinkValue` regression away from being untrue, and nothing on screen
 * would show it.
 *
 * The rest pins the forgiving half: people paste `@rae`, they paste the whole
 * profile URL, and both mean the same collector.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleImport } from './bundle.mjs'

const {
  MAX_PROFILE_LINKS,
  SOCIAL_PLATFORMS,
  isCopyOnly,
  isPlatform,
  sanitizeLinkValue,
  sanitizeSocialLink,
  sanitizeSocialLinks,
  socialLinkLabel,
  socialLinkUrl,
} = await bundleImport('src/lib/profilelinks.ts')

test('a handle is taken as typed, with the decorations people paste stripped', () => {
  assert.equal(sanitizeLinkValue('instagram', 'rae'), 'rae')
  assert.equal(sanitizeLinkValue('instagram', '  @rae  '), 'rae')
  assert.equal(sanitizeLinkValue('instagram', 'https://www.instagram.com/rae/?hl=en'), 'rae')
  assert.equal(sanitizeLinkValue('x', 'https://x.com/rae'), 'rae')
  assert.equal(sanitizeLinkValue('reddit', 'https://reddit.com/user/rae'), 'rae')
  assert.equal(sanitizeLinkValue('telegram', 't.me/rae'), 'rae')
})

test('a bluesky handle keeps its dots, because it is a domain', () => {
  assert.equal(sanitizeLinkValue('bluesky', 'rae.bsky.social'), 'rae.bsky.social')
  assert.equal(sanitizeLinkValue('bluesky', 'https://bsky.app/profile/rae.bsky.social'), 'rae.bsky.social')
  // X does not allow them, so the same string is not a handle there.
  assert.equal(sanitizeLinkValue('x', 'rae.bsky.social'), '')
})

test('a handle that could change where the link goes is refused outright', () => {
  for (const hostile of [
    'rae/../../evil',
    'rae?next=evil.test',
    'rae#frag',
    'rae evil',
    '../admin',
    'javascript:alert(1)',
    '//evil.test',
  ]) {
    assert.equal(sanitizeLinkValue('instagram', hostile), '', hostile)
  }
})

test('a website must be https, and a scheme that is not gets no second chance', () => {
  assert.equal(sanitizeLinkValue('website', 'https://cards.example/rae'), 'https://cards.example/rae')
  // A bare host is the common way people write one; upgrading it is the only
  // scheme this app renders, not a guess about intent.
  assert.equal(sanitizeLinkValue('website', 'cards.example'), 'https://cards.example/')
  assert.equal(sanitizeLinkValue('website', 'http://cards.example'), '')
  assert.equal(sanitizeLinkValue('website', 'javascript:alert(1)'), '')
  assert.equal(sanitizeLinkValue('website', 'data:text/html,<script>'), '')
  assert.equal(sanitizeLinkValue('website', 'https://localhost'), '')
})

test('THE URL IS BUILT FROM THE PLATFORM, so the icon cannot lie', () => {
  assert.equal(socialLinkUrl({ platform: 'instagram', value: 'rae' }), 'https://instagram.com/rae')
  assert.equal(socialLinkUrl({ platform: 'youtube', value: 'rae' }), 'https://youtube.com/@rae')
  assert.equal(socialLinkUrl({ platform: 'whatnot', value: 'rae' }), 'https://whatnot.com/user/rae')
  // Even a value that somehow got past the sanitizer cannot escape its host.
  const smuggled = socialLinkUrl({ platform: 'instagram', value: '../../evil.test' })
  assert.ok(smuggled.startsWith('https://instagram.com/'), smuggled)
  assert.ok(!smuggled.includes('evil.test/'), smuggled)
})

test('discord has no profile page, and says so rather than inventing one', () => {
  assert.equal(isCopyOnly('discord'), true)
  assert.equal(socialLinkUrl({ platform: 'discord', value: 'rae' }), undefined)
  assert.equal(isCopyOnly('instagram'), false)
})

test('a link list is deduped, capped, and drops what it cannot use', () => {
  const links = sanitizeSocialLinks([
    { platform: 'instagram', value: '@rae' },
    { platform: 'instagram', value: 'someone_else' },
    { platform: 'nowhere', value: 'rae' },
    { platform: 'x', value: '' },
    { platform: 'discord', value: 'rae#1234' },
    'not an object',
    null,
  ])
  assert.deepEqual(links, [
    { platform: 'instagram', value: 'rae' },
    { platform: 'discord', value: 'rae#1234' },
  ])
  assert.equal(sanitizeSocialLinks('nope'), undefined)
  assert.equal(sanitizeSocialLinks([]), undefined)
  const many = SOCIAL_PLATFORMS.map((platform) => ({ platform, value: 'rae' }))
  assert.equal(sanitizeSocialLinks(many).length, MAX_PROFILE_LINKS)
})

test('the vocabulary is closed, and every platform in it is renderable', () => {
  assert.equal(isPlatform('instagram'), true)
  assert.equal(isPlatform('myspace'), false)
  assert.equal(isPlatform(null), false)
  for (const platform of SOCIAL_PLATFORMS) {
    const value = platform === 'website' ? 'https://cards.example/' : 'rae'
    const link = sanitizeSocialLink({ platform, value })
    assert.ok(link, platform)
    assert.ok(socialLinkLabel(link).length > 0, platform)
    if (!isCopyOnly(platform)) assert.match(socialLinkUrl(link), /^https:\/\//, platform)
  }
})
