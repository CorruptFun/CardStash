import { useCallback, useEffect, useState } from 'react'
import { ConnectNudge } from './components/ConnectNudge'
import { DiagConsent } from './components/DiagConsent'
import { Icon, type IconName } from './components/Icon'
import { InstallPrompt } from './components/InstallPrompt'
import { Toasts } from './components/Toasts'
import { Welcome } from './components/Welcome'
import { trackScreen } from './lib/analytics'
import { shouldShowWelcome } from './lib/onboarding'
import { useSettings } from './lib/settings'
import { warmOwnedCatalogs } from './lib/tcgcsv'
import { uiStore } from './store/ui'
import { BuilderView } from './views/BuilderView'
import { CardEditorHost } from './components/CardEditor'
import { CardSheetHost } from './views/CardSheet'
import { CollectionView } from './views/CollectionView'
import { DecksView } from './views/DecksView'
import { FriendBinderView } from './views/FriendBinderView'
import { FriendsView } from './views/FriendsView'
import { IngestView } from './views/IngestView'
import { ScanView } from './views/ScanView'
import { SearchView } from './views/SearchView'
import { SettingsView } from './views/SettingsView'
import { MessagesView } from './views/MessagesView'
import { OrderView } from './views/OrderView'
import { TradeView } from './views/TradeView'

type Route =
  | { name: 'scan' }
  | { name: 'search' }
  | { name: 'collection' }
  | { name: 'decks'; deckId: string | null }
  | { name: 'builder' }
  | { name: 'settings' }
  | { name: 'friends'; friendId: string | null }
  | { name: 'trades'; tradeId: string | null }
  | { name: 'orders'; orderId: string | null }
  /**
   * Conversations. Addressed by the OTHER PERSON's account id rather than by a
   * thread id, so the same link works whether or not a conversation exists —
   * see the header of MessagesView.
   */
  | { name: 'messages'; otherId: string | null }
  /** Share-link landing: `#/x?d=<blob>` (profile, trade, or reply). */
  | { name: 'ingest'; blob: string | null }

function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const queryAt = raw.indexOf('?')
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt)
  const query = new URLSearchParams(queryAt === -1 ? '' : raw.slice(queryAt + 1))
  const parts = path.split('/').filter(Boolean)
  switch (parts[0]) {
    case 'search':
      return { name: 'search' }
    case 'collection':
      return { name: 'collection' }
    case 'decks':
      return { name: 'decks', deckId: parts[1] ?? null }
    case 'builder':
      return { name: 'builder' }
    case 'settings':
      return { name: 'settings' }
    case 'friends':
      return { name: 'friends', friendId: parts[1] ?? null }
    case 'trades':
      return { name: 'trades', tradeId: parts[1] ?? null }
    case 'orders':
      return { name: 'orders', orderId: parts[1] ?? null }
    case 'messages':
      return { name: 'messages', otherId: parts[1] ?? null }
    case 'x':
      return { name: 'ingest', blob: query.get('d') }
    default:
      return { name: 'scan' }
  }
}

const TABS: { route: string; icon: IconName; label: string; match: string[] }[] = [
  { route: '#/scan', icon: 'scan', label: 'Scan', match: ['scan'] },
  { route: '#/search', icon: 'search', label: 'Search', match: ['search'] },
  { route: '#/collection', icon: 'cards', label: 'Collection', match: ['collection'] },
  { route: '#/friends', icon: 'users', label: 'Friends', match: ['friends', 'trades', 'orders', 'messages', 'ingest'] },
  { route: '#/decks', icon: 'decks', label: 'Decks', match: ['decks', 'builder'] },
  { route: '#/settings', icon: 'settings', label: 'Settings', match: ['settings'] },
]

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  const unread = useSettings((state) => state.messageUnread)
  const [welcome, setWelcome] = useState(() => shouldShowWelcome())
  const [installVisible, setInstallVisible] = useState(false)
  const [nudgeVisible, setNudgeVisible] = useState(false)
  useEffect(() => {
    const onHashChange = () => {
      uiStore.getState().closeSheet()
      setRoute(parseRoute(location.hash))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  // Screen names come from the route union — a fixed set, never free text.
  useEffect(() => {
    trackScreen(route.name)
  }, [route.name])
  const navigate = useCallback((hash: string) => {
    location.hash = hash
  }, [])

  // Once the app has settled, refresh the catalogs of the games this user
  // actually plays so search/scan answer instantly (incremental + day-cached,
  // so on most launches this is a no-op or a small price refresh).
  useEffect(() => {
    const timer = setTimeout(() => warmOwnedCatalogs(), 3500)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="app">
      <main className="app__main">
        <div hidden={route.name !== 'scan'} className="app__screen">
          <ScanView active={route.name === 'scan'} />
        </div>
        {route.name === 'search' && <SearchView />}
        {route.name === 'collection' && <CollectionView />}
        {route.name === 'decks' && <DecksView deckId={route.deckId} navigate={navigate} />}
        {route.name === 'builder' && <BuilderView navigate={navigate} />}
        {route.name === 'settings' && <SettingsView />}
        {route.name === 'friends' &&
          (route.friendId ? <FriendBinderView key={route.friendId} friendId={route.friendId} /> : <FriendsView />)}
        {route.name === 'trades' && <TradeView tradeId={route.tradeId} />}
        {route.name === 'orders' && <OrderView key={route.orderId ?? 'none'} orderId={route.orderId} />}
        {route.name === 'messages' && <MessagesView otherId={route.otherId} />}
        {route.name === 'ingest' && <IngestView blob={route.blob} />}
      </main>
      {/* One banner slot, three claimants, in descending order of what it costs
          to ignore them: losing this week's storage, being unable to recover a
          collection at all, and a question about counters. Each tells the next
          whether the slot is taken — stacking them is how all three get
          ignored. */}
      {route.name !== 'scan' && route.name !== 'ingest' && (
        <>
          <InstallPrompt onVisibleChange={setInstallVisible} />
          <ConnectNudge suppressed={installVisible} onVisibleChange={setNudgeVisible} />
          <DiagConsent suppressed={installVisible || nudgeVisible} />
        </>
      )}
      <nav className="nav safe-bottom" aria-label="Main">
        {TABS.map((tab) => {
          const active = tab.match.includes(route.name)
          // Unread messages are the one thing in this app that is waiting on
          // the user rather than the other way round, so the tab that holds
          // them says so. Read from the settings cache so it is right on the
          // first frame rather than two seconds into the first poll.
          const badge = tab.route === '#/friends' ? unread : 0
          return (
            <a key={tab.route} href={tab.route} className={`nav__tab ${active ? 'nav__tab--on' : ''}`}>
              <span className="nav__glyph">
                <Icon name={tab.icon} size={22} />
                {badge > 0 && (
                  <em className="nav__badge" aria-label={`${badge} unread messages`}>
                    {badge > 9 ? '9+' : badge}
                  </em>
                )}
              </span>
              <span>{tab.label}</span>
            </a>
          )
        })}
      </nav>
      <CardSheetHost />
      <CardEditorHost />
      <Toasts />
      {/* Not over the ingest route: a share link is how most people meet this
          app, and answering someone's trade offer with a signup wall loses
          both the trade and the user. */}
      {welcome && route.name !== 'ingest' && <Welcome onDone={() => setWelcome(false)} />}
    </div>
  )
}
