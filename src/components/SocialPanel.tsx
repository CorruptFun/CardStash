import { useCallback, useEffect, useState } from 'react'
import { track } from '../lib/analytics'
import { isSignedIn, signedInAs } from '../lib/authsession'
import {
  claimHandle,
  eraseSocial,
  loadMyProfile,
  publishBinder,
  resetSocialState,
  socialAvailable,
  syncSocialNow,
  unpublish,
  type SocialProfile,
} from '../lib/socialcloud'
import { redeemReferral } from '../lib/referral'
import { useSettings } from '../lib/settings'
import { relativeAge } from '../lib/util'
import { useUi } from '../store/ui'
import { HandleField } from './HandleField'
import { Icon } from './Icon'
import { SignIn } from './SignIn'

/**
 * The front door for hosted social: an account, a handle, and the switch that
 * starts publishing.
 *
 * The states are explicit rather than implied because each one is a different
 * question for the user:
 *
 * - **Signed out** → what an account buys, then sign in.
 * - **No handle** → claim one. This is also the moment their display name
 *   becomes public, so it is asked for here rather than inferred.
 * - **Not publishing** → the audience, stated plainly, and one switch.
 * - **Publishing** → what is live and when it last went out.
 *
 * The audience copy is not decoration. `scope` decides who can read the
 * binder (decision 16), and turning this on with `scope: 'all'` publishes a
 * full inventory to accepted friends while `scope: 'trade'` publishes a swap
 * list to every signed-in user. Anyone flipping this switch must know which
 * they just did.
 */
export function SocialPanel() {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [profile, setProfile] = useState<SocialProfile | null>(null)
  const [ready, setReady] = useState(false)
  const [handle, setHandle] = useState('')
  const [blocked, setBlocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmErase, setConfirmErase] = useState(false)

  useEffect(() => {
    if (!socialAvailable() || !isSignedIn()) {
      setReady(true)
      return
    }
    loadMyProfile()
      .then(setProfile)
      .catch(() => {})
      .finally(() => setReady(true))
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

  const claim = () =>
    run(async () => {
      const name = config.profileName.trim()
      if (!name) {
        toast('Add your name above first — it is what friends see', 'error')
        return
      }
      const next = await claimHandle(handle, name)
      setProfile(next)
      setHandle('')
      // Fire and forget, never awaited: if the referral was banked from a
      // friend's link it is redeemed here, and a failure must not turn a
      // successful claim into a red toast about a discount.
      void redeemReferral()
      toast(`You are @${next.handle}`, 'success')
    })

  const turnOn = () =>
    run(async () => {
      resetSocialState()
      config.set({ socialOn: true })
      await publishBinder(true)
      config.set({ socialAt: Date.now() })
      track('sync_run', { published: true, connect: true })
      toast('Published — friends can find you by your handle', 'success')
    })

  const turnOff = () =>
    run(async () => {
      await unpublish()
      config.set({ socialOn: false })
      resetSocialState()
      toast('Stopped publishing — sharing by link still works', 'info')
    })

  const syncNow = () =>
    run(async () => {
      const summary = await syncSocialNow(true)
      const parts: string[] = []
      if (summary.published) parts.push('binder published')
      if (summary.friendsUpdated) parts.push(`${summary.friendsUpdated} updated`)
      if (summary.tradesReceived) parts.push(`${summary.tradesReceived} new trade${summary.tradesReceived === 1 ? '' : 's'}`)
      if (summary.repliesApplied) parts.push(`${summary.repliesApplied} repl${summary.repliesApplied === 1 ? 'y' : 'ies'}`)
      toast(parts.length ? `Synced — ${parts.join(' · ')}` : 'Synced — nothing new', 'success')
    })

  const erase = () =>
    run(async () => {
      await eraseSocial()
      setProfile(null)
      setConfirmErase(false)
      toast('Everything you published has been deleted', 'success')
    })

  // A fork that configured no project: say nothing rather than offer a button
  // that cannot work.
  if (!socialAvailable()) return null
  if (!ready) return <p className="setsec__note">Checking your account…</p>

  if (!isSignedIn()) {
    return (
      <>
        <p className="setsec__note">
          An account lets friends add you by <b>@handle</b> instead of a link, delivers trade offers straight into the
          app, and shows you who has the cards on your want list. Your collection stays on this device either way.
        </p>
        <SignIn
          onSignedIn={() => {
            void redeemReferral()
            loadMyProfile().then(setProfile).catch(() => setProfile(null))
          }}
        />
      </>
    )
  }

  if (!profile) {
    return (
      <>
        <p className="setsec__note">
          Signed in{signedInAs() ? <> as <b>{signedInAs()}</b></> : ''}. Pick a handle — it is how friends find you, and
          it is the only thing about you that every signed-in collector can see.
        </p>
        <HandleField
          value={handle}
          onChange={setHandle}
          onSubmit={claim}
          onBlockedChange={setBlocked}
          disabled={busy}
        />
        <button className="btn btn--primary btn--sm" disabled={busy || blocked || handle.length < 3} onClick={claim}>
          {busy ? 'Claiming…' : 'Claim'}
        </button>
        <p className="setsec__note">
          A handle is claimed <b>once</b> and is permanently yours — it can't be changed, and it never passes to another
          collector. Your display name is separate and stays editable.
        </p>
      </>
    )
  }

  const scopeIsTrade = config.shareScope === 'trade'

  if (!config.socialOn) {
    return (
      <>
        <p className="setsec__note">
          You are <b>@{profile.handle}</b> — friends can add you and send you trades. <b>None of your cards are
          published.</b> That is the separate step below.
        </p>
        <div className={`audience audience--${scopeIsTrade ? 'open' : 'friends'}`}>
          <Icon name={scopeIsTrade ? 'eye' : 'users'} size={15} />
          <span>
            {scopeIsTrade ? (
              <>
                Publishing your <b>for-trade</b> list. Any signed-in collector can find it — that is what makes people
                able to match your cards against their want lists.
              </>
            ) : (
              <>
                Publishing your <b>whole collection</b>. Only collectors you have accepted as friends can read it —
                never strangers.
              </>
            )}{' '}
            Change which above.
          </span>
        </div>
        <button className="btn btn--primary" disabled={busy} onClick={turnOn}>
          <Icon name="share" size={16} /> {busy ? 'Publishing…' : 'Start publishing'}
        </button>
      </>
    )
  }

  return (
    <>
      <div className="syncstate">
        <span className="syncstate__dot" />
        <span className="syncstate__text">
          <b>@{profile.handle}</b> · {config.socialAt ? `synced ${relativeAge(config.socialAt)} ago` : 'first sync running'}
        </span>
        <button className="btn btn--ghost btn--sm" onClick={syncNow} disabled={busy}>
          <Icon name="refresh" size={14} className={busy ? 'spin' : ''} /> Sync now
        </button>
      </div>
      <div className={`audience audience--${scopeIsTrade ? 'open' : 'friends'}`}>
        <Icon name={scopeIsTrade ? 'eye' : 'users'} size={15} />
        <span>
          {scopeIsTrade
            ? 'Your for-trade list is findable by any signed-in collector.'
            : 'Your collection is readable only by friends you have accepted.'}
        </span>
      </div>
      <p className="setsec__note">
        Your binder republishes itself as your collection changes, friends’ binders refresh while the app is open, and
        trade offers arrive without anyone pasting a link.
      </p>
      <div className="setrow">
        <div className="setrow__text">
          <span>Stop publishing</span>
          <em>Removes your binder from the server. Your cards and friends stay on this device.</em>
        </div>
        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={turnOff}>
          Stop
        </button>
      </div>
      {confirmErase ? (
        <div className="setrow">
          <div className="setrow__text">
            <span>Delete your account data?</span>
            <em>
              Your profile, binder, friends and pending trades are removed from the server. Your encrypted vault backup
              is not touched — and <b>@{profile.handle}</b> stays reserved to you, so nobody else can take your name and
              you get it back if you return.
            </em>
          </div>
          <button className="btn btn--danger btn--sm" disabled={busy} onClick={erase}>
            Delete
          </button>
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setConfirmErase(false)}>
            Keep
          </button>
        </div>
      ) : (
        <button className="btn btn--ghost btn--sm" onClick={() => setConfirmErase(true)}>
          Delete everything I’ve published
        </button>
      )}
    </>
  )
}
