import { useCallback, useEffect, useState } from 'react'
import { Icon, type IconName } from './components/Icon'
import { Toasts } from './components/Toasts'
import { warmOwnedCatalogs } from './lib/tcgcsv'
import { uiStore } from './store/ui'
import { BuilderView } from './views/BuilderView'
import { CardSheetHost } from './views/CardSheet'
import { CollectionView } from './views/CollectionView'
import { DecksView } from './views/DecksView'
import { ScanView } from './views/ScanView'
import { SearchView } from './views/SearchView'
import { SettingsView } from './views/SettingsView'

type Route =
  | { name: 'scan' }
  | { name: 'search' }
  | { name: 'collection' }
  | { name: 'decks'; deckId: string | null }
  | { name: 'builder' }
  | { name: 'settings' }

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
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
    default:
      return { name: 'scan' }
  }
}

const TABS: { route: string; icon: IconName; label: string; match: string[] }[] = [
  { route: '#/scan', icon: 'scan', label: 'Scan', match: ['scan'] },
  { route: '#/search', icon: 'search', label: 'Search', match: ['search'] },
  { route: '#/collection', icon: 'cards', label: 'Collection', match: ['collection'] },
  { route: '#/decks', icon: 'decks', label: 'Decks', match: ['decks', 'builder'] },
  { route: '#/settings', icon: 'settings', label: 'Settings', match: ['settings'] },
]

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  useEffect(() => {
    const onHashChange = () => {
      uiStore.getState().closeSheet()
      setRoute(parseRoute(location.hash))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
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
      </main>
      <nav className="nav safe-bottom" aria-label="Main">
        {TABS.map((tab) => {
          const active = tab.match.includes(route.name)
          return (
            <a key={tab.route} href={tab.route} className={`nav__tab ${active ? 'nav__tab--on' : ''}`}>
              <Icon name={tab.icon} size={22} />
              <span>{tab.label}</span>
            </a>
          )
        })}
      </nav>
      <CardSheetHost />
      <Toasts />
    </div>
  )
}
