/**
 * The social accounts a collector chooses to show alongside their binder.
 *
 * WHY THIS IS NOT ON THE PROFILE ROW. `profiles` (migration 0001) is readable
 * by every signed-in user, and it carries identity ONLY — the comment at the
 * top of that migration says so, about the contact blurb, in as many words.
 * A list of the places someone can be reached is the same class of fact as
 * "DM @rae on Discord", so it rides the same rail: it is part of the
 * `ProfilePayload`, which means it inherits the visibility rule for free (a
 * `trade` binder is readable by any signed-in collector, an `all` binder only
 * by accepted friends) and travels in a `#/x?d=…` link with no account at all.
 * Moving it onto `profiles` later would silently widen its audience to every
 * stranger in the directory — don't.
 *
 * WHY A CLOSED VOCABULARY AND A TEMPLATE, NOT A URL. Every one of these ends
 * up as an `<a href>` in someone else's app, rendered from a document that
 * arrived over the wire from a person the reader may never have met. A stored
 * URL is a stored redirect: the icon says Instagram and the href says whatever
 * the sender typed. So a handle-kind link stores the HANDLE and this module
 * builds the URL, which makes "the icon matches the destination" a property of
 * the code rather than a promise about the data. `website` is the one kind
 * that genuinely needs a URL, it is the only one that renders as a neutral
 * globe, and it is `https:` only.
 *
 * Pure — no DOM, no network, no settings. `social.ts` is still the sanitizer
 * door for anything decoded from outside (decision 7); it calls in here.
 */

import type { SocialLink, SocialPlatform } from './types'

export type { SocialLink, SocialPlatform }

interface PlatformSpec {
  label: string
  /** What the field is asking for, in the words the platform itself uses. */
  placeholder: string
  /**
   * `https://…{handle}` — absent for a platform with no public profile page.
   * Discord is the only one today: there is no URL for a username, and
   * inventing `discord.com/users/<name>` would produce a 404 for everyone.
   */
  url?: (handle: string) => string
  /** Characters this platform's names can contain, anchored. */
  pattern: RegExp
  max: number
}

/**
 * Handles are lower-cased where the platform is case-insensitive and left
 * alone where it is not (Discord display names, YouTube's `@Handle`), because
 * a handle is retyped by a human reading it off a screen and mangling the case
 * of one that needs it produces a dead link that looks fine.
 */
const SPECS: Record<SocialPlatform, PlatformSpec> = {
  instagram: {
    label: 'Instagram',
    placeholder: 'username',
    url: (h) => `https://instagram.com/${h}`,
    pattern: /^[A-Za-z0-9._]+$/,
    max: 30,
  },
  x: {
    label: 'X',
    placeholder: 'username',
    url: (h) => `https://x.com/${h}`,
    pattern: /^[A-Za-z0-9_]+$/,
    max: 15,
  },
  bluesky: {
    // Bluesky handles ARE domains (`rae.bsky.social`), so dots are legal and
    // load-bearing here in a way they are not on X.
    label: 'Bluesky',
    placeholder: 'you.bsky.social',
    url: (h) => `https://bsky.app/profile/${h}`,
    pattern: /^[A-Za-z0-9.-]+$/,
    max: 60,
  },
  youtube: {
    label: 'YouTube',
    placeholder: 'channelhandle',
    url: (h) => `https://youtube.com/@${h}`,
    pattern: /^[A-Za-z0-9._-]+$/,
    max: 30,
  },
  tiktok: {
    label: 'TikTok',
    placeholder: 'username',
    url: (h) => `https://tiktok.com/@${h}`,
    pattern: /^[A-Za-z0-9._]+$/,
    max: 24,
  },
  twitch: {
    label: 'Twitch',
    placeholder: 'username',
    url: (h) => `https://twitch.tv/${h}`,
    pattern: /^[A-Za-z0-9_]+$/,
    max: 25,
  },
  discord: {
    label: 'Discord',
    placeholder: 'username',
    pattern: /^[A-Za-z0-9._#]+$/,
    max: 37,
  },
  reddit: {
    label: 'Reddit',
    placeholder: 'username',
    url: (h) => `https://reddit.com/user/${h}`,
    pattern: /^[A-Za-z0-9._-]+$/,
    max: 20,
  },
  facebook: {
    label: 'Facebook',
    placeholder: 'username',
    url: (h) => `https://facebook.com/${h}`,
    pattern: /^[A-Za-z0-9.]+$/,
    max: 50,
  },
  telegram: {
    label: 'Telegram',
    placeholder: 'username',
    url: (h) => `https://t.me/${h}`,
    pattern: /^[A-Za-z0-9_]+$/,
    max: 32,
  },
  whatnot: {
    label: 'Whatnot',
    placeholder: 'username',
    url: (h) => `https://whatnot.com/user/${h}`,
    pattern: /^[A-Za-z0-9._-]+$/,
    max: 30,
  },
  ebay: {
    label: 'eBay',
    placeholder: 'seller id',
    url: (h) => `https://ebay.com/usr/${h}`,
    pattern: /^[A-Za-z0-9._-]+$/,
    max: 30,
  },
  website: {
    label: 'Website',
    placeholder: 'https://…',
    // The value IS the URL for this one, so the template is identity and
    // `socialLinkUrl` short-circuits before it. Validation is
    // `sanitizeLinkValue`'s job; this pattern only guards the obviously absurd.
    url: (h) => h,
    pattern: /^https:\/\/\S+$/,
    max: 200,
  },
}

/** Render order, and the order the picker offers them in. */
export const SOCIAL_PLATFORMS = Object.keys(SPECS) as SocialPlatform[]

/** At most this many per profile: a link row, not a directory listing. */
export const MAX_PROFILE_LINKS = 8

export const platformLabel = (platform: SocialPlatform): string => SPECS[platform]?.label ?? platform
export const platformPlaceholder = (platform: SocialPlatform): string => SPECS[platform]?.placeholder ?? ''
export const isPlatform = (value: unknown): value is SocialPlatform =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SPECS, value)

/**
 * A platform whose value cannot be opened — it is copied instead.
 *
 * Worth a named helper rather than a `!url` check at three call sites: the UI
 * has to render a button instead of an anchor, and the difference is a real
 * one about the platform, not an accident of the table.
 */
export const isCopyOnly = (platform: SocialPlatform): boolean => !SPECS[platform]?.url

/**
 * Clean one value as typed: strip the decorations people paste in.
 *
 * Someone copying their profile hands over `@rae`, `instagram.com/rae`, or the
 * whole `https://www.instagram.com/rae/?hl=en`. All three mean the same
 * collector, and refusing two of them teaches people the field is fussy rather
 * than teaching them the format. Returns '' when nothing usable is left.
 */
export function sanitizeLinkValue(platform: SocialPlatform, raw: string): string {
  const spec = SPECS[platform]
  if (!spec) return ''
  let value = String(raw ?? '').trim()
  if (!value) return ''

  if (platform === 'website') {
    // A bare host is the overwhelmingly common way people write a website;
    // upgrading it to https is not a guess about their intent, it is the only
    // scheme this app will render at all.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`
    if (!/^https:\/\//i.test(value)) return ''
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      return ''
    }
    // A host with no dot is a LAN name or a typo, and `https://localhost` on
    // a stranger's binder is not a website.
    if (!parsed.hostname.includes('.')) return ''
    return parsed.toString().slice(0, spec.max)
  }

  // Drop a pasted profile URL down to its last meaningful path segment, then
  // the @ and any trailing slash. Query strings and `www.` go with it.
  if (/^https?:\/\//i.test(value) || /^[a-z0-9-]+\.[a-z]{2,}\//i.test(value)) {
    const withoutQuery = value.split(/[?#]/)[0]
    const segments = withoutQuery.replace(/\/+$/, '').split('/')
    value = segments[segments.length - 1] ?? ''
    // `reddit.com/user/rae` and `bsky.app/profile/rae.bsky.social` both end on
    // the name; `t.me/rae` does too. A URL that ends on a section rather than
    // a person ("instagram.com/") has already become '' above.
  }
  // Internal whitespace is not stripped, it is refused: "rae evil" is a typo,
  // and gluing it into "raeevil" invents a handle nobody owns and links to it.
  value = value.replace(/^@+/, '').slice(0, spec.max)
  if (!value || !spec.pattern.test(value)) return ''
  return value
}

/** One link as stored/wired, or null if it is not one. */
export function sanitizeSocialLink(raw: unknown): SocialLink | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const platform = record.platform
  if (!isPlatform(platform)) return null
  const value = typeof record.value === 'string' ? sanitizeLinkValue(platform, record.value) : ''
  return value ? { platform, value } : null
}

/**
 * A whole link list, deduped and capped.
 *
 * One row per platform: two Instagram accounts on one profile is a mistake far
 * more often than it is a choice, and the first one wins so a re-share never
 * reorders what a friend already saw.
 */
export function sanitizeSocialLinks(raw: unknown): SocialLink[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<SocialPlatform>()
  const links: SocialLink[] = []
  for (const entry of raw) {
    if (links.length >= MAX_PROFILE_LINKS) break
    const link = sanitizeSocialLink(entry)
    if (!link || seen.has(link.platform)) continue
    seen.add(link.platform)
    links.push(link)
  }
  return links.length ? links : undefined
}

/**
 * Where a link points, or undefined for a copy-only platform.
 *
 * Built from the template every time rather than stored, which is the whole
 * safety property: a payload cannot smuggle a destination past the icon, and
 * fixing a platform that changes its URL shape is a one-line edit here rather
 * than a migration over everyone's stored links.
 */
export function socialLinkUrl(link: SocialLink): string | undefined {
  const spec = SPECS[link.platform]
  if (!spec?.url) return undefined
  if (link.platform === 'website') return link.value
  return spec.url(encodeURIComponent(link.value))
}

/** "Instagram · @rae" — the accessible name and the tooltip. */
export function socialLinkLabel(link: SocialLink): string {
  const label = platformLabel(link.platform)
  if (link.platform === 'website') return `${label} · ${link.value.replace(/^https:\/\//, '').replace(/\/$/, '')}`
  return `${label} · @${link.value}`
}
