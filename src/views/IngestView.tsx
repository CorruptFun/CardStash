import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Empty } from '../components/basics'
import { Icon } from '../components/Icon'
import { TradeSides } from '../components/TradeSides'
import { track } from '../lib/analytics'
import { applyTradeReply, db, recordIncomingTrade, upsertFriendFromProfile } from '../lib/db'
import { settings } from '../lib/settings'
import { decodeBlob, sideQty, sideValue, tradeFromPayload } from '../lib/social'
import type { ProfilePayload, SocialPayload, TradePayload } from '../lib/types'
import { money } from '../lib/util'
import { guarded, useUi, type ToastKind } from '../store/ui'

type IngestState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; payload: SocialPayload }
  | { status: 'reply-done'; name: string; accepted: boolean; tradeId: string }
  | { status: 'reply-orphan'; name: string }

/** Landing screen for share links: `#/x?d=<blob>`. */
export function IngestView({ blob }: { blob: string | null }) {
  const toast = useUi((s) => s.toast)
  const [state, setState] = useState<IngestState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    if (!blob) {
      setState({ status: 'error', message: 'This link is missing its data — ask your friend to re-share.' })
      return
    }
    decodeBlob(blob).then(
      async (payload) => {
        if (cancelled) return
        if (payload.kind === 'reply') {
          // The link *is* the answer — apply it right away.
          const updated = await guarded(() => applyTradeReply(payload), 'Update trade')
          if (cancelled) return
          if (updated) {
            track('trade_update', { action: 'reply', status: payload.status })
            setState({
              status: 'reply-done',
              name: payload.from.name,
              accepted: payload.status === 'accepted',
              tradeId: updated.id,
            })
          } else {
            setState({ status: 'reply-orphan', name: payload.from.name })
          }
          return
        }
        setState({ status: 'ready', payload })
      },
      (err: any) => {
        if (!cancelled) setState({ status: 'error', message: err?.message ?? 'Could not read this link.' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [blob])

  if (state.status === 'loading') {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <h1>Opening share…</h1>
        </header>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <h1>Share link</h1>
        </header>
        <Empty
          icon="link"
          title="Couldn’t read this link"
          body={state.message}
          action={
            <a className="btn btn--ghost" href="#/friends">
              <Icon name="users" size={15} /> Go to Friends
            </a>
          }
        />
      </div>
    )
  }

  if (state.status === 'reply-done') {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <h1>Trade reply</h1>
        </header>
        <Empty
          icon={state.accepted ? 'check' : 'x'}
          title={`${state.name} ${state.accepted ? 'accepted' : 'declined'} your trade`}
          body={
            state.accepted
              ? 'Nice. When you’ve swapped the actual cards, open the trade and mark it completed to update your collection.'
              : 'No deal this time — the trade is marked declined.'
          }
          action={
            <a className="btn btn--primary" href={`#/trades/${state.tradeId}`}>
              <Icon name="swap" size={15} /> View the trade
            </a>
          }
        />
      </div>
    )
  }

  if (state.status === 'reply-orphan') {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <h1>Trade reply</h1>
        </header>
        <Empty
          icon="swap"
          title="No matching trade here"
          body={`This is ${state.name}’s answer to a trade offer, but the offer isn’t on this device — replies only mean something to whoever proposed the trade.`}
          action={
            <a className="btn btn--ghost" href="#/friends">
              <Icon name="users" size={15} /> Go to Friends
            </a>
          }
        />
      </div>
    )
  }

  const payload = state.payload
  if (payload.kind === 'profile') return <ProfilePreview payload={payload} />
  if (payload.kind === 'trade') return <TradePreview payload={payload} toast={toast} />
  return null // replies resolve to the states above
}

function ProfilePreview({ payload }: { payload: ProfilePayload }) {
  const existing = useLiveQuery(() => db.friends.get(payload.id), [payload.id])
  const own = payload.id === settings().profileId
  const count = sideQty(payload.cards)
  const tradeCount = payload.cards.reduce((sum, row) => sum + Math.min(row.qty, row.forTrade), 0)

  const add = async () => {
    const result = await guarded(() => upsertFriendFromProfile(payload), 'Add friend')
    if (!result) return
    track('friend_added', { method: 'link', cards: payload.cards.length, update: !result.created })
    location.hash = `#/friends/${result.friend.id}`
  }

  if (own) {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <h1>Your binder</h1>
        </header>
        <Empty
          icon="users"
          title="That’s your own share link"
          body="Send it to someone else — when they open it, your binder shows up on their Friends tab."
        />
      </div>
    )
  }

  return (
    <div className="screen safe-top">
      <header className="screenhead">
        <h1>Binder share</h1>
      </header>
      <div className="ingestcard">
        <span className="social-row__avatar ingestcard__avatar" aria-hidden="true">
          {payload.name.slice(0, 1).toUpperCase()}
        </span>
        <h2 className="ingestcard__name">{payload.name}</h2>
        {payload.note && <p className="ingestcard__note">“{payload.note}”</p>}
        <p className="ingestcard__stats">
          {count} {count === 1 ? 'card' : 'cards'} · {tradeCount} for trade · {money(sideValue(payload.cards))}
        </p>
        <p className="setsec__note">
          {payload.scope === 'trade'
            ? 'This is their trade binder — the copies they’re open to trading.'
            : 'This is their whole collection list.'}{' '}
          {existing ? 'You already follow them; this updates your copy.' : 'Following keeps a copy on this device.'}
        </p>
        <div className="ingestcard__acts">
          <button className="btn btn--primary" onClick={add}>
            <Icon name="users" size={16} /> {existing ? 'Update their binder' : `Follow ${payload.name}`}
          </button>
          <a className="btn btn--ghost" href="#/friends">
            Not now
          </a>
        </div>
      </div>
    </div>
  )
}

function TradePreview({ payload, toast }: { payload: TradePayload; toast: (text: string, kind?: ToastKind) => void }) {
  // From my (receiving) perspective: what they want is what I'd give.
  const trade = tradeFromPayload(payload)
  const save = async () => {
    const saved = await guarded(() => recordIncomingTrade(trade), 'Save trade')
    if (!saved) return
    if (saved === 'kept') toast('You already answered this trade — showing your copy', 'info')
    else track('trade_update', { action: 'received', give: trade.give.length, take: trade.get.length })
    location.hash = `#/trades/${trade.id}`
  }
  return (
    <div className="screen safe-top">
      <header className="screenhead">
        <h1>Trade offer</h1>
      </header>
      <p className="ingesttrade__from">
        <strong>{payload.from.name}</strong> proposes a trade
        {payload.to?.name ? ` with ${payload.to.name}` : ''}:
      </p>
      {payload.note && <p className="tradenote">“{payload.note}”</p>}
      <TradeSides give={trade.give} get={trade.get} />
      <div className="tradeacts">
        <button className="btn btn--primary" onClick={save}>
          <Icon name="swap" size={16} /> Save & answer
        </button>
        <a className="btn btn--ghost" href="#/friends">
          Not now
        </a>
      </div>
      <p className="setsec__note">
        Saving puts it under Trades on your Friends tab, where Accept/Decline creates a reply link to send back.
      </p>
    </div>
  )
}
