import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installErrorHooks, installSessionTracking, installTelemetryFlusher } from './lib/analytics'
import { installAutoBackup } from './lib/autobackup'
import { db, loadPatches, requestPersistence, pruneHistory } from './lib/db'
import { hasAnyData, seedDemoData } from './lib/demo'
import { runAutoBackup } from './lib/drive'
import { settings } from './lib/settings'
import { startSocialLoop } from './lib/socialcloud'
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
  // Read the live getter once: narrowing it and then passing it is two reads,
  // and the worker offer() captures outlives the check by as long as the toast.
  const waiting = registration.waiting
  if (controlled && waiting) offer(waiting)
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
  // GoTrue hands OAuth tokens back in the URL fragment, and this app routes
  // on the fragment — so the session must be claimed and the hash cleared
  // before the router ever reads it, or sign-in lands on a garbage route.
  //
  // The hash test is out here rather than inside adoptOAuthRedirect so an
  // ordinary boot never fetches the auth chunk at all — this sits in front of
  // first paint, and a redirect is the rare case.
  if (location.hash.includes('access_token=')) {
    await import('./lib/authsession')
      .then((auth) => auth.adoptOAuthRedirect())
      .catch(() => false)
  }
  if (params.get('demo') === '1' && !(await hasAnyData().catch(() => true))) {
    await seedDemoData().catch(() => {})
  }
  // Both ahead of the first render: error hooks so a crash on mount is
  // recorded rather than missed, the session so the screen view React fires
  // on mount lands inside one. The flusher stays last, so a session_end is
  // written before the flush that the same visibility change triggers.
  installErrorHooks()
  // Ahead of the first render, and awaited: the patch index is read
  // synchronously by every card image on screen (see db.ts), so loading it
  // afterwards would paint the grey fallback on cards the user has already
  // fixed and then swap it out. It is one small table.
  await loadPatches().catch(() => {})
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
  // Backup runs itself from here on. Signed-out users are a no-op — there is no
  // account to attach a vault to, which is the honest limit of the feature.
  installAutoBackup()
  // Hosted social polls only once the user has claimed a handle, so a
  // local-only user — the default — makes no request to our server at all.
  // The loop re-checks on every tick, and only publishes if they also turned
  // publishing on.
  startSocialLoop()
  // The daily Drive backup, deliberately late and deliberately quiet: it
  // no-ops unless the user turned it on, never opens a popup, and never
  // reports failure. 12s keeps it clear of first paint and of the camera
  // coming up, which are the two things the user is actually waiting for.
  setTimeout(() => {
    runAutoBackup().catch(() => {})
  }, 12_000)
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
