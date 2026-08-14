import { useCallback, useEffect, useState } from 'react'
import { CLOUD_AVAILABLE } from '../lib/cloudconfig'
import { useSettings } from '../lib/settings'
import { useUi } from '../store/ui'
import { SignIn } from './SignIn'

/**
 * The Settings front door for the cloud vault.
 *
 * The happy path is three taps; the states around it are what actually decide
 * whether people keep their cards, so they are explicit rather than implied:
 *
 * - **Signed out** → sign in, via the shared `SignIn` component. The same
 *   account serves hosted social; this section is only about the vault.
 * - **Signed in, locked** → the passphrase. Copy differs on whether a vault
 *   already exists, because "set a passphrase" and "enter your passphrase"
 *   are different acts and conflating them is how people lock themselves out.
 * - **Unlocked** → sync, with the last result stated plainly.
 *
 * `cloud.ts` is imported dynamically everywhere here so its chunk (and the
 * crypto and merge code it pulls in) is fetched only when someone actually
 * opens this section.
 */

type Stage = 'signedout' | 'locked' | 'ready'

export function CloudSync() {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [stage, setStage] = useState<Stage>('signedout')
  const [passphrase, setPassphrase] = useState('')
  const [existing, setExisting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [who, setWho] = useState<string | null>(null)

  useEffect(() => {
    if (!CLOUD_AVAILABLE) return
    void import('../lib/cloud').then((cloud) => {
      // Gate on the session, not on the email: a Google sign-in arrives
      // without one, and treating that as signed-out strands the user on this
      // screen holding a valid session.
      setWho(cloud.signedInAs())
      setStage(cloud.isSignedIn() ? (cloud.hasVaultKey() ? 'ready' : 'locked') : 'signedout')
    })
  }, [])

  /** Every action funnels through here so one place owns busy + error copy. */
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

  const unlock = () =>
    run(async () => {
      const cloud = await import('../lib/cloud')
      const result = await cloud.unlock(passphrase)
      setExisting(result.existing)
      setPassphrase('')
      setStage('ready')
      toast(result.existing ? 'Vault unlocked' : 'Vault created on this account', 'success')
    })

  const sync = () =>
    run(async () => {
      const cloud = await import('../lib/cloud')
      const outcome = await cloud.syncNow()
      const r = outcome.report
      toast(
        r && (r.added || r.updated)
          ? `Synced — ${r.added} new, ${r.updated} updated from your other device`
          : 'Synced — everything already matched',
        'success',
      )
    })

  const signOut = () =>
    run(async () => {
      const cloud = await import('../lib/cloud')
      cloud.signOut()
      setWho(null)
      setStage('signedout')
    })

  // No project configured (a fork that didn't set one) — say nothing rather
  // than offer a button that cannot work.
  if (!CLOUD_AVAILABLE) return null

  const syncedAt = config.cloudSyncedAt ? new Date(config.cloudSyncedAt).toLocaleString() : null

  return (
    <section className="setsec">
      <h3>Cloud sync</h3>

      {stage === 'signedout' && (
        <>
          <p className="setsec__note">
            Sign in to keep your collection on more than one device — and to get it back if you lose this one. Your
            cards are encrypted on this device first, so the server stores a blob it cannot read.
          </p>
          <SignIn
            onSignedIn={(email) => {
              setWho(email)
              setStage('locked')
            }}
          />
        </>
      )}

      {stage === 'locked' && (
        <>
          <p className="setsec__note">
            Signed in{who ? <> as <b>{who}</b></> : ''}. Now choose the passphrase that encrypts your cards. It is
            separate from your
            login on purpose — without it, whoever runs the server could read every collection.
          </p>
          <p className="setsec__warn">
            <b>Write it down.</b> It never leaves this device and nothing on the server can recover it. Lose the
            passphrase and the vault is unreadable — that is the point, and it has no reset.
          </p>
          <div className="setrow cloudrow">
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="Your passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <button className="btn btn--ghost btn--sm" disabled={busy || passphrase.length < 8} onClick={unlock}>
              {busy ? 'Working…' : 'Unlock'}
            </button>
          </div>
          <p className="setsec__note">
            At least 8 characters. On a second device, enter the same passphrase you used on the first.
          </p>
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={signOut}>
            Sign out
          </button>
        </>
      )}

      {stage === 'ready' && (
        <>
          <p className="setsec__note">
            Signed in{who ? <> as <b>{who}</b></> : ''}, vault unlocked.{' '}
            {existing ? 'Merged with what was already stored.' : 'This device started the vault.'}
          </p>
          <div className="setrow">
            <div className="setrow__text">
              <span>Sync now</span>
              <em>{syncedAt ? `Last synced ${syncedAt}` : 'Not synced yet'}</em>
            </div>
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={sync}>
              {busy ? 'Syncing…' : 'Sync'}
            </button>
          </div>
          <p className="setsec__note">
            Syncing pulls whatever your other devices saved, merges it with what is here, and uploads the result — so
            cards scanned in two places both survive. A card deleted on one device can come back from another that has
            not synced yet.
          </p>
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={signOut}>
            Sign out
          </button>
        </>
      )}
    </section>
  )
}
