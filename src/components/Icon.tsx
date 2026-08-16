import type { JSX } from 'react'

/** Hand-drawn 24×24 stroke icon set — one visual family, no icon font. */

const BASE_STROKE = 1.55

function strokeWidth(size: number): number {
  return Math.min(2.4, Math.max(1.35, (BASE_STROKE * 24) / size))
}

const PATHS: Record<string, JSX.Element> = {
  scan: (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <rect x="8.2" y="6.8" width="7.6" height="10.4" rx="1.4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-3.8-3.8" />
    </>
  ),
  cards: (
    <>
      <rect x="3.5" y="6.5" width="10.5" height="14" rx="1.8" />
      <path d="M8.5 3.9 17 3a2 2 0 0 1 2.2 1.8l1 11.2" />
    </>
  ),
  /* The brand mark — ONE card, at the real 63:88 ratio, matching the launcher
     icon (`scripts/make-icons.mjs`). Deliberately not `cards`: that one is the
     Collection nav glyph and says "a stack of them", which is a different
     claim. Keep the two in step — if the icon's composition changes, this
     changes with it. */
  logo: (
    <>
      <rect x="6.2" y="3.9" width="11.6" height="16.2" rx="1.9" />
      <rect x="8.2" y="6" width="7.6" height="6.8" rx="1" />
    </>
  ),
  decks: (
    <>
      <path d="m12 3 9 4.7-9 4.7-9-4.7L12 3Z" />
      <path d="m3.6 12.3 8.4 4.4 8.4-4.4" />
      <path d="m3.6 16.5 8.4 4.4 8.4-4.4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17.5 7H20M4 17h4.5M13 17h7" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="10.5" cy="17" r="2.2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  chevronLeft: <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />,
  chevronRight: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  chevronDown: <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />,
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M19 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5" />
    </>
  ),
  flash: <path d="M13 2 5 13.5h5L10.5 22l8.5-11.5h-5.2L13 2Z" />,
  sparkle: (
    <>
      <path d="M12 3.5c.7 3.6 2.3 5.6 6.5 6.5-4.2 1.5-5.8 3.4-6.5 7.5-.7-4.1-2.3-6-6.5-7.5 4.2-.9 5.8-2.9 6.5-6.5Z" />
      <path d="M19 15.5c.3 1.7 1 2.6 2.8 3-1.8.7-2.5 1.5-2.8 3.4-.3-1.9-1-2.7-2.8-3.4 1.8-.4 2.5-1.3 2.8-3Z" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15M9.5 6V4.6A1.6 1.6 0 0 1 11.1 3h1.8a1.6 1.6 0 0 1 1.6 1.6V6" />
      <path d="M6.5 6.5 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12.5" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  pencil: <path d="M4 20l1-4.5L16.5 4a1.9 1.9 0 0 1 2.7 0l.8.8a1.9 1.9 0 0 1 0 2.7L8.5 19 4 20Z" />,
  download: (
    <>
      <path d="M12 4v11M7.5 11 12 15.5 16.5 11" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  refresh: (
    <>
      <path d="M4.5 12a7.5 7.5 0 0 1 13-5.2L20 9" />
      <path d="M20 4.5V9h-4.5" />
      <path d="M19.5 12a7.5 7.5 0 0 1-13 5.2L4 15" />
      <path d="M4 19.5V15h4.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <path d="M12 4 2.8 19.5h18.4L12 4Z" />
      <path d="M12 10v4.2M12 16.8v.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2.5" />
    </>
  ),
  sort: <path d="M7 5v14M7 19l-3-3M7 19l3-3M17 19V5M17 5l-3 3M17 5l3 3" />,
  tag: (
    <>
      <path d="M3.5 10.5v-6a1 1 0 0 1 1-1h6L20.5 13a1.5 1.5 0 0 1 0 2.1l-5.4 5.4a1.5 1.5 0 0 1-2.1 0L3.5 10.5Z" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5V5.7a2.2 2.2 0 0 0-2.2-2.2H5.7A2.2 2.2 0 0 0 3.5 5.7v7.6a2.2 2.2 0 0 0 2.2 2.2h2.8" />
    </>
  ),
  camera: (
    <>
      <path d="M3.5 8.5A2 2 0 0 1 5.5 6.5h2l1.6-2.3a1 1 0 0 1 .8-.4h4.2a1 1 0 0 1 .8.4L16.5 6.5h2a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V8.5Z" />
      <circle cx="12" cy="13" r="3.6" />
    </>
  ),
  cart: (
    <>
      <path d="M3.5 4.5h2.2l2.2 11.5h10.4l2.2-8.8H7" />
      <circle cx="9.2" cy="19.6" r="1.5" />
      <circle cx="16.6" cy="19.6" r="1.5" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 1 2.3 5.6" />
      <path d="M4 13v-4h4" />
      <path d="M12 8.5V12l2.8 2" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6.8" height="6.8" rx="1.4" />
      <rect x="13.2" y="4" width="6.8" height="6.8" rx="1.4" />
      <rect x="4" y="13.2" width="6.8" height="6.8" rx="1.4" />
      <rect x="13.2" y="13.2" width="6.8" height="6.8" rx="1.4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.3" r="3.3" />
      <path d="M3.4 19.8c.6-3.6 2.7-5.5 5.6-5.5s5 1.9 5.6 5.5" />
      <path d="M15.3 5.6a3.3 3.3 0 0 1 0 5.4" />
      <path d="M17.4 14.7c1.9.7 3 2.4 3.4 5.1" />
    </>
  ),
  swap: (
    <>
      <path d="M4 8h13.5M14.2 4.5 17.8 8l-3.6 3.5" />
      <path d="M20 16H6.5M9.8 12.5 6.2 16l3.6 3.5" />
    </>
  ),
  share: (
    <>
      <path d="M12 14.5V3.8M8.6 6.8 12 3.4l3.4 3.4" />
      <path d="M8 10.5H6.2a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h11.6a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H16" />
    </>
  ),
  link: (
    <>
      <path d="M10.2 13.8a4.1 4.1 0 0 0 5.8 0l3.1-3.1a4.1 4.1 0 1 0-5.8-5.8L11.8 6.4" />
      <path d="M13.8 10.2a4.1 4.1 0 0 0-5.8 0l-3.1 3.1a4.1 4.1 0 1 0 5.8 5.8l1.5-1.5" />
    </>
  ),
  heart: (
    <path d="M12 20.2C6.8 16.7 3.6 13.5 3.6 10c0-2.6 2-4.8 4.6-4.8 1.5 0 2.9.7 3.8 1.9.9-1.2 2.3-1.9 3.8-1.9 2.6 0 4.6 2.2 4.6 4.8 0 3.5-3.2 6.7-8.4 10.2Z" />
  ),
  message: (
    <>
      <path d="M20.2 12.6c0 3.9-3.7 7-8.2 7-1 0-2-.15-2.9-.44L4.2 20.4l1.3-3.6c-1-1.2-1.6-2.6-1.6-4.2 0-3.9 3.6-7 8.1-7s8.2 3.1 8.2 7Z" />
    </>
  ),
  send: (
    <>
      <path d="M20.4 3.6 3.9 10.2l6.3 2.4 2.4 6.3 7.8-15.3Z" />
      <path d="m10.2 12.6 4.4-4.4" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="m6.2 6.2 11.6 11.6" />
    </>
  ),
  /* --- brand marks -------------------------------------------------------
     Drawn in the same stroke family as everything above rather than dropped
     in as the platforms' own filled logos: an icon row that mixes twelve
     official brand colours reads as an advertising strip, and each of those
     logos comes with its own trademark rules about spacing and recolouring.
     These are recognisable silhouettes at 16px, which is the whole job — the
     accessible name beside each one says which platform it actually is. */
  brandInstagram: (
    <>
      <rect x="3.8" y="3.8" width="16.4" height="16.4" rx="4.6" />
      <circle cx="12" cy="12" r="3.9" />
      <circle cx="16.7" cy="7.3" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  brandX: <path d="m4.4 4.2 15.2 15.6M19.6 4.2 4.4 19.8" />,
  brandBluesky: (
    <>
      <path d="M12 16.4C10.2 12.9 7.2 10.3 4.6 8.6 3.4 7.8 2.9 8.9 3.2 10.6c.2 1.4.8 4 1.2 4.8.5 1 1.7 1.4 3.1 1.2 1.3-.2 3-.3 4.5-.2Z" />
      <path d="M12 16.4c1.8-3.5 4.8-6.1 7.4-7.8 1.2-.8 1.7.3 1.4 2-.2 1.4-.8 4-1.2 4.8-.5 1-1.7 1.4-3.1 1.2-1.3-.2-3-.3-4.5-.2Z" />
    </>
  ),
  brandYoutube: (
    <>
      <rect x="2.8" y="5.4" width="18.4" height="13.2" rx="3.8" />
      <path d="m10.3 9.2 5.2 2.8-5.2 2.8V9.2Z" />
    </>
  ),
  brandTiktok: (
    <>
      <path d="M14.2 3.4v10.9a4 4 0 1 1-3.4-4" />
      <path d="M14.2 3.4c.4 2.6 2 4.1 4.6 4.3" />
    </>
  ),
  brandTwitch: (
    <>
      <path d="M4.4 3.8h15.2v10L15.4 18h-3l-2.9 2.6V18H4.4V3.8Z" />
      <path d="M11.4 8v4.4M15.6 8v4.4" />
    </>
  ),
  brandDiscord: (
    <>
      <path d="M8.6 5.6C6.1 6.2 4.4 7.3 4.4 7.3 3.3 9.9 2.9 12.6 3.1 15.4c1.7 1.3 3.4 2.1 5 2.6l1.1-1.7" />
      <path d="M15.4 5.6c2.5.6 4.2 1.7 4.2 1.7 1.1 2.6 1.5 5.3 1.3 8.1-1.7 1.3-3.4 2.1-5 2.6l-1.1-1.7" />
      <path d="M8.5 16.3c2.3.8 4.7.8 7 0" />
      <path d="M9.3 5.2c1.8-.3 3.6-.3 5.4 0" />
      <circle cx="9.4" cy="12.2" r="1.3" />
      <circle cx="14.6" cy="12.2" r="1.3" />
    </>
  ),
  brandReddit: (
    <>
      <circle cx="12" cy="13.4" r="7.2" />
      <path d="M14.4 6.6 15.2 3l3.2.8" />
      <circle cx="18.4" cy="3.8" r="1.5" />
      <circle cx="9.5" cy="12.9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12.9" r="1.1" fill="currentColor" stroke="none" />
      <path d="M9.4 16.4c1.6 1.1 3.6 1.1 5.2 0" />
    </>
  ),
  brandFacebook: (
    <>
      <rect x="3.8" y="3.8" width="16.4" height="16.4" rx="4.2" />
      <path d="M15.2 8.2h-1.6a2 2 0 0 0-2 2v10M9.6 12.6h4.6" />
    </>
  ),
  brandTelegram: (
    <>
      <path d="M20.6 4.4 3.6 11l4.9 1.8 1.7 5.6 2.7-3.1" />
      <path d="m8.5 12.8 12.1-8.4-3.4 14.2-4.3-3.1" />
    </>
  ),
  /* Whatnot is a live-auction stream, so it gets the broadcast glyph rather
     than an attempt at its wordmark. */
  brandWhatnot: (
    <>
      <circle cx="12" cy="12" r="2.6" />
      <path d="M7.6 7.6a6.2 6.2 0 0 0 0 8.8M16.4 16.4a6.2 6.2 0 0 0 0-8.8" />
      <path d="M4.8 4.8a10.2 10.2 0 0 0 0 14.4M19.2 19.2a10.2 10.2 0 0 0 0-14.4" />
    </>
  ),
  /* eBay is a listing, and a price tag is the one shape everything in this app
     already reads as "something for sale". */
  brandEbay: (
    <>
      <path d="M11.2 3.6H19a1.4 1.4 0 0 1 1.4 1.4v7.8a1.4 1.4 0 0 1-.4 1l-7.4 7.4a1.4 1.4 0 0 1-2 0l-7.4-7.4a1.4 1.4 0 0 1 0-2l7.4-7.4a1.4 1.4 0 0 1 .6-.8Z" />
      <circle cx="16.2" cy="7.8" r="1.4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M3.8 12h16.4" />
      <path d="M12 3.8c2.2 2.4 3.3 5.2 3.3 8.2S14.2 17.8 12 20.2c-2.2-2.4-3.3-5.2-3.3-8.2S9.8 6.2 12 3.8Z" />
    </>
  ),
}

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  size = 22,
  className,
  filled = false,
}: {
  name: IconName
  size?: number
  className?: string
  filled?: boolean
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
