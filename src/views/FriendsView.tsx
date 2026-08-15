import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Empty, Seg } from '../components/basics'
import { Icon } from '../components/Icon'
import { ShareActions, type SharePack } from '../components/ShareActions'
import { SocialPanel } from '../components/SocialPanel'
import { SellerPanel } from '../components/SellerPanel'
import { track } from '../lib/analytics'
import { readFileText } from '../lib/csv'
import {
  applyTradeReply,
  db,
  recordIncomingTrade,
  upsertFriendFromProfile,
} from '../lib/db'
import { listOrders, marketReady, orderStatusLabel, type Order } from '../lib/marketplace'
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
  wantKeyFor,
  wantKeySet,
} from '../lib/social'
import {
  answerRequest,
  listRequests,
  matchWants,
  requestFriend,
  socialConfigured,
  syncSocialNow,
  type FriendRequest,
  type PendingRequests,
  type WantMatch,
} from '../lib/socialcloud'
import type { CollectionItem, Friend, ShareScope, SocialPayload, TradeRecord } from '../lib/types'
import { dateTime, money, relativeAge, ymd } from '../lib/util'
import { guarded, useUi } from '../store/ui'

const NO_ITEMS: CollectionItem[] = []

/** The card name behind a want key, for the match list. */
function nameForKey(wants: { key: string; name: string }[], key: string): string {
  return wants.find((want) => want.key === key)?.name ?? key.split('|')[1] ?? key
}

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
  const myWants = useLiveQuery(() => db.wants.orderBy('addedAt').reverse().toArray(), [])
  const myWantKeys = useMemo(() => wantKeySet(myWants ?? []), [myWants])
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [pack, setPack] = useState<SharePack | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [handleInput, setHandleInput] = useState('')
  const [requests, setRequests] = useState<PendingRequests>({ incoming: [], outgoing: [] })
  const [matches, setMatches] = useState<WantMatch[]>([])
  const hosted = socialConfigured()

  /**
   * Requests and want-matches both come from the server and both change when
   * a sync runs, so they refresh together on `socialAt`. Failures are silent:
   * this is a supplementary panel, and a network blip must not put an error
   * across a screen whose primary job (links) never touches the network.
   */
  const refreshHosted = useCallback(() => {
    if (!socialConfigured()) {
      setRequests({ incoming: [], outgoing: [] })
      setMatches([])
      return
    }
    listRequests().then(setRequests, () => {})
  }, [])

  useEffect(() => {
    refreshHosted()
  }, [refreshHosted, config.socialAt, config.socialOn])

  const wantKeys = useMemo(() => (myWants ?? []).map((want) => want.key), [myWants])

  useEffect(() => {
    if (!hosted || !wantKeys.length) {
      setMatches([])
      return
    }
    let live = true
    matchWants(wantKeys).then(
      (rows) => {
        if (live) setMatches(rows)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [hosted, wantKeys, config.socialAt])

  /** want key → who is offering it, for the badge on each want chip. */
  const matchesByKey = useMemo(() => {
    const map = new Map<string, WantMatch[]>()
    for (const match of matches) {
      const list = map.get(match.wantKey)
      if (list) list.push(match)
      else map.set(match.wantKey, [match])
    }
    return map
  }, [matches])

  const addByHandle = async () => {
    const clean = handleInput.trim().replace(/^@/, '')
    if (!clean || busy) return
    setBusy(true)
    try {
      const result = await requestFriend(clean)
      setHandleInput('')
      if (result === 'accepted') {
        toast(`You and @${clean} are now friends`, 'success')
        track('friend_added', { method: 'handle', cards: 0, update: false })
        await syncSocialNow(true).catch(() => {})
      } else {
        toast(`Request sent to @${clean}`, 'success')
      }
      refreshHosted()
    } catch (err: any) {
      toast(err?.message ?? 'Could not send that request', 'error')
    } finally {
      setBusy(false)
    }
  }

  const answer = async (request: FriendRequest, accept: boolean) => {
    try {
      await answerRequest(request.userId, accept)
      toast(accept ? `You and @${request.handle} are now friends` : `Declined @${request.handle}`, accept ? 'success' : 'info')
      if (accept) {
        track('friend_added', { method: 'handle', cards: 0, update: false })
        await syncSocialNow(true).catch(() => {})
      }
      refreshHosted()
    } catch (err: any) {
      toast(err?.message ?? 'Could not answer that', 'error')
    }
  }

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
    const payload = buildProfilePayload(items, myProfile(), myWants ?? [])
    if (!payload.cards.length && !payload.wants?.length) {
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
          {(myWants?.length ?? 0) > 0 && (
            <div className="wantlist">
              <span className="wantlist__label">
                <Icon name="heart" size={13} filled /> Want list · travels with your share
              </span>
              <div className="wantlist__chips">
                {(myWants ?? []).map((want) => (
                  <span key={want.key} className="wantchip">
                    {want.name}
                    {matchesByKey.has(want.key) && (
                      <em className="wantchip__hit" title="Collectors offering this">
                        {matchesByKey.get(want.key)!.length}
                      </em>
                    )}
                    <button
                      className="wantchip__x"
                      aria-label={`Remove ${want.name} from wants`}
                      onClick={() => {
                        guarded(async () => (await db.wants.delete(want.key), true), 'Want list')
                      }}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <button className="btn btn--primary" onClick={buildPack}>
            <Icon name="share" size={16} /> Share my binder
          </button>
          {pack && <ShareActions pack={pack} />}
          <p className="setsec__note">
            {config.socialOn ? (
              <>
                You’re publishing, so this binder republishes itself and friends see changes without a new link. Links
                still work for anyone without an account.
              </>
            ) : (
              <>
                No account needed: the link <em>is</em> the data — a snapshot of what’s listed above. People see it
                only if you send it to them. Re-share after big changes, or keep the file at a stable link (a GitHub
                Gist works) so friends can refresh from it.
              </>
            )}
          </p>
        </div>
      </section>

      <section className="setsec">
        <h3>My account</h3>
        <SocialPanel />
      </section>

      <SellerPanel />

      <OrdersSection />

      {requests.incoming.length > 0 && (
        <section className="setsec">
          <h3>
            Friend requests <em className="sheetsec__count">{requests.incoming.length}</em>
          </h3>
          <div className="social-list">
            {requests.incoming.map((request) => (
              <div key={request.userId} className="social-row social-row--static">
                <span className="social-row__avatar social-row__avatar--hot" aria-hidden="true">
                  {request.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span className="social-row__body">
                  <span className="social-row__name">{request.displayName}</span>
                  <span className="social-row__meta">
                    <span className="handle">@{request.handle}</span> · asked {relativeAge(request.at)} ago
                  </span>
                </span>
                <button className="btn btn--primary btn--sm" onClick={() => answer(request, true)}>
                  Accept
                </button>
                <button className="btn btn--ghost btn--sm" onClick={() => answer(request, false)}>
                  Decline
                </button>
              </div>
            ))}
          </div>
          <p className="setsec__note">
            Accepting lets them see your binder at whatever you have set above — and lets you see theirs.
          </p>
        </section>
      )}

      <section className="setsec">
        <h3>Add a friend</h3>
        {hosted && (
          <>
            <div className="addfriend">
              <span className="handleat">@</span>
              <input
                className="input"
                type="text"
                value={handleInput}
                onChange={(e) => setHandleInput(e.target.value.toLowerCase().replace(/[^a-z0-9_@]/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addByHandle()
                }}
                placeholder="theirhandle"
                maxLength={25}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Add a friend by handle"
              />
              <button className="btn btn--primary" onClick={() => void addByHandle()} disabled={busy || handleInput.trim().length < 3}>
                {busy ? 'Sending…' : 'Add'}
              </button>
            </div>
            <p className="setsec__note">
              They get a request to accept. If they already asked you, this accepts theirs.
              {requests.outgoing.length > 0 && (
                <> Waiting on {requests.outgoing.map((r) => `@${r.handle}`).join(', ')}.</>
              )}
            </p>
          </>
        )}
        <div className="addfriend">
          <input
            className="input"
            type="text"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') importText(pasteText)
            }}
            placeholder="…or paste a binder or trade link"
            aria-label="Paste a share link"
          />
          <button className="btn btn--ghost" onClick={() => importText(pasteText)} disabled={busy || !pasteText.trim()}>
            {busy ? 'Reading…' : 'Add'}
          </button>
          <button className="btn btn--ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Icon name="upload" size={15} /> File
          </button>
        </div>
        <p className="setsec__note">
          Takes a CardStash share link, a saved <code>.json</code> binder file, or a hosted file’s URL (that last one
          can be refreshed anytime). Works with no account at all.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0])}
        />
      </section>

      {matches.length > 0 && (
        <section className="setsec">
          <h3>
            Cards you’re hunting <em className="sheetsec__count">{matchesByKey.size}</em>
          </h3>
          <div className="social-list">
            {[...matchesByKey.entries()].map(([key, holders]) => (
              <div key={key} className="matchrow">
                <span className="matchrow__name">{holders[0] ? nameForKey(myWants ?? [], key) : key}</span>
                <span className="matchrow__holders">
                  {holders.map((holder) => (
                    <button
                      key={holder.userId}
                      className="matchchip"
                      onClick={() => {
                        setHandleInput(holder.handle)
                        toast(`Tap Add to send @${holder.handle} a friend request`, 'info')
                      }}
                    >
                      @{holder.handle}
                      <em>×{holder.qty}</em>
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
          <p className="setsec__note">
            Collectors publishing a for-trade binder that includes something on your want list. Any printing counts.
          </p>
        </section>
      )}

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
            <FriendRow key={friend.id} friend={friend} myWantKeys={myWantKeys} />
          ))}
        </div>
      </section>
    </div>
  )
}

function FriendRow({ friend, myWantKeys }: { friend: Friend; myWantKeys: Set<string> }) {
  const stats = useMemo(() => {
    const cards = friend.cards
    const tradeCount = cards.reduce((sum, row) => sum + Math.min(row.qty, row.forTrade), 0)
    const matches = cards.filter((row) => row.forTrade > 0 && myWantKeys.has(wantKeyFor(row.game, row.name))).length
    return { count: cards.reduce((sum, row) => sum + row.qty, 0), tradeCount, matches, value: sideValue(cards) }
  }, [friend.cards, myWantKeys])
  const delta = friend.lastDelta
  return (
    <a className="social-row" href={`#/friends/${friend.id}`}>
      <span className="social-row__avatar" aria-hidden="true">
        {friend.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="social-row__body">
        <span className="social-row__name">
          {friend.name}
          {stats.matches > 0 && (
            <em className="social-row__match">
              <Icon name="heart" size={11} filled /> {stats.matches} {stats.matches === 1 ? 'match' : 'matches'}
            </em>
          )}
        </span>
        <span className="social-row__meta">
          {stats.count} cards · {stats.tradeCount} for trade · {money(stats.value)} · updated {relativeAge(friend.updatedAt)} ago
          {delta && (delta.added > 0 || delta.removed > 0) ? ` · +${delta.added}/−${delta.removed}` : ''}
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

/**
 * Purchases, either side. Its own component because unlike everything else on
 * this screen it is not a Dexie live query -- orders live on the server and are
 * fetched (marketplace.ts), so it owns a loading state and can fail.
 *
 * Renders nothing at all when there are none, which is the common case and the
 * permanent case for anyone who never buys. A heading over an empty list would
 * advertise a feature to people who have not opted into it.
 */
function OrdersSection() {
  const [orders, setOrders] = useState<Order[]>([])

  useEffect(() => {
    let live = true
    if (!marketReady()) return
    void listOrders()
      .then((rows) => {
        if (live) setOrders(rows)
      })
      // A failure here is silence, deliberately: this section is one of eight
      // on the screen, and an unreachable server should not put an error toast
      // in front of someone who came here to look at their friends.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  if (!orders.length) return null

  return (
    <section className="setsec">
      <h3>
        Purchases <em className="sheetsec__count">{orders.length}</em>
      </h3>
      <div className="social-list">
        {orders.map((order) => (
          <a className="social-row" key={order.id} href={`#/orders/${order.id}`}>
            <Icon name="cart" size={16} />
            <div className="social-row__text">
              <span className="social-row__name">
                {order.qty > 1 ? `${order.qty}× ` : ''}
                {order.cardName}
              </span>
              <span className="social-row__meta">
                {money((order.itemCents + order.shippingCents) / 100)} · {dateTime(order.createdAt)}
              </span>
            </div>
            <span className={`statuspill statuspill--${order.status}`}>{orderStatusLabel(order.status)}</span>
          </a>
        ))}
      </div>
    </section>
  )
}
