import { useState } from 'react'
import {
  MAX_PROFILE_LINKS,
  SOCIAL_PLATFORMS,
  isCopyOnly,
  platformLabel,
  platformPlaceholder,
  sanitizeLinkValue,
  socialLinkLabel,
  socialLinkUrl,
} from '../lib/profilelinks'
import { settings, useSettings } from '../lib/settings'
import type { SocialLink, SocialPlatform } from '../lib/types'
import { useUi } from '../store/ui'
import { Icon, type IconName } from './Icon'

/**
 * The social accounts a collector shows beside their binder: an editor for
 * mine, and a row of icons for theirs.
 *
 * The icon map lives here rather than in `profilelinks.ts` because that module
 * is pure and node-tested; knowing what an Instagram glyph is called is a fact
 * about this app's icon set, not about the platform.
 */
const ICONS: Record<SocialPlatform, IconName> = {
  instagram: 'brandInstagram',
  x: 'brandX',
  bluesky: 'brandBluesky',
  youtube: 'brandYoutube',
  tiktok: 'brandTiktok',
  twitch: 'brandTwitch',
  discord: 'brandDiscord',
  reddit: 'brandReddit',
  facebook: 'brandFacebook',
  telegram: 'brandTelegram',
  whatnot: 'brandWhatnot',
  ebay: 'brandEbay',
  website: 'globe',
}

/**
 * Someone else's links, as tappable icons.
 *
 * Every href is rebuilt from the platform by `socialLinkUrl` — the stored
 * value is a handle, never a destination — so an icon cannot be pointed
 * somewhere it does not claim to go. `rel` still carries `noopener
 * noreferrer nofollow`: these are user-published outbound links from a
 * document that arrived over the wire, which is exactly the case that rel is
 * for, and `nofollow` keeps a binder share from being an SEO instrument.
 *
 * Discord has no profile URL, so it renders as a copy button. Showing it as a
 * dead link would be worse than showing it as what it is: a username you paste
 * into another app.
 */
export function ProfileLinkIcons({ links, size = 16 }: { links?: SocialLink[]; size?: number }) {
  const toast = useUi((s) => s.toast)
  if (!links?.length) return null
  return (
    <span className="profilelinks">
      {links.map((link) => {
        const url = socialLinkUrl(link)
        const label = socialLinkLabel(link)
        if (!url) {
          return (
            <button
              key={link.platform}
              className="profilelinks__item"
              title={`${label} — tap to copy`}
              aria-label={`Copy ${label}`}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(link.value)
                  .then(() => toast(`Copied ${link.value}`, 'success'))
                  .catch(() => toast(link.value, 'info'))
              }}
            >
              <Icon name={ICONS[link.platform]} size={size} />
            </button>
          )
        }
        return (
          <a
            key={link.platform}
            className="profilelinks__item"
            href={url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={label}
            aria-label={label}
          >
            <Icon name={ICONS[link.platform]} size={size} />
          </a>
        )
      })}
    </span>
  )
}

/**
 * My own links, edited in place.
 *
 * Writes straight to settings on every keystroke rather than holding a draft:
 * everything else on the Friends screen does the same, the value is
 * re-sanitized both on the way into the payload and on the way out of storage,
 * and a draft that needs saving is a draft people lose.
 *
 * What it will NOT do is pretend these are private. They ride the binder, so
 * their audience is the binder's audience — the note under the field says
 * which one that currently is rather than describing it in the abstract.
 */
export function ProfileLinkEditor() {
  const config = useSettings()
  const links = config.profileLinks
  const [adding, setAdding] = useState<SocialPlatform | ''>('')

  const used = new Set(links.map((link) => link.platform))
  const free = SOCIAL_PLATFORMS.filter((platform) => !used.has(platform))
  const full = links.length >= MAX_PROFILE_LINKS

  const write = (next: SocialLink[]) => settings().set({ profileLinks: next })

  const add = (platform: SocialPlatform) => {
    if (!platform || used.has(platform) || full) return
    write([...links, { platform, value: '' }])
    setAdding('')
  }

  return (
    <div className="linkedit">
      {links.map((link, index) => {
        // Sanitizing the value as it is typed would eat the character someone
        // is halfway through; this only asks whether what is there NOW would
        // survive the trip, so the row can say so before the share goes out.
        const clean = sanitizeLinkValue(link.platform, link.value)
        const bad = link.value.trim().length > 0 && !clean
        return (
          <div className="linkedit__row" key={link.platform}>
            <span className="linkedit__icon" title={platformLabel(link.platform)}>
              <Icon name={ICONS[link.platform]} size={16} />
            </span>
            <input
              className={`input linkedit__input ${bad ? 'input--bad' : ''}`}
              type="text"
              value={link.value}
              onChange={(event) => {
                const next = [...links]
                next[index] = { platform: link.platform, value: event.target.value }
                write(next)
              }}
              onBlur={(event) => {
                // Tidy on the way out, not on the way in: `@rae`, a pasted
                // profile URL and a bare name all become the same handle, and
                // seeing that happen is how someone learns the field is
                // forgiving rather than fussy.
                const tidy = sanitizeLinkValue(link.platform, event.target.value)
                if (!tidy || tidy === link.value) return
                const next = [...links]
                next[index] = { platform: link.platform, value: tidy }
                write(next)
              }}
              placeholder={platformPlaceholder(link.platform)}
              maxLength={200}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label={platformLabel(link.platform)}
            />
            <button
              className="linkedit__x"
              aria-label={`Remove ${platformLabel(link.platform)}`}
              onClick={() => write(links.filter((_, i) => i !== index))}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        )
      })}
      {!full && free.length > 0 && (
        <select
          className="select select--slim"
          value={adding}
          onChange={(event) => add(event.target.value as SocialPlatform)}
          aria-label="Add a social profile"
        >
          <option value="">Add a profile…</option>
          {free.map((platform) => (
            <option key={platform} value={platform}>
              {platformLabel(platform)}
              {isCopyOnly(platform) ? ' (username only)' : ''}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
