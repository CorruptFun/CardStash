import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Empty, Modal } from '../components/basics'
import { Icon } from '../components/Icon'
import { ShareActions, type SharePack } from '../components/ShareActions'
import { TradeSides } from '../components/TradeSides'
import { track } from '../lib/analytics'
import { applyTradeToCollection, db, deleteTrade, setTradeStatus } from '../lib/db'
import {
  buildReplyPayload,
  buildTradePayload,
  encodeBlob,
  myProfile,
  payloadFileText,
  shareUrl,
  sideQty,
  tradeStatusLabel,
} from '../lib/social'
import type { TradeRecord } from '../lib/types'
import { dateTime, ymd } from '../lib/util'
import { guarded, useUi } from '../store/ui'

export function TradeView({ tradeId }: { tradeId: string | null }) {
  const trade = useLiveQuery(
    async () => (tradeId ? ((await db.trades.get(tradeId)) ?? null) : null),
    [tradeId],
  )
  const toast = useUi((s) => s.toast)
  const [pack, setPack] = useState<SharePack | null>(null)
  const [confirmComplete, setConfirmComplete] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (trade === undefined) return <div className="screen safe-top" />
  if (!trade) {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <a className="iconbtn" href="#/friends" aria-label="Back to friends">
            <Icon name="chevronLeft" size={20} />
          </a>
          <h1>Trade</h1>
        </header>
        <Empty icon="swap" title="No such trade" body="It may have been deleted on this device." />
      </div>
    )
  }

  const shareOffer = async () => {
    const me = myProfile()
    if (!me.name) {
      toast('Add your name on the Friends screen first', 'error')
      return
    }
    const payload = buildTradePayload(trade, me)
    const blob = await encodeBlob(payload)
    setPack({
      url: shareUrl(blob),
      fileText: payloadFileText(payload),
      fileName: `cardstock-trade-${ymd()}.json`,
      title: `Trade offer from ${me.name}`,
      text: `${me.name} proposes a trade: ${sideQty(trade.give)} of theirs for ${sideQty(trade.get)} of yours`,
      kind: 'trade',
    })
  }

  const shareReply = async (status: 'accepted' | 'declined', current: TradeRecord) => {
    const payload = buildReplyPayload(current, myProfile(), status)
    const blob = await encodeBlob(payload)
    setPack({
      url: shareUrl(blob),
      fileText: payloadFileText(payload),
      fileName: `cardstock-reply-${ymd()}.json`,
      title: `Trade ${status}`,
      text:
        status === 'accepted'
          ? `Deal — trade accepted. Open this in Cardstock to lock it in.`
          : `Trade declined — thanks anyway.`,
      kind: 'reply',
    })
  }

  const answer = async (status: 'accepted' | 'declined') => {
    const next = await guarded(() => setTradeStatus(trade.id, status), 'Update trade')
    if (!next) return
    track('trade_update', { action: status, direction: trade.direction })
    toast(status === 'accepted' ? 'Accepted — now send them the reply link' : 'Declined — send them the reply link', 'info')
    await shareReply(status, next)
  }

  const cancel = async () => {
    const next = await guarded(() => setTradeStatus(trade.id, 'canceled'), 'Update trade')
    if (!next) return
    track('trade_update', { action: 'canceled', direction: trade.direction })
    setPack(null)
    toast('Offer canceled on this device', 'info')
  }

  const complete = async () => {
    const result = await guarded(() => applyTradeToCollection(trade), 'Apply trade')
    setConfirmComplete(false)
    if (!result) return
    track('trade_update', { action: 'completed', added: result.added, removed: result.removed })
    const parts = [`${result.added} added`, `${result.removed} removed`]
    if (result.short) parts.push(`${result.short} given ${result.short === 1 ? 'copy was' : 'copies were'} already gone`)
    toast(`Trade booked — ${parts.join(' · ')}`, 'success')
  }

  const remove = async () => {
    await guarded(async () => (await deleteTrade(trade.id), true), 'Delete')
    setConfirmDelete(false)
    location.hash = '#/friends'
  }

  const open = trade.status === 'proposed'
  const mine = trade.direction === 'out'

  return (
    <div className="screen safe-top">
      <header className="screenhead friendhead">
        <a className="iconbtn" href="#/friends" aria-label="Back to friends">
          <Icon name="chevronLeft" size={20} />
        </a>
        <div className="friendhead__id">
          <h1>{mine ? `You → ${trade.friendName}` : `${trade.friendName} → you`}</h1>
          <span className="friendhead__meta">
            <span className={`statuspill statuspill--${trade.status}`}>{tradeStatusLabel(trade)}</span>
            {'  '}proposed {dateTime(trade.createdAt)}
          </span>
        </div>
      </header>

      {trade.note && <p className="tradenote">“{trade.note}”</p>}

      <TradeSides give={trade.give} get={trade.get} />

      <div className="tradeacts">
        {open && !mine && (
          <>
            <button className="btn btn--primary" onClick={() => answer('accepted')}>
              <Icon name="check" size={16} /> Accept
            </button>
            <button className="btn btn--ghost" onClick={() => answer('declined')}>
              <Icon name="x" size={16} /> Decline
            </button>
          </>
        )}
        {open && mine && (
          <>
            <button className="btn btn--primary" onClick={shareOffer}>
              <Icon name="share" size={16} /> Share the offer
            </button>
            <button className="btn btn--ghost" onClick={cancel}>
              <Icon name="x" size={16} /> Cancel offer
            </button>
          </>
        )}
        {trade.status === 'accepted' && (
          <>
            <button className="btn btn--primary" onClick={() => setConfirmComplete(true)}>
              <Icon name="check" size={16} /> Mark completed — update collection
            </button>
            {!mine && (
              <button className="btn btn--ghost" onClick={() => shareReply('accepted', trade)}>
                <Icon name="share" size={15} /> Reply link
              </button>
            )}
          </>
        )}
        {trade.status === 'declined' && !mine && (
          <button className="btn btn--ghost" onClick={() => shareReply('declined', trade)}>
            <Icon name="share" size={15} /> Reply link
          </button>
        )}
        <button className="btn btn--ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete trade">
          <Icon name="trash" size={15} /> Delete
        </button>
      </div>

      {pack && <ShareActions pack={pack} />}

      {trade.status === 'accepted' && (
        <p className="setsec__note">
          Once you’ve actually swapped the cards, “Mark completed” books it: the copies you gave leave your collection
          and the ones you got are added.
        </p>
      )}
      {trade.status === 'completed' && trade.appliedAt != null && (
        <p className="setsec__note">Booked into your collection {dateTime(trade.appliedAt)}.</p>
      )}

      <Modal open={confirmComplete} onClose={() => setConfirmComplete(false)} title="Book this trade?">
        <p className="setsec__note">
          Removes {sideQty(trade.give)} {sideQty(trade.give) === 1 ? 'copy' : 'copies'} you gave and adds{' '}
          {sideQty(trade.get)} you received. Quantities and for-trade flags update to match.
        </p>
        <div className="modalactions">
          <button className="btn btn--ghost" onClick={() => setConfirmComplete(false)}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={complete}>
            Book it
          </button>
        </div>
      </Modal>
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this trade?">
        <p className="setsec__note">Removes it from your list on this device. Your collection is untouched.</p>
        <div className="modalactions">
          <button className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={remove}>
            Delete
          </button>
        </div>
      </Modal>
    </div>
  )
}
