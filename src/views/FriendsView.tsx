import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Empty, Seg } from '../components/basics'
import { Icon } from '../components/Icon'
import { ShareActions, type SharePack } from '../components/ShareActions'
import { track } from '../lib/analytics'
import { readFileText } from '../lib/csv'
import {
  applyTradeReply,
  db,
  recordIncomingTrade,
  upsertFriendFromProfile,
} from '../lib/db'
import { itemUnitPrice, totalQty } from '../lib/prices'
import { settings, useSettings } from '../lib/settings'
import {
  buildProfilePayload,
  decodeShareText,
  encodeBlob,
  fetchSharedProfile,
  looksLikeHostedUrl,
  myProfile,
  payloadFileText,
  shareUrl,
  shareableItems,
  sideValue,
  tradeFromPayload,
  tradeStatusLabel,
} from '../lib/social'
import type { CollectionItem, Friend, ShareScope, SocialPayload, TradeRecord } from '../lib/types'
import { money, relativeAge, ymd } from '../lib/util'
import { guarded, useUi } from '../store/ui'

const NO_ITEMS: CollectionItem[] = []

/** Sum of flagged copies across the collection. */
function forTradeQty(items: CollectionItem[]): number {
  return items.reduce((sum, item) => sum + Math.min(item.qty, item.forTrade ?? 0), 0)
}

function forTradeValue(items: CollectionItem[]): number {
  let total = 0
  for (const item of items) total += (itemUnitPrice(item) ?? 0) * Math.min(item.qty, item.forTrade ?? 0)
  return total
}

export function FriendsView() {
  const friends = useLiveQuery(() => db.friends.orderBy('addedAt').reverse().toArray(), [])
  const trades = useLiveQuery(() => db.trades.toArray(), [])
  const items = useLiveQuery(() => db.collection.toArray(), []) ?? NO_ITEMS
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [pack, setPack] = useState<SharePack | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const tradeRows = useMemo(() => shareableItems(items, 'trade'), [items])
  const allRows = useMemo(() => shareableItems(items, 'all'), [items])
  const tradeQty = useMemo(() => forTradeQty(tradeRows), [tradeRows])
  const tradeValue = useMemo(() => forTradeValue(tradeRows), [tradeRows])
  const sortedTrades = useMemo(
    () => [...(trades ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [trades],
  )

  const buildPack = async () => {
    if (!config.profileName.trim()) {
      toast('Add your name first — shares and trades carry it', 'error')
      return
    }
    const payload = buildProfilePayload(items, myProfile())
    if (!payload.cards.length) {
      toast(
        config.shareScope === 'trade'
          ? 'Nothing marked for trade yet — flag copies from a card’s “Your copies” list first'
          : 'Nothing in your collection to share yet',
        'error',
      )
      return
    }
    const blob = await encodeBlob(payload)
    setPack({
      url: shareUrl(blob),
      fileText: payloadFileText(payload),
      fileName: `cardstock-binder-${ymd()}.json`,
      title: config.shareScope === 'trade' ? `${payload.name}’s trade binder` : `${payload.name}’s collection`,
      text:
        config.shareScope === 'trade'
          ? `${payload.name}’s trade binder — ${payload.cards.length} cards in Cardstock`
          : `${payload.name}’s collection — ${payload.cards.length} cards in Cardstock`,
      kind: 'profile',
    })
  }

  const handlePayload = async (payload: SocialPayload, sourceUrl?: string) => {
    if (payload.kind === 'profile') {
      if (payload.id && payload.id === settings().profileId) {
        toast('That’s your own binder link', 'info')
        return
      }
      const result = await guarded(() => upsertFriendFromProfile(payload, sourceUrl), 'Add friend')
      if (!result) return
      track('friend_added', { method: sourceUrl ? 'url' : 'paste', cards: payload.cards.length, update: !result.created })
      toast(result.created ? `Added ${result.friend.name}` : `Updated ${result.friend.name}`, 'success')
      location.hash = `#/friends/${result.friend.id}`
      return
    }
    if (payload.kind === 'trade') {
      const trade = tradeFromPayload(payload)
      const saved = await guarded(() => recordIncomingTrade(trade), 'Save trade')
      if (!saved) return
      track('trade_update', { action: 'received', give: trade.give.length, take: trade.get.length })
      location.hash = `#/trades/${trade.id}`
      return
    }
    const updated = await guarded(() => applyTradeReply(payload), 'Update trade')
    if (updated === undefined) return
    if (!updated) {
      toast('That reply doesn’t match any trade on this device', 'error')
      return
    }
    track('trade_update', { action: 'reply', status: updated.status })
    toast(`${payload.from.name} ${payload.status} the trade`, payload.status === 'accepted' ? 'success' : 'info')
    location.hash = `#/trades/${updated.id}`
  }

  const importText = async (text: string) => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const hosted = looksLikeHostedUrl(text)
      const payload = hosted ? await fetchSharedProfile(text) : await decodeShareText(text)
      await handlePayload(payload, hosted ? text.trim() : undefined)
      setPasteText('')
    } catch (err: any) {
      toast(err?.message ?? 'Could not read that', 'error')
    } finally {
      setBusy(false)
    }
  }

  const importFile = async (file: File) => {
    try {
      await importText(await readFileText(file))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="screen safe-top">
      <header className="screenhead">
        <h1>Friends</h1>
      </header>

      <section className="setsec">
        <h3>My binder</h3>
        <div className="profilecard">
          <div className="profilecard__row">
            <input
              className="input"
              type="text"
              value={config.profileName}
              onChange={(e) => config.set({ profileName: e.target.value })}
              placeholder="Your name"
              maxLength={40}
              aria-label="Your display name"
            />
          </div>
          <input
            className="input"
            type="text"
            value={config.profileNote}
            onChange={(e) => config.set({ profileNote: e.target.value })}
            placeholder="How to reach you (e.g. “DM @rae on Discord”)"
            maxLength={140}
            aria-label="Contact note"
          />
          <Seg
            ariaLabel="What to share"
            size="sm"
            options={[
              { value: 'trade', label: `For trade (${tradeQty})` },
              { value: 'all', label: `Everything (${totalQty(allRows)})` },
            ]}
            value={config.shareScope}
            onChange={(shareScope) => {
              config.set({ shareScope: shareScope as ShareScope })
              setPack(null)
            }}
          />
          <p className="profilecard__stats">
            {config.shareScope === 'trade' ? (
              tradeQty > 0 ? (
                <>
                  Sharing {tradeQty} {tradeQty === 1 ? 'copy' : 'copies'} marked for trade · {money(tradeValue)}
                </>
              ) : (
                <>Nothing marked for trade yet — open a card, edit “Your copies”, set a For-trade count.</>
              )
            ) : (
              <>Sharing your whole collection list — {totalQty(allRows)} cards across {allRows.length} rows.</>
            )}
          </p>
          <button className="btn btn--primary" onClick={buildPack}>
            <Icon name="share" size={16} /> Share my binder
          </button>
          {pack && <ShareActions pack={pack} />}
          <p className="setsec__note">
            No accounts, no server: the link <em>is</em> the data — a snapshot of what’s listed above. People see it
            only if you send it to them. Re-share after big changes, or keep the file at a stable link (a GitHub Gist
            works) so friends can refresh from it.
          </p>
        </div>
      </section>

      <section className="setsec">
        <h3>Add a friend</h3>
        <div className="addfriend">
          <input
            className="input"
            type="text"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') importText(pasteText)
            }}
            placeholder="Paste a binder or trade link…"
            aria-label="Paste a share link"
          />
          <button className="btn btn--primary" onClick={() => importText(pasteText)} disabled={busy || !pasteText.trim()}>
            {busy ? 'Reading…' : 'Add'}
          </button>
          <button className="btn btn--ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Icon name="upload" size={15} /> File
          </button>
        </div>
        <p className="setsec__note">
          Takes a Cardstock share link, a saved <code>.json</code> binder file, or a hosted file’s URL (that last one
          can be refreshed anytime).
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0])}
        />
      </section>

      {sortedTrades.length > 0 && (
        <section className="setsec">
          <h3>
            Trades <em className="sheetsec__count">{sortedTrades.length}</em>
          </h3>
          <div className="social-list">
            {sortedTrades.map((trade) => (
              <TradeRow key={trade.id} trade={trade} />
            ))}
          </div>
        </section>
      )}

      <section className="setsec">
        <h3>
          Following <em className="sheetsec__count">{friends?.length ?? 0}</em>
        </h3>
        {friends && friends.length === 0 && (
          <Empty
            icon="users"
            title="No friends yet"
            body="Swap binder links with someone: send yours from “My binder” above, and paste theirs here. You’ll see what they own, what’s up for trade, and can propose a swap."
          />
        )}
        <div className="social-list">
          {(friends ?? []).map((friend) => (
            <FriendRow key={friend.id} friend={friend} />
          ))}
        </div>
      </section>
    </div>
  )
}

function FriendRow({ friend }: { friend: Friend }) {
  const stats = useMemo(() => {
    const cards = friend.cards
    const tradeCount = cards.reduce((sum, row) => sum + Math.min(row.qty, row.forTrade), 0)
    return { count: cards.reduce((sum, row) => sum + row.qty, 0), tradeCount, value: sideValue(cards) }
  }, [friend.cards])
  return (
    <a className="social-row" href={`#/friends/${friend.id}`}>
      <span className="social-row__avatar" aria-hidden="true">
        {friend.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="social-row__body">
        <span className="social-row__name">{friend.name}</span>
        <span className="social-row__meta">
          {stats.count} cards · {stats.tradeCount} for trade · {money(stats.value)} · updated {relativeAge(friend.updatedAt)} ago
        </span>
      </span>
      {friend.sourceUrl && <Icon name="link" size={14} className="social-row__linked" />}
      <Icon name="chevronRight" size={16} className="social-row__go" />
    </a>
  )
}

function TradeRow({ trade }: { trade: TradeRecord }) {
  const giveQty = trade.give.reduce((sum, row) => sum + row.qty, 0)
  const getQty = trade.get.reduce((sum, row) => sum + row.qty, 0)
  const attention = trade.status === 'proposed' && trade.direction === 'in'
  return (
    <a className="social-row" href={`#/trades/${trade.id}`}>
      <span className={`social-row__avatar social-row__avatar--trade ${attention ? 'social-row__avatar--hot' : ''}`} aria-hidden="true">
        <Icon name="swap" size={16} />
      </span>
      <span className="social-row__body">
        <span className="social-row__name">
          {trade.direction === 'in' ? `${trade.friendName} → you` : `You → ${trade.friendName}`}
        </span>
        <span className="social-row__meta">
          give {giveQty} · get {getQty} · {relativeAge(trade.updatedAt)} ago
        </span>
      </span>
      <span className={`statuspill statuspill--${trade.status} ${attention ? 'statuspill--hot' : ''}`}>{tradeStatusLabel(trade)}</span>
      <Icon name="chevronRight" size={16} className="social-row__go" />
    </a>
  )
}
