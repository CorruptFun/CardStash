import { useCallback, useEffect, useState } from 'react'
import { signedInAs } from '../lib/authsession'
import { suggestHandle } from '../lib/onboarding'
import { useSettings } from '../lib/settings'
import { claimHandle, loadMyProfile } from '../lib/socialcloud'
import { useUi } from '../store/ui'
import { Icon } from './Icon'
import { SignIn } from './SignIn'

/**
 * First run: connect an account before using the app.
 *
 * ## Why this is a screen and not a hard lock
 *
 * It is presented as the way in — full screen, sign-in as the only button
 * with weight — and `Skip for now` is a deliberately quiet text link. That is
 * "mandatory" in the sense that matters: everyone sees it and the default
 * path is an account.
 *
 * It is **not** an actual lock, and that is a considered call rather than a
 * softening. A hard gate would mean: no first launch without a network, the
 * whole app dark whenever Supabase or the mail provider is having a bad day,
 * and the core promise — point a camera at a card, see what it's worth,
 * offline, with nothing signed in — broken for the case it was built for.
 * The emailed code depends on a third-party mail provider with an hourly
 * cap; making that a prerequisite for opening the app puts every new user
 * behind someone else's uptime.
 *
 * If a true lock is wanted anyway, `ALLOW_SKIP` below is the whole change —
 * and the `?welcome=0` escape in `App.tsx` has to go with it.
 *
 * ## Two steps, then out of the way
 *
 * Sign in, then pick a handle, because an account with no handle is an
 * account nobody can find you by — and being findable is half of what was
 * just promised. The handle is pre-filled from the email so the common case
 * is one tap.
 */
const ALLOW_SKIP = true

type Stage = 'signin' | 'handle'

export function Welcome({ onDone }: { onDone: () => void }) {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [stage, setStage] = useState<Stage>('signin')
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)

  // Someone who signed in, closed the app mid-flow and came back should land
  // on the step they actually need, not be asked to sign in again.
  useEffect(() => {
    if (!signedInAs()) return
    setStage('handle')
    loadMyProfile()
      .then((profile) => {
        if (profile) onDone()
        else setHandle(suggestHandle(signedInAs() ?? ''))
      })
      .catch(() => setHandle(suggestHandle(signedInAs() ?? '')))
  }, [onDone])

  const finish = useCallback(
    (skipped: boolean) => {
      config.set({ onboardedAt: Date.now(), accountNudgeAt: 0 })
      if (skipped) toast('You can connect an account any time from Friends', 'info')
      onDone()
    },
    [config, onDone, toast],
  )

  const onSignedIn = useCallback((email: string) => {
    setHandle(suggestHandle(email))
    setStage('handle')
  }, [])

  const claim = () =>
    void (async () => {
      setBusy(true)
      try {
        const name = config.profileName.trim() || handle
        const profile = await claimHandle(handle, name)
        // A display name is what friends actually see; seed it from the
        // handle rather than leaving shares labelled "A Cardstock collector".
        if (!config.profileName.trim()) config.set({ profileName: profile.handle })
        toast(`You're @${profile.handle}`, 'success')
        finish(false)
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not claim that handle', 'error')
      } finally {
        setBusy(false)
      }
    })()

  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-label="Set up Cardstock">
      <div className="welcome__inner">
        <div className="welcome__mark foilglare" aria-hidden="true">
          <Icon name="cards" size={30} />
        </div>

        {stage === 'signin' ? (
          <>
            <h1 className="welcome__title">Connect an account</h1>
            <p className="welcome__lede">
              Your cards are scanned and stored on this device. An account is what lets you get them back if you lose
              it — and lets friends find you by handle to trade.
            </p>
            {/* Each <li> is a flex row of exactly two children — icon and one
                span. Leaving the text bare makes every inline element its own
                flex item, so the row gap lands mid-sentence around a <b>. */}
            <ul className="welcome__points">
              <li>
                <Icon name="refresh" size={15} />
                <span>Your collection on more than one device</span>
              </li>
              <li>
                <Icon name="users" size={15} />
                <span>
                  Friends add you by <b>@handle</b>, not a pasted link
                </span>
              </li>
              <li>
                <Icon name="swap" size={15} />
                <span>Trade offers arrive in the app</span>
              </li>
            </ul>
            <div className="welcome__form">
              <SignIn onSignedIn={onSignedIn} />
            </div>
            <p className="welcome__fine">
              We email you a six-digit code — no password. Scanning, your collection and decks all work offline either
              way; nothing is published anywhere unless you turn it on.
            </p>
          </>
        ) : (
          <>
            <h1 className="welcome__title">Pick a handle</h1>
            <p className="welcome__lede">
              This is how friends add you. It is the only thing about you other collectors can see — your cards stay
              private until you choose to publish them.
            </p>
            <div className="welcome__form">
              <div className="setrow cloudrow">
                <span className="handleat">@</span>
                <input
                  className="input"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                  placeholder="yourhandle"
                  maxLength={24}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label="Your handle"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && handle.length >= 3 && !busy) claim()
                  }}
                />
              </div>
              <button className="btn btn--primary" disabled={busy || handle.length < 3} onClick={claim}>
                {busy ? 'Claiming…' : 'Claim handle'}
              </button>
            </div>
            <p className="welcome__fine">Letters, numbers and underscores. 3–24 characters.</p>
          </>
        )}

        {ALLOW_SKIP && (
          <button className="welcome__skip" onClick={() => finish(true)} disabled={busy}>
            Skip for now
          </button>
        )}
      </div>
    </div>
  )
}
