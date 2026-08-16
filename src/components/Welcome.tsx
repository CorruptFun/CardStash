import { useCallback, useEffect, useState } from 'react'
import { isSignedIn, signedInAs } from '../lib/authsession'
import { suggestHandle } from '../lib/onboarding'
import { announceReferrer } from './InvitePanel'
import { useSettings } from '../lib/settings'
import { claimHandle, loadMyProfile, type SocialProfile } from '../lib/socialcloud'
import { useUi } from '../store/ui'
import { HandleField } from './HandleField'
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
 * ## Signing up and signing in are the same door, and it only opens once
 *
 * There is no separate "create account" path because there is no such thing:
 * an email address IS the account. Sending a code to an address that has one
 * signs you in; sending it to an address that doesn't makes one. Nobody has to
 * remember which they did last time, and nobody can end up with two.
 *
 * That makes the returning-user case the one to get right, and it is the case
 * this screen used to get catastrophically wrong. It asked for a handle after
 * every sign-in, prefilled from the email address — so a collector signing in
 * on a second phone was shown "Pick a handle", tapped the obvious button, and
 * **renamed themselves**, releasing the handle their friends had saved. The
 * server now refuses that outright (migration 0010), and this screen no longer
 * asks: `checkForProfile` looks first, and an account that already has a handle
 * goes to `welcomeback` and then straight into the app.
 */
const ALLOW_SKIP = true

type Stage = 'signin' | 'checking' | 'handle' | 'welcomeback'

export function Welcome({ onDone }: { onDone: () => void }) {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [stage, setStage] = useState<Stage>('signin')
  const [handle, setHandle] = useState('')
  const [blocked, setBlocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [profile, setProfile] = useState<SocialProfile | null>(null)

  const finish = useCallback(
    (skipped: boolean) => {
      config.set({ onboardedAt: Date.now(), accountNudgeAt: 0 })
      if (skipped) toast('You can connect an account any time from Friends', 'info')
      onDone()
    },
    [config, onDone, toast],
  )

  /**
   * The question every sign-in has to answer before anything else: does this
   * account already have a handle?
   *
   * A yes means there is nothing to set up — adopt it and say so. A no means
   * this really is a new collector and the handle step is theirs to do. A
   * *failure* (offline, server down) must fall through to the handle step
   * without prefilling anything, because claiming under a guess is the one
   * outcome that cannot be taken back.
   */
  const checkForProfile = useCallback(
    (email: string) => {
      // There is an account now, so a referral banked from a friend's link can
      // finally be attached to one — and if this account already has a handle
      // (a returning collector on a new phone), the friendship it promised is
      // made here too. Never awaited and never surfaced: the welcome screen
      // must not stall, or fail, on a discount.
      void announceReferrer(toast)
      setStage('checking')
      loadMyProfile()
        .then((found) => {
          if (found) {
            setProfile(found)
            // Their name comes back with them: shares would otherwise be
            // labelled "A Cardstock collector" on the new device.
            if (!config.profileName.trim()) config.set({ profileName: found.displayName || found.handle })
            setStage('welcomeback')
          } else {
            setHandle(suggestHandle(email))
            setStage('handle')
          }
        })
        .catch(() => {
          setHandle('')
          setStage('handle')
        })
    },
    [config, toast],
  )

  // Someone who signed in, closed the app mid-flow and came back should land
  // on the step they actually need, not be asked to sign in again.
  //
  // `isSignedIn`, never `signedInAs`: a Google session arrives with valid
  // tokens and an empty email until `fillIdentity` catches up, so gating on the
  // address shows the sign-in form to someone who is already signed in.
  useEffect(() => {
    if (!isSignedIn()) return
    checkForProfile(signedInAs() ?? '')
    // Once, on mount: this is the resume path, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const claim = () =>
    void (async () => {
      setBusy(true)
      try {
        const name = config.profileName.trim() || handle
        const claimed = await claimHandle(handle, name)
        // Second chance at the same no-op: the call above may have gone out
        // while this device was still offline. It is also the FIRST chance at
        // the introduction — the handle it needs did not exist until this line.
        void announceReferrer(toast)
        // A display name is what friends actually see; seed it from the
        // handle rather than leaving shares labelled "A Cardstock collector".
        if (!config.profileName.trim()) config.set({ profileName: claimed.handle })
        toast(`You're @${claimed.handle}`, 'success')
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
          <Icon name="logo" size={30} />
        </div>

        {stage === 'signin' && (
          <>
            <h1 className="welcome__title">Sign in or create an account</h1>
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
              <SignIn onSignedIn={checkForProfile} />
            </div>
            <p className="welcome__fine">
              We email you a six-digit code — no password, and nothing to sign up for separately. One account per email
              address, so the same address always brings you back to the same collection. Scanning, your collection and
              decks all work offline either way; nothing is published anywhere unless you turn it on.
            </p>
          </>
        )}

        {stage === 'checking' && (
          <>
            <h1 className="welcome__title">Checking your account…</h1>
            <p className="welcome__lede">One moment — seeing whether you have been here before.</p>
          </>
        )}

        {/* The whole point of the account, demonstrated rather than promised:
            they typed an email and their identity came back. */}
        {stage === 'welcomeback' && (
          <>
            <h1 className="welcome__title">Welcome back, @{profile?.handle}</h1>
            <p className="welcome__lede">
              This device is signed in to your account, so friends who already know you can find you here — nothing to
              set up again.
            </p>
            <ul className="welcome__points">
              <li>
                <Icon name="users" size={15} />
                <span>
                  You are still <b>@{profile?.handle}</b> — a handle is claimed once and never changes hands
                </span>
              </li>
              <li>
                <Icon name="swap" size={15} />
                <span>Friends and trade offers arrive as the app catches up</span>
              </li>
              <li>
                <Icon name="cards" size={15} />
                <span>
                  Your <b>cards</b> live on each device — restore them from your backup in Settings
                </span>
              </li>
            </ul>
            <div className="welcome__form">
              <button className="btn btn--primary" onClick={() => finish(false)}>
                Start collecting
              </button>
            </div>
          </>
        )}

        {stage === 'handle' && (
          <>
            <h1 className="welcome__title">Pick a handle</h1>
            <p className="welcome__lede">
              This is how friends add you. It is the only thing about you other collectors can see — your cards stay
              private until you choose to publish them.
            </p>
            <div className="welcome__form">
              <HandleField
                value={handle}
                onChange={setHandle}
                onSubmit={claim}
                onBlockedChange={setBlocked}
                disabled={busy}
                autoFocus
              />
              <button className="btn btn--primary" disabled={busy || blocked || handle.length < 3} onClick={claim}>
                {busy ? 'Claiming…' : 'Claim handle'}
              </button>
            </div>
            <p className="welcome__fine">
              Choose carefully: a handle is claimed once and is yours permanently. It can't be changed later, and it
              never passes to anyone else — that is what stops someone else answering to your name. The display name
              friends see is separate, and you can change that whenever you like.
            </p>
          </>
        )}

        {ALLOW_SKIP && stage !== 'checking' && stage !== 'welcomeback' && (
          <button className="welcome__skip" onClick={() => finish(true)} disabled={busy}>
            Skip for now
          </button>
        )}
      </div>
    </div>
  )
}
