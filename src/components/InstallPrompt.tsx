import { useCallback, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { IS_IOS, IS_STANDALONE } from '../lib/camera'
import { useSettings } from '../lib/settings'

/**
 * Why this banner exists, and why it is not just polish:
 *
 * Everything a user scans lives in IndexedDB on their device. For a site the
 * user has NOT installed, WebKit's storage policy deletes script-writable
 * storage after ~7 days without a visit — so a collection scanned in one
 * sitting and left alone for two weeks can simply be gone. Installing to the
 * Home Screen exempts the app from that sweep. Chromium never evicts this
 * aggressively, but an installed app there is still the durable choice.
 *
 * Installing does NOT protect against a lost or wiped device; only an export
 * does. The banner says both, because the install alone is a half-answer.
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
  const [deferred, setDeferred] = useState<InstallEvent | null>(null)
  const [installed, setInstalled] = useState(false)
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
        <strong className="installtip__title">Keep your collection safe</strong>
        {IS_IOS ? (
          <p>
            iPhone and iPad clear the data of websites you haven't opened in a while — including your scanned cards.
            Adding Cardstock to your Home Screen stops that. Tap <ShareGlyph /> <b>Share</b>, then{' '}
            <b>Add to Home Screen</b>.
          </p>
        ) : (
          <p>
            Installing Cardstock keeps your scanned cards from being cleared with your browsing data, and opens it in
            its own window.
          </p>
        )}
        <p className="installtip__note">
          Either way, a device you lose takes its collection with it — Settings → Export saves a backup file.
        </p>
      </div>
      <div className="installtip__actions">
        {deferred && (
          <button className="installtip__go" onClick={install}>
            Install
          </button>
        )}
        <button className="installtip__dismiss" onClick={dismiss}>
          {deferred ? 'Not now' : 'Got it'}
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
