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
  /* A ring binder seen edge-on: covers, spine rings, pages. */
  binder: (
    <>
      <path d="M7 4h11a1.6 1.6 0 0 1 1.6 1.6v12.8A1.6 1.6 0 0 1 18 20H7Z" />
      <path d="M7 4a2.6 2.6 0 0 0-2.6 2.6v10.8A2.6 2.6 0 0 0 7 20" />
      <path d="M7.6 8.4h1.8M7.6 12h1.8M7.6 15.6h1.8" />
    </>
  ),
  qr: (
    <>
      <rect x="3.6" y="3.6" width="6.4" height="6.4" rx="1" />
      <rect x="14" y="3.6" width="6.4" height="6.4" rx="1" />
      <rect x="3.6" y="14" width="6.4" height="6.4" rx="1" />
      <path d="M14 14h2.6v2.6H14zM17.8 17.8h2.6v2.6h-2.6zM14 20.4h1M20.4 14h-1" />
    </>
  ),
  printer: (
    <>
      <path d="M7 9V4.6h10V9" />
      <path d="M7 17.5H5.4A1.4 1.4 0 0 1 4 16.1v-4.7A1.4 1.4 0 0 1 5.4 10h13.2a1.4 1.4 0 0 1 1.4 1.4v4.7a1.4 1.4 0 0 1-1.4 1.4H17" />
      <rect x="7" y="14.6" width="10" height="4.8" rx="1" />
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
