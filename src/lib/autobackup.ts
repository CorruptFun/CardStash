/**
 * Backup that happens without being asked for.
 *
 * The old vault was excellent and unused: zero rows across the whole project,
 * and a real collection lost to browser eviction on 2026-08-15 while a working
 * backup route sat one passphrase away. Optional lost. So this runs itself.
 *
 * Three triggers, and the third is the one that matters:
 *
 *   * **On boot**, shortly after first paint, so a device that has been away
 *     pulls down anything another device added.
 *   * **On the way out** (`pagehide`/hidden), because the most valuable moment
 *     to have saved is the one just before the tab dies.
 *   * **After the collection changes**, debounced. Scanning a binder produces a
 *     burst of writes and must produce ONE push, not thirty — the debounce is
 *     what makes "automatic" affordable rather than abusive.
 *
 * Everything here is silent. It was not requested, so it must never interrupt:
 * no toasts, no error surfaces, no spinner. A failed backup retries on the next
 * trigger, and `syncNow()` is itself pull-merge-push, so a missed one costs
 * nothing but time. The visible status lives in Settings, where a user who went
 * looking can see when it last worked.
 *
 * It does NOT run for signed-out users, because it cannot: there is no account
 * to attach a vault to. That is the honest limit of this feature and the reason
 * onboarding asks for an account at all.
 */

import { isSignedIn } from './authsession'
import { CLOUD_AVAILABLE } from './cloudconfig'

/** A burst of scanning is one push. */
const DEBOUNCE_MS = 20_000
/** Never more often than this, however busy the app is. */
const MIN_GAP_MS = 60_000
/** Let first paint and the catalog warm-up go first. */
const BOOT_DELAY_MS = 8_000

let timer: ReturnType<typeof setTimeout> | null = null
let lastRunAt = 0
let running = false
let installed = false

async function run(): Promise<void> {
  if (running || !CLOUD_AVAILABLE || !isSignedIn()) return
  running = true
  try {
    const { syncNow } = await import('./cloud')
    await syncNow()
    lastRunAt = Date.now()
  } catch {
    // Silent by design — see the header. The next trigger tries again.
  } finally {
    running = false
  }
}

/**
 * Ask for a backup soon. Collapses a burst into one run and honours the floor,
 * so this is safe to call from anywhere that touches the collection.
 */
export function scheduleBackup(): void {
  if (!CLOUD_AVAILABLE || !isSignedIn()) return
  if (timer) clearTimeout(timer)
  const since = Date.now() - lastRunAt
  timer = setTimeout(() => {
    timer = null
    void run()
  }, Math.max(DEBOUNCE_MS, MIN_GAP_MS - since))
}

/** Run one now if anything is pending — used when the app is going away. */
function flush(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  void run()
}

export function installAutoBackup(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  setTimeout(() => void run(), BOOT_DELAY_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
}
