import { useCallback, useEffect, useRef, useState } from 'react'
import { CLOUD_AVAILABLE } from '../lib/cloudconfig'
import { useSettings } from '../lib/settings'
import { relativeAge } from '../lib/util'
import { useUi } from '../store/ui'
import { DriveBackup } from './DriveBackup'
import { Icon } from './Icon'
import { SignIn } from './SignIn'

/**
 * Backup, as ONE thing a user never configures.
 *
 * This replaced a passphrase form, and the reason is worth keeping: across the
 * whole project there were **zero** vaults. Not few — zero. Every user who had
 * ever signed in still had exactly one copy of their collection, in browser
 * storage, and on 2026-08-15 one of them lost it to iOS eviction. The old
 * screen was not badly built; it was optional, and optional lost.
 *
 * So there is no form here now. Sign in and it backs up. The key is minted
 * server-side (migration 0009) and there is nothing to remember, which is the
 * only way this could become the default — a passphrase with no reset cannot
 * be, because forgetting it is unrecoverable by construction.
 *
 * Be honest in the copy, though: this is encryption at rest with a key we hold,
 * NOT end-to-end. It is never described as something the server cannot read,
 * because that would be a lie the user cannot check.
 *
 * The other routes still exist and still matter to some people — Drive puts a
 * copy in storage the user owns outright, and the JSON export is the only one
 * that works with no account at all. They live under **Advanced**, because a
 * user who does not care should never have to choose, and one who does should
 * not have to hunt.
 *
 * `cloud.ts` is imported dynamically so its chunk — crypto and the merge code —
 * is fetched only when there is an account to use it.
 */

/** Long enough that a burst of scanning is one push, not thirty. */
const AUTOSYNC_DEBOUNCE_MS = 20_000

export function CloudSync() {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [signedIn, setSignedIn] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const kicked = useRef(false)

  useEffect(() => {
    if (!CLOUD_AVAILABLE) return
    void import('../lib/cloud').then((cloud) => {
      const on = cloud.isSignedIn()
      setSignedIn(on)
      setReady(true)
      // First sync of the session, once, in the background. Failures are silent
      // on purpose: this runs without being asked for, so it must never put an
      // error in front of someone who came here to change a different setting.
      if (on && !kicked.current) {
        kicked.current = true
        setTimeout(() => void cloud.syncNow().catch(() => {}), AUTOSYNC_DEBOUNCE_MS / 4)
      }
    })
  }, [])

  const run = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true)
      try {
        await work()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Something went wrong', 'error')
      } finally {
        setBusy(false)
      }
    },
    [toast],
  )

  const syncNow = () =>
    run(async () => {
      const cloud = await import('../lib/cloud')
      const out = await cloud.syncNow()
      const added = out.report?.added ?? 0
      toast(added ? `Backed up — ${added} card${added === 1 ? '' : 's'} brought in from another device` : 'Backed up', 'success')
    })

  if (!CLOUD_AVAILABLE || !ready) return null

  if (!signedIn) {
    return (
      <section className="setsec">
        <h3>Backup</h3>
        <p className="setsec__note">
          Your cards live on this device, and a phone you lose takes them with it — browsers also clear storage on their
          own if you go a week or two without opening the app. Sign in and your collection backs itself up from then on.
          Nothing to set up and no passphrase to remember.
        </p>
        <SignIn onSignedIn={() => setSignedIn(true)} />
        <Advanced open={advanced} onToggle={() => setAdvanced(!advanced)} />
      </section>
    )
  }

  const syncedAt = config.cloudSyncedAt
  return (
    <section className="setsec">
      <h3>Backup</h3>
      <div className={`audience ${syncedAt ? 'audience--friends' : ''}`}>
        <Icon name={syncedAt ? 'check' : 'refresh'} size={15} />
        <span>
          {syncedAt ? (
            <>
              Your collection is backed up — last saved {relativeAge(syncedAt)} ago. It updates itself as you scan.
            </>
          ) : (
            <>Setting up your first backup…</>
          )}
        </span>
      </div>
      <p className="setsec__note">
        Stored encrypted on our server so a lost phone is not a lost collection, and pulled back down automatically when
        you sign in somewhere new. We hold the key, so treat it as a safety net rather than a secret — anything you
        would not want us able to read does not belong in a card note.
      </p>
      <div className="setrow">
        <div className="setrow__text">
          <span>Back up now</span>
          <em>Happens on its own; this just does it immediately.</em>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={syncNow} disabled={busy}>
          <Icon name="refresh" size={14} className={busy ? 'spin' : ''} /> {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Advanced open={advanced} onToggle={() => setAdvanced(!advanced)} />
    </section>
  )
}

/**
 * The routes most people never need. Drive is the one backup that lands in
 * storage the user owns outright, which is why it survives rather than being
 * deleted now that backup is automatic.
 */
function Advanced({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <details className="diagmore" open={open}>
      <summary className="diagmore__head" onClick={(e) => (e.preventDefault(), onToggle())}>
        Other backup options
      </summary>
      <DriveBackup />
      <p className="setsec__note">
        A copy in your own Google Drive, in a folder only this app can see. Or export a JSON file from the Collection
        screen — that one needs no account at all and restores everything.
      </p>
    </details>
  )
}
