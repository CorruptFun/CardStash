import { useMemo } from 'react'
import { FINISH_LABEL, isFoilFinish } from '../lib/games'
import { sharedCardToCard, sharedRowValue, sideQty, sideValue } from '../lib/social'
import type { SharedCard } from '../lib/types'
import { money } from '../lib/util'
import { CardImg } from './basics'

/** One side of a trade: labeled list of shared rows with a value subtotal. */
export function TradeSide({ label, rows, tone }: { label: string; rows: SharedCard[]; tone: 'give' | 'get' }) {
  const value = useMemo(() => sideValue(rows), [rows])
  return (
    <div className={`tradeside tradeside--${tone}`}>
      <div className="tradeside__head">
        <span className="tradeside__label">{label}</span>
        <span className="tradeside__sum">
          {sideQty(rows)} {sideQty(rows) === 1 ? 'card' : 'cards'} · {money(value)}
        </span>
      </div>
      {rows.length === 0 && <p className="tradeside__none">Nothing on this side.</p>}
      {rows.map((row, i) => (
        <SharedRow key={`${row.cardId}|${row.finish}|${row.condition}|${i}`} row={row} />
      ))}
    </div>
  )
}

export function SharedRow({ row, onClick }: { row: SharedCard; onClick?: () => void }) {
  const card = useMemo(() => sharedCardToCard(row), [row])
  const meta = [
    row.setCode,
    row.number ? `#${row.number}` : null,
    row.finish !== 'nonfoil' ? FINISH_LABEL[row.finish] : null,
    row.condition !== 'NM' ? row.condition : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const body = (
    <>
      <CardImg card={card} className="sharedrow__thumb" foil={isFoilFinish(row.finish)} />
      <span className="sharedrow__body">
        <span className="sharedrow__name">{row.name}</span>
        <span className="sharedrow__meta">{meta || row.setName || '—'}</span>
      </span>
      <span className="sharedrow__side">
        {row.qty > 1 && <span className="sharedrow__qty">×{row.qty}</span>}
        <span className="sharedrow__price">{row.price != null ? money(sharedRowValue(row)) : '—'}</span>
      </span>
    </>
  )
  if (!onClick) return <div className="sharedrow">{body}</div>
  return (
    <button className="sharedrow sharedrow--tap" onClick={onClick}>
      {body}
    </button>
  )
}

/** Both sides + the difference line, from my perspective. */
export function TradeSides({ give, get }: { give: SharedCard[]; get: SharedCard[] }) {
  const delta = useMemo(() => sideValue(get) - sideValue(give), [give, get])
  return (
    <div className="tradesides">
      <TradeSide label="You give" rows={give} tone="give" />
      <TradeSide label="You get" rows={get} tone="get" />
      <div className={`tradesides__delta ${delta > 0 ? 'tradesides__delta--up' : delta < 0 ? 'tradesides__delta--down' : ''}`}>
        {delta === 0 ? 'Dead even' : delta > 0 ? `You come out ${money(delta)} ahead` : `You give up ${money(-delta)} in value`}
        <em>by market estimates — always verify before big trades</em>
      </div>
    </div>
  )
}
