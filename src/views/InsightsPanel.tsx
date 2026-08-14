import { useMemo, useRef, useState } from 'react'
import { CardImg } from '../components/basics'
import { Icon } from '../components/Icon'
import { costBasis, movers, type CostBasis, type Mover, type ValueWindow } from '../lib/portfolio'
import type { CollectionItem, PricePoint } from '../lib/types'
import { money } from '../lib/util'
import { useUi } from '../store/ui'

const WINDOW_DAYS = 30
const CHART_W = 320
const CHART_H = 108
const PAD = { top: 12, right: 54, bottom: 17, left: 8 }
/** Mirrors `--silver` in styles.css — SVG strokes can't read CSS vars here. */
const LINE = '#c3ccd9'
const OPEN_KEY = 'cardstock-insights-open'

export function InsightsPanel({
  items,
  points,
  window,
}: {
  items: CollectionItem[]
  points: PricePoint[]
  window: ValueWindow
}) {
  const openSheet = useUi((s) => s.openSheet)
  const [open, setOpen] = useState(initialOpen)
  const moved = useMemo(() => movers(items, points, WINDOW_DAYS), [items, points])
  const basis = useMemo(() => costBasis(items), [items])
  const hasCostData = basis.covered > 0
  if (!window.ready && !hasCostData) return null
  const gainers = moved.gainers.slice(0, 3)
  const losers = moved.losers.slice(0, 3)
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(OPEN_KEY, open ? '0' : '1')
    } catch {
      /* private mode */
    }
  }
  return (
    <section className="ins">
      <button className="ins__head" onClick={toggle} aria-expanded={open}>
        <span className="ins__title">Insights</span>
        <span className="ins__sub">{WINDOW_DAYS} days</span>
        {!open && window.ready && <DeltaChip delta={window.delta} pct={window.deltaPct} />}
        <Icon name="chevronDown" size={17} className={`ins__chev ${open ? 'ins__chev--open' : ''}`} />
      </button>
      {open && (
        <div className="ins__body">
          {window.ready && <ValueChart series={window.series} delta={window.delta} deltaPct={window.deltaPct} />}
          {hasCostData && <PnlRow cost={basis} />}
          {(gainers.length > 0 || losers.length > 0) && (
            <div className="ins-movers">
              <MoversGroup label="Gainers" rows={gainers} onPick={(m) => openSheet({ card: m.card, origin: 'collection' })} />
              <MoversGroup label="Losers" rows={losers} onPick={(m) => openSheet({ card: m.card, origin: 'collection' })} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function PnlRow({ cost }: { cost: CostBasis }) {
  const up = cost.profit >= 0
  const totalCopies = cost.covered + cost.uncovered
  return (
    <div className="ins-pnl">
      <div className="ins-pnl__row">
        <span className="ins-pnl__stat">
          <span className="ins-pnl__label">Cost</span>
          <span className="ins-pnl__val">{money(cost.cost)}</span>
        </span>
        <span className="ins-pnl__stat">
          <span className="ins-pnl__label">Value</span>
          <span className="ins-pnl__val">{money(cost.value)}</span>
        </span>
        <span className="ins-pnl__stat">
          <span className="ins-pnl__label">P&L</span>
          <span className={`ins-pnl__val ins-pnl__val--${up ? 'up' : 'down'}`}>
            {up ? '▲' : '▼'} {money(Math.abs(cost.profit))}
            <em className="ins-pnl__pct">{Math.abs(cost.profitPct).toFixed(1)}%</em>
          </span>
        </span>
      </div>
      <p className="ins-pnl__note">
        {cost.covered} of {totalCopies} {totalCopies === 1 ? 'card has' : 'cards have'} cost data
        {cost.uncovered > 0 ? ' — this row covers those.' : '.'}
      </p>
    </div>
  )
}

function ValueChart({
  series,
  delta,
  deltaPct,
}: {
  series: { date: string; value: number }[]
  delta: number
  deltaPct: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const geom = useMemo(() => {
    const values = series.map((point) => point.value)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || max * 0.1 || 1
    const x = (i: number) => PAD.left + (i / (series.length - 1)) * (CHART_W - PAD.left - PAD.right)
    const y = (value: number) => PAD.top + (1 - (value - min) / span) * (CHART_H - PAD.top - PAD.bottom)
    const line = series.map((point, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(point.value).toFixed(1)}`).join('')
    const area = `${line}L${x(series.length - 1).toFixed(1)},${CHART_H - PAD.bottom}L${PAD.left},${CHART_H - PAD.bottom}Z`
    return { x, y, line, area }
  }, [series])
  const lastIndex = series.length - 1
  const shownIndex = hover == null ? lastIndex : Math.min(hover, lastIndex)
  const shown = series[shownIndex]
  const lastValue = series[lastIndex].value
  const labelY = Math.min(Math.max(geom.y(lastValue) + 3.6, PAD.top + 4), CHART_H - PAD.bottom - 3)
  const pick = (clientX: number) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const t = (((clientX - rect.left) / rect.width) * CHART_W - PAD.left) / (CHART_W - PAD.left - PAD.right)
    setHover(Math.round(Math.min(1, Math.max(0, t)) * lastIndex))
  }
  return (
    <div className="ins-chart">
      <div className="ins-chart__readout">
        <span className="ins-chart__val">{money(shown.value)}</span>
        <span className="ins-chart__date">{shortDate(shown.date)}</span>
        <DeltaChip delta={delta} pct={deltaPct} />
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="ins-chart__svg"
        role="img"
        aria-label={`Collection value over ${series.length} days, ${money(series[0].value)} to ${money(lastValue)}`}
        onPointerMove={(event) => pick(event.clientX)}
        onPointerLeave={() => setHover(null)}
        onTouchMove={(event) => pick(event.touches[0].clientX)}
        onTouchEnd={() => setHover(null)}
      >
        <defs>
          <linearGradient id="insfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={LINE} stopOpacity="0.26" />
            <stop offset="1" stopColor={LINE} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={PAD.left} x2={CHART_W - PAD.right} y1={CHART_H - PAD.bottom} y2={CHART_H - PAD.bottom} className="ins-chart__baseline" />
        <path d={geom.area} fill="url(#insfill)" />
        <path d={geom.line} fill="none" stroke={LINE} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && (
          <line x1={geom.x(shownIndex)} x2={geom.x(shownIndex)} y1={PAD.top - 4} y2={CHART_H - PAD.bottom} className="ins-chart__crosshair" />
        )}
        <circle cx={geom.x(shownIndex)} cy={geom.y(shown.value)} r="3.5" fill={LINE} stroke="var(--ink-050)" strokeWidth="2" />
        <text x={geom.x(lastIndex) + 7} y={labelY} className="ins-chart__label">
          {money(lastValue)}
        </text>
        <text x={PAD.left} y={CHART_H - 4} className="ins-chart__tick">
          {shortDate(series[0].date)}
        </text>
        <text x={CHART_W - PAD.right} y={CHART_H - 4} className="ins-chart__tick" textAnchor="middle">
          Today
        </text>
      </svg>
    </div>
  )
}

function MoversGroup({ label, rows, onPick }: { label: string; rows: Mover[]; onPick: (mover: Mover) => void }) {
  if (!rows.length) return null
  return (
    <div className="ins-movers__group">
      <span className="ins-movers__label">{label}</span>
      {rows.map((mover) => (
        <button key={mover.card.id} className="ins-mover" onClick={() => onPick(mover)}>
          <CardImg card={mover.card} className="ins-mover__img" />
          <span className="ins-mover__text">
            <span className="ins-mover__name">{mover.card.name}</span>
            <span className="ins-mover__meta">
              ×{mover.qty} · {money(Math.abs(mover.delta))}
            </span>
          </span>
          <span className={`ins-mover__pct ${mover.delta >= 0 ? 'ins-delta--up' : 'ins-delta--down'}`}>
            {mover.delta >= 0 ? '▲' : '▼'} {Math.abs(mover.deltaPct).toFixed(1)}%
          </span>
        </button>
      ))}
    </div>
  )
}

export function DeltaChip({ delta, pct }: { delta: number; pct: number }) {
  return (
    <span className={`ins-delta ${delta >= 0 ? 'ins-delta--up' : 'ins-delta--down'}`}>
      {delta >= 0 ? '▲' : '▼'} {money(Math.abs(delta))} ({Math.abs(pct).toFixed(1)}%)
    </span>
  )
}

function shortDate(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function initialOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}
