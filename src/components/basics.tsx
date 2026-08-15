import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Card } from '../lib/types'
import { Icon } from './Icon'

/* CardImg — lazy card art with a named fallback while loading/failed. */

const GAME_FALLBACK_BG: Record<string, string> = {
  mtg: 'linear-gradient(158deg, #2c1e17 0%, #191411 58%, #211713 100%)',
  pokemon: 'linear-gradient(158deg, #16212e 0%, #121518 58%, #151b23 100%)',
  yugioh: 'linear-gradient(158deg, #271d2e 0%, #181317 58%, #1e1723 100%)',
  riftbound: 'linear-gradient(158deg, #122f2b 0%, #101614 58%, #142320 100%)',
  lorcana: 'linear-gradient(158deg, #2b2414 0%, #171310 58%, #221c11 100%)',
  onepiece: 'linear-gradient(158deg, #301a1c 0%, #191113 58%, #241518 100%)',
  starwars: 'linear-gradient(158deg, #2e2a13 0%, #171610 58%, #232012 100%)',
  digimon: 'linear-gradient(158deg, #33220f 0%, #19140f 58%, #251a10 100%)',
  gundam: 'linear-gradient(158deg, #162333 0%, #121419 58%, #17202c 100%)',
}

export function CardImg({
  card,
  size = 'small',
  className = '',
  rounded = true,
  foil = false,
}: {
  card: Card
  size?: 'small' | 'large'
  className?: string
  rounded?: boolean
  /**
   * This copy is a reflective printing, so give it the holographic glare
   * (`isFoilFinish` decides). Off by default: finish lives on the collection
   * row, not on the card, so a bare `Card` genuinely does not know — and a
   * search result shimmering would claim something about a printing nobody
   * has chosen yet.
   */
  foil?: boolean
}) {
  const [loaded, setLoaded] = useState<{ src: string | undefined; state: 'loading' | 'ok' | 'error' }>({
    src: undefined,
    state: 'loading',
  })
  const src = size === 'large' ? (card.imageLarge ?? card.imageSmall) : (card.imageSmall ?? card.imageLarge)
  const state = loaded.src === src ? loaded.state : 'loading'
  return (
    <div
      className={`cardimg ${rounded ? 'cardimg--rounded' : ''} ${foil ? 'cardimg--foil' : ''} ${className}`}
      style={!src || state === 'error' ? { background: GAME_FALLBACK_BG[card.game] } : undefined}
    >
      {src && state !== 'error' && (
        <img
          key={src}
          src={src}
          alt={card.name}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded({ src, state: 'ok' })}
          onError={() => setLoaded({ src, state: 'error' })}
          style={{ opacity: state === 'ok' ? 1 : 0 }}
        />
      )}
      {(!src || state !== 'ok') && (
        <div className={`cardimg__fallback ${state === 'loading' && src ? 'cardimg__fallback--shimmer' : ''}`}>
          {(!src || state === 'error') && (
            <>
              <span className="cardimg__fbname">{card.name}</span>
              {card.setName && <span className="cardimg__fbset">{card.setName}</span>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* Seg — segmented control. */

export interface SegOption<T extends string> {
  value: T
  label: string
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  scroll = false,
  ariaLabel,
  ariaLabelledBy,
}: {
  options: SegOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  /** Overflow sideways-scrolls instead of squeezing (long game lists). */
  scroll?: boolean
  ariaLabel?: string
  ariaLabelledBy?: string
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Keep the active option in view when it changes (or on first paint).
  useEffect(() => {
    if (!scroll) return
    const root = scrollRef.current
    const active = root?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!root || !active) return
    const pad = 12
    const left = active.offsetLeft - pad
    const right = active.offsetLeft + active.offsetWidth + pad
    if (left < root.scrollLeft) root.scrollTo({ left })
    else if (right > root.scrollLeft + root.clientWidth) root.scrollTo({ left: right - root.clientWidth })
  }, [scroll, value])
  return (
    <div
      ref={scrollRef}
      className={`seg seg--${size} ${scroll ? 'seg--scroll' : ''}`}
      role="tablist"
      aria-label={ariaLabelledBy ? undefined : ariaLabel}
      aria-labelledby={ariaLabelledBy}
    >
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          aria-selected={option.value === value}
          className={`seg__opt ${option.value === value ? 'seg__opt--on' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* Stepper — qty ± control. */

export function Stepper({
  value,
  onChange,
  min = 0,
  max = 99,
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
}) {
  return (
    <div className="stepper">
      <button className="stepper__btn" aria-label="Decrease" onClick={() => onChange(Math.max(min, value - 1))}>
        <Icon name="minus" size={16} />
      </button>
      <span className="stepper__val">{value}</span>
      <button className="stepper__btn" aria-label="Increase" onClick={() => onChange(Math.min(max, value + 1))}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  )
}

/* Toggle — switch. */

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button className={`toggle ${on ? 'toggle--on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}

/* Modal — centered dialog with backdrop. */

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  // Portaled so a modal opened from inside the bottom sheet isn't trapped by
  // the sheet's transform (which would re-root position:fixed) or its scroll.
  return createPortal(
    <div className="modal-root" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="modal">
        <div className="modal__head">
          <h2>{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/* Empty — empty-state block. */

export function Empty({
  icon,
  title,
  body,
  note,
  action,
}: {
  icon: Parameters<typeof Icon>[0]['name']
  title: string
  body?: string
  note?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={24} />
      </div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {note && <p className="empty__note">{note}</p>}
      {action}
    </div>
  )
}

/* AnimatedNumber — eased count-up when the value changes. */

function easeOutCubic(from: number, to: number, t: number): number {
  const eased = 1 - (1 - Math.min(1, Math.max(0, t))) ** 3
  return from + (to - from) * eased
}

export function AnimatedNumber({ value, format }: { value: number; format: (value: number) => ReactNode }) {
  const [shown, setShown] = useState(value)
  const currentRef = useRef(value)
  useEffect(() => {
    const from = currentRef.current
    if (from === value) return
    const startedAt = performance.now()
    const DURATION = 500
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / DURATION)
      const eased = easeOutCubic(from, value, t)
      currentRef.current = t < 1 ? eased : value
      setShown(eased)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{format(shown)}</>
}

/* ManaCost — MTG mana pips from a "{2}{B}{B}" cost string. */

const PIP_COLORS: Record<string, { bg: string; fg: string }> = {
  W: { bg: '#e8e0c0', fg: '#3a3420' },
  U: { bg: '#9dc6e8', fg: '#123a5c' },
  B: { bg: '#b6a8bd', fg: '#2a1e33' },
  R: { bg: '#e8a58f', fg: '#5c1e10' },
  G: { bg: '#a3ccae', fg: '#1a3d24' },
  C: { bg: '#cfd3da', fg: '#33373d' },
}

export function ManaCost({ cost, className = '' }: { cost?: string; className?: string }) {
  if (!cost) return null
  const pips = [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
  if (!pips.length) return null
  return (
    <span className={`mana ${className}`} aria-label={`Mana cost ${pips.join(' ')}`}>
      {pips.map((pip, i) => {
        const upper = pip.toUpperCase()
        const colors = PIP_COLORS[upper] ?? PIP_COLORS.C
        const label = upper.length > 2 ? upper.replace('/', '') : upper
        return (
          <i key={i} style={{ background: colors.bg, color: colors.fg }}>
            {label}
          </i>
        )
      })}
    </span>
  )
}
