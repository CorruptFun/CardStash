import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installErrorHooks, installSessionTracking, installTelemetryFlusher } from './lib/analytics'
import { db, requestPersistence, pruneHistory } from './lib/db'
import { hasAnyData, seedDemoData } from './lib/demo'
import { settings } from './lib/settings'
import { startSyncLoop } from './lib/sync'
import { APP_VERSION } from './lib/version'
import { uiStore } from './store/ui'
import './fonts.css'
import './styles.css'

const params = new URLSearchParams(location.search)

/* Service-worker update flow: new worker waits; a toast offers the restart. */

function wireUpdateFlow(
  registration: ServiceWorkerRegistration,
  container: ServiceWorkerContainer,
  onUpdateReady: (activate: () => void) => void,
  onControllerChange: () => void,
): void {
  const controlled = container.controller != null
  const offer = (worker: ServiceWorker) => {
    onUpdateReady(() => worker.postMessage('SKIP_WAITING'))
  }
  if (controlled && registration.waiting) offer(registration.waiting)
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (!installing || !controlled) return
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') offer(installing)
    })
  })
  let reloaded = false
  container.addEventListener('controllerchange', () => {
    if (!controlled || reloaded) return
    reloaded = true
    onControllerChange()
  })
}

function pollForUpdates(registration: ServiceWorkerRegistration, doc: Document, everyMs = 60 * 60_000): void {
  const check = () => {
    registration.update().catch(() => {})
  }
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') check()
  })
  setInterval(check, everyMs)
}

function announceVersion(storage: Storage, version: string, onNewVersion: (version: string) => void): void {
  try {
    const last = storage.getItem('cardstock-version')
    if (last && last !== version) onNewVersion(version)
    if (last !== version) storage.setItem('cardstock-version', version)
  } catch {
    /* private mode */
  }
}

async function boot(): Promise<void> {
  requestPersistence()
  if (params.get('demo') === '1' && !(await hasAnyData().catch(() => true))) {
    await seedDemoData().catch(() => {})
  }
  // Both ahead of the first render: error hooks so a crash on mount is
  // recorded rather than missed, the session so the screen view React fires
  // on mount lands inside one. The flusher stays last, so a session_end is
  // written before the flush that the same visibility change triggers.
  installErrorHooks()
  installSessionTracking(async () => {
    const [cards, decks, friends] = await Promise.all([db.collection.count(), db.decks.count(), db.friends.count()])
    return { cards, decks, friends, games: settings().enabledGames.length }
  })
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  pruneHistory().catch(() => {})
  installTelemetryFlusher()
  startSyncLoop()
  if ('serviceWorker' in navigator && params.get('nosw') !== '1') {
    announceVersion(localStorage, APP_VERSION, (version) => uiStore.getState().toast(`Updated to v${version}`, 'success'))
    const register = () =>
      navigator.serviceWorker
        .register('./sw.js', { updateViaCache: 'none' })
        .then((registration) => {
          wireUpdateFlow(
            registration,
            navigator.serviceWorker,
            (activate) => uiStore.getState().toast('Update ready', 'info', { label: 'Restart', fn: activate }, 60_000),
            () => location.reload(),
          )
          pollForUpdates(registration, document)
        })
        .catch(() => {})
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }
}

boot()
