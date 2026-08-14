import { useCallback, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, exportBackup } from '../lib/db'
import { downloadFile } from '../lib/csv'
import { ymd } from '../lib/util'
import { IS_IOS, IS_STANDALONE } from '../lib/camera'
import { useSettings } from '../lib/settings'
import { guarded, useUi } from '../store/ui'

/**
 * Why this banner exists, and why the iOS copy is shaped so awkwardly:
 *
 * Every scanned card lives in IndexedDB on one device. WebKit deletes
 * script-writable storage for an origin with no user interaction in the last
 * seven days of browser use — so a collection scanned in one sitting and left
 * alone for two weeks can simply be gone.
 *
 * `requestPersistence()` (called in main.tsx boot) is the documented exemption
 * from that sweep, but WebKit grants it on heuristics that in practice mean
 * *Home Screen web apps only*. In a plain Safari tab the request is refused,
 * so on iOS installing is the only route to durable storage.
 *
 * And that route has a trap. A Home Screen web app gets a SEPARATE storage
 * container from Safari — IndexedDB, localStorage, cookies and service worker
 * registrations are all partitioned. Installing does not migrate anything: the
 * app opens with an empty collection and the Safari copy stays behind, then
 * gets evicted on the ordinary schedule. Prompting someone to install without
 * saying that is a data-loss trap aimed squarely at the users with the most to
 * lose, so on iOS the backup is the primary action and the install is step two.
 *
 * Chromium partitions nothing — an installed app shares the profile's storage
 * for the origin — so there the install is safe and unqualified.
 */

/**
 * Don't nag someone still trying the app out — a banner on card #1 gets
 * dismissed reflexively and we only ever get the one chance. A handful of
 * cards means they've stopped evaluating and started collecting, which is
 * the moment the warning reads as protection rather than noise.
 */
const MIN_CARDS_TO_PROMPT = 5

/** The non-standard Chromium event that lets us install without leaving the app. */
interface InstallEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function InstallPrompt() {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [deferred, setDeferred] = useState<InstallEvent | null>(null)
  const [installed, setInstalled] = useState(false)
  const [saved, setSaved] = useState(false)
  const count = useLiveQuery(() => db.collection.count(), [])

  useEffect(() => {
    // Chromium fires this instead of showing its own install UI, but only
    // once per page load and only if we call preventDefault — stash it so a
    // later tap can replay it inside the user gesture it requires.
    const onPrompt = (event: Event) => {
      event.preventDefault()
      setDeferred(event as InstallEvent)
    }
    const onInstalled = () => setInstalled(true)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const dismiss = useCallback(() => config.set({ installHintDismissed: true }), [config])

  const saveBackup = useCallback(async () => {
    const ok = await guarded(async () => {
      downloadFile(`cardstock-backup-${ymd()}.json`, JSON.stringify(await exportBackup(), null, 1), 'application/json')
      return true
    }, 'Export')
    if (!ok) return
    // Don't dismiss — on iOS the backup is step one of three, and the steps
    // for installing and importing have to survive the tap that saved it.
    setSaved(true)
    toast('Backup saved — keep it somewhere safe', 'success')
  }, [toast])

  const install = useCallback(async () => {
    if (!deferred) return
    await deferred.prompt()
    const { outcome } = await deferred.userChoice
    // The event is single-use either way; a declined prompt should not leave
    // a dead button behind, so treat a decline as a dismissal.
    setDeferred(null)
    if (outcome === 'dismissed') dismiss()
  }, [deferred, dismiss])

  if (IS_STANDALONE || installed || config.installHintDismissed) return null
  if ((count ?? 0) < MIN_CARDS_TO_PROMPT) return null
  // iOS never fires beforeinstallprompt — there, instructions are the only
  // route. Elsewhere, no event means the browser can't install this at all
  // (desktop Safari, Firefox), and a button that cannot work is worse than
  // no banner.
  if (!IS_IOS && !deferred) return null

  return (
    <div className="installtip" role="status">
      <div className="installtip__body">
        <strong className="installtip__title">
          {IS_IOS ? 'Back up before you install' : 'Keep your collection safe'}
        </strong>
        {IS_IOS ? (
          <>
            <p>
              iPhone and iPad delete the data of websites you haven't opened in about a week — including your scanned
              cards. Adding Cardstock to your Home Screen is the only way to stop that.
            </p>
            <p>
              <b>The Home Screen app starts empty.</b> iOS gives it separate storage from Safari, so nothing you've
              scanned here comes along on its own. Save a backup first, then:
            </p>
            <p className="installtip__steps">
              <ShareGlyph /> <b>Share</b> → <b>Add to Home Screen</b> → open it → <b>Collection → Import</b> your backup.
            </p>
          </>
        ) : (
          <p>
            Installing Cardstock keeps your scanned cards from being cleared with your browsing data, and opens it in
            its own window. Your collection carries over.
          </p>
        )}
        <p className="installtip__note">
          A backup is worth keeping either way — a device you lose takes its collection with it.
        </p>
      </div>
      <div className="installtip__actions">
        <button className={IS_IOS ? 'installtip__go' : 'installtip__dismiss'} onClick={saveBackup}>
          {saved ? 'Save again' : 'Save backup'}
        </button>
        {deferred && (
          <button className="installtip__go" onClick={install}>
            Install
          </button>
        )}
        <button className="installtip__dismiss" onClick={dismiss}>
          {saved ? 'Done' : 'Not now'}
        </button>
      </div>
    </div>
  )
}

/** iOS's Share affordance — recognisable enough that naming it isn't enough. */
function ShareGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3v13M12 3 8 7M12 3l4 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
