import { useCallback, useEffect, useState } from 'react'
import { Empty, Modal } from '../components/basics'
import { Icon } from '../components/Icon'
import { amountBucket, track } from '../lib/analytics'
import { currentUserId } from '../lib/authsession'
import {
  confirmReceipt,
  fetchShippingAddress,
  getOrder,
  markShipped,
  orderNarrative,
  orderStatusLabel,
  orderTotalCents,
  raiseDispute,
  sellerProceedsCents,
  type Order,
  type ShippingAddress,
} from '../lib/marketplace'
import { dateTime, money } from '../lib/util'
import { useUi } from '../store/ui'

const usd = (cents: number) => money(cents / 100)

/**
 * One order, from whichever side you are on.
 *
 * There is no `useLiveQuery` here and no Dexie behind it: orders live on the
 * server and are fetched, never mirrored (see marketplace.ts). So this screen
 * owns its own loading and refresh, which is also why every action ends by
 * replacing the order rather than mutating a local copy — the server's answer
 * is the only one that counts, and it may have moved on without us.
 */
export function OrderView({ orderId }: { orderId: string | null }) {
  const toast = useUi((s) => s.toast)
  const [order, setOrder] = useState<Order | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [address, setAddress] = useState<ShippingAddress | null>(null)
  const [tracking, setTracking] = useState('')
  const [shipOpen, setShipOpen] = useState(false)
  const [disputeOpen, setDisputeOpen] = useState(false)
  const [reason, setReason] = useState('')

  const me = currentUserId()

  const load = useCallback(async () => {
    if (!orderId) {
      setOrder(null)
      return
    }
    try {
      setOrder(await getOrder(orderId))
    } catch (err: any) {
      toast(err?.message ?? 'Could not load that order', 'error')
      setOrder(null)
    }
  }, [orderId, toast])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Every action funnels through here: one busy flag, one place errors become a
   * toast, and one reload afterwards. Same shape as `run()` in SocialPanel.
   */
  const run = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await work()
    } catch (err: any) {
      toast(err?.message ?? 'That did not work', 'error')
    } finally {
      setBusy(false)
      void load()
    }
  }

  if (order === undefined) {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <a className="iconbtn" href="#/friends" aria-label="Back to friends">
            <Icon name="chevronLeft" size={20} />
          </a>
          <h1>Order</h1>
        </header>
        <p className="setsec__note">Loading…</p>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <a className="iconbtn" href="#/friends" aria-label="Back to friends">
            <Icon name="chevronLeft" size={20} />
          </a>
          <h1>Order</h1>
        </header>
        <Empty
          icon="swap"
          title="No such order"
          body="It may belong to another account — orders are only visible to their buyer and seller."
        />
      </div>
    )
  }

  const iAmSeller = !!me && order.seller === me
  const total = orderTotalCents(order)

  const ship = () =>
    run(async () => {
      await markShipped(order.id, tracking)
      setShipOpen(false)
      setTracking('')
      track('trade_update', { action: 'shipped', band: amountBucket(total / 100) })
      toast('Marked as posted', 'success')
    })

  const confirm = () =>
    run(async () => {
      const result = await confirmReceipt(order.id)
      track('trade_update', { action: 'received', band: amountBucket(total / 100) })
      toast(
        result.status === 'released'
          ? 'Confirmed — the seller has been paid'
          : 'Confirmed. Payment to the seller is on its way.',
        'success',
      )
    })

  const dispute = () =>
    run(async () => {
      await raiseDispute(order.id, reason)
      setDisputeOpen(false)
      setReason('')
      track('trade_update', { action: 'disputed' })
      toast('Raised — payment is on hold while we look at it', 'info')
    })

  const showAddress = () =>
    run(async () => {
      const found = await fetchShippingAddress(order.id)
      if (!found) {
        toast('No address on this order yet', 'error')
        return
      }
      setAddress(found)
    })

  return (
    <div className="screen safe-top">
      <header className="screenhead friendhead">
        <a className="iconbtn" href="#/friends" aria-label="Back to friends">
          <Icon name="chevronLeft" size={20} />
        </a>
        <div className="friendhead__id">
          <h1>{iAmSeller ? 'Selling' : 'Buying'}</h1>
          <span className="friendhead__meta">
            <span className={`statuspill statuspill--${order.status}`}>{orderStatusLabel(order.status)}</span>
            {'  '}opened {dateTime(order.createdAt)}
          </span>
        </div>
      </header>

      <section className="setsec">
        <div className="orderline">
          <span className="orderline__name">
            {order.qty > 1 ? `${order.qty}× ` : ''}
            {order.cardName}
          </span>
          <span className="orderline__amount">{usd(order.itemCents)}</span>
        </div>
        {order.shippingCents > 0 && (
          <div className="orderline orderline--minor">
            <span>Postage</span>
            <span className="orderline__amount">{usd(order.shippingCents)}</span>
          </div>
        )}
        <div className="orderline orderline--total">
          <span>{iAmSeller ? 'Buyer paid' : 'You paid'}</span>
          <span className="orderline__amount">{usd(total)}</span>
        </div>
        {iAmSeller && (
          <>
            <div className="orderline orderline--minor">
              <span>Cardstock fee</span>
              <span className="orderline__amount">−{usd(order.feeCents)}</span>
            </div>
            <div className="orderline orderline--total">
              <span>You receive</span>
              <span className="orderline__amount">{usd(sellerProceedsCents(order))}</span>
            </div>
          </>
        )}
      </section>

      <p className="ordernarrative">{orderNarrative(order, iAmSeller)}</p>

      {order.tracking && (
        <p className="setsec__note">
          Tracking: <span className="mono">{order.tracking}</span>
        </p>
      )}

      {address && (
        <section className="setsec addressbox">
          <h2 className="setsec__title">Post it to</h2>
          <p className="addressbox__lines">
            {[address.name, address.line1, address.line2, address.city, address.state, address.postalCode, address.country]
              .filter(Boolean)
              .map((line) => (
                <span key={line}>{line}</span>
              ))}
          </p>
          <p className="setsec__note">
            Fetched from the payment provider just now and not saved anywhere — reopen this to see it again.
          </p>
        </section>
      )}

      <div className="tradeacts">
        {iAmSeller && order.status === 'paid' && (
          <>
            <button className="btn btn--primary" onClick={() => setShipOpen(true)} disabled={busy}>
              <Icon name="check" size={16} /> Mark as posted
            </button>
            <button className="btn btn--ghost" onClick={showAddress} disabled={busy}>
              <Icon name="users" size={16} /> Show address
            </button>
          </>
        )}
        {iAmSeller && order.status === 'shipped' && !address && (
          <button className="btn btn--ghost" onClick={showAddress} disabled={busy}>
            <Icon name="users" size={16} /> Show address
          </button>
        )}
        {!iAmSeller && order.status === 'shipped' && (
          <button className="btn btn--primary" onClick={confirm} disabled={busy}>
            <Icon name="check" size={16} /> It arrived — pay the seller
          </button>
        )}
        {!iAmSeller && (order.status === 'paid' || order.status === 'shipped' || order.status === 'delivered') && (
          <button className="btn btn--ghost" onClick={() => setDisputeOpen(true)} disabled={busy}>
            <Icon name="x" size={16} /> Something is wrong
          </button>
        )}
        <button className="btn btn--ghost" onClick={() => void load()} disabled={busy} aria-label="Refresh order">
          <Icon name="refresh" size={15} /> Refresh
        </button>
      </div>

      {order.status === 'disputed' && (
        <p className="setsec__note">
          A person looks at these — there is no automatic decision. Payment stays held until it is resolved, and the
          seven-day clock is paused.
        </p>
      )}
      {order.status === 'released' && order.releasedAt != null && (
        <p className="setsec__note">Paid out {dateTime(order.releasedAt)}.</p>
      )}
      {order.status === 'refunded' && order.refundedAt != null && (
        <p className="setsec__note">
          Refunded {dateTime(order.refundedAt)}. It can take a few days to appear on the card statement.
        </p>
      )}

      <Modal open={shipOpen} onClose={() => setShipOpen(false)} title="Posted it?">
        <p className="setsec__note">
          Only say so once it is actually in the post. The buyer has seven days from now to confirm, after which you are
          paid automatically.
        </p>
        <input
          className="input"
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          placeholder="Tracking number (optional)"
          maxLength={64}
        />
        <div className="modalactions">
          <button className="btn btn--ghost" onClick={() => setShipOpen(false)}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={ship} disabled={busy}>
            It is posted
          </button>
        </div>
      </Modal>

      <Modal open={disputeOpen} onClose={() => setDisputeOpen(false)} title="What is wrong?">
        <p className="setsec__note">
          This pauses the payment and hands it to a person. Try messaging them first if you have not — most problems are
          a slow postal service.
        </p>
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Never arrived, wrong card, damaged…"
          maxLength={200}
        />
        <div className="modalactions">
          <button className="btn btn--ghost" onClick={() => setDisputeOpen(false)}>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={dispute} disabled={busy}>
            Raise it
          </button>
        </div>
      </Modal>
    </div>
  )
}
