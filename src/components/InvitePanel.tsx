import { useCallback, useEffect, useState } from 'react'
import { track } from '../lib/analytics'
import { inviteLink } from '../lib/referral'
import { isSignedIn } from '../lib/authsession'
import { useSettings } from '../lib/settings'
import { befriendReferrer, referralJoins, socialAvailable, socialConfigured } from '../lib/socialcloud'
import { useUi } from '../store/ui'
import { Icon } from './Icon'

/**
 * Invite someone, and be friends with them when they arrive.
 *
 * The link is `?via=<handle>` — the same one `captureReferral()` has always
 * read; this screen is what finally hands it out. Two things happen on the
 * other end, and the copy names both because they are separately surprising:
 * the person arriving is credited to this account (0014 — it decides a price),
 * and the two of them become friends the moment they claim a handle
 * (`befriend_referrer()`), with no request to send or answer.
 *
 * WHAT THIS IS NOT: a binder share. That is one screen up, it carries cards,
 * and it works with no account at all — the serverless default the product
 * rests on. An invite carries nothing but a handle, and it requires one,
 * which is why the two are separate controls rather than one button with a
 * checkbox.
 *
 * Nothing here reaches `track()` with a handle: a handle is identity
 * (referral.ts's rule). The share event records that an invite went out and by
 * what method, which is the same shape `ShareActions` already sends.
 */
export function InvitePanel() {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  const [copied, setCopied] = useState(false)
  const [joins, setJoins] = useState(-1)
  const handle = config.socialHandle
  const url = handle ? inviteLink(handle) : ''
  const canNative = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const refresh = useCallback(() => {
    if (!socialConfigured()) return
    referralJoins()
      .then(setJoins)
      .catch(() => setJoins(-1))
  }, [])

  useEffect(refresh, [refresh])

  if (!socialAvailable()) return null

  // No handle, no link: a referral IS a handle. Say what is missing and where
  // it is, rather than showing a dead button or a link crediting nobody.
  //
  // Signed out, this section does not appear at all. Someone with no account
  // is on the serverless path the product rests on, and SocialPanel directly
  // above already makes the case for an account — a second nudge here would
  // be the same ask twice on one screen.
  if (!handle) {
    if (!isSignedIn()) return null
    return (
      <section className="setsec">
        <h3>Invite a friend</h3>
        <p className="setsec__note">
          Claim a handle under <b>My account</b> first — an invite link is your handle, so there is nothing to put in
          one yet. Sharing your binder by link works without an account and always will.
        </p>
      </section>
    )
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
      track('social_share', { kind: 'invite', method: 'copy', chars: url.length })
    } catch {
      toast('Could not copy the link', 'error')
    }
  }

  const native = async () => {
    try {
      await navigator.share({
        title: 'Cardstock',
        text: `Scan your cards and keep track of what they're worth — this adds you as my friend on Cardstock.`,
        url,
      })
      track('social_share', { kind: 'invite', method: 'native', chars: url.length })
    } catch (err: any) {
      if (err?.name !== 'AbortError') toast('Sharing failed — try Copy link', 'error')
    }
  }

  return (
    <section className="setsec">
      <h3>Invite a friend</h3>
      <p className="setsec__note">
        Anyone who sets up Cardstock through this link is added as your friend as soon as they pick a handle — neither
        of you has to send a request. They also count as one of your invites.
      </p>
      <div className="invite">
        <code className="invite__link" title={url}>
          {url.replace(/^https?:\/\//, '')}
        </code>
        <div className="invite__btns">
          {canNative && (
            <button className="btn btn--primary" onClick={native}>
              <Icon name="share" size={16} /> Invite
            </button>
          )}
          <button className={canNative ? 'btn btn--ghost' : 'btn btn--primary'} onClick={copy}>
            <Icon name={copied ? 'check' : 'link'} size={16} /> {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>
      {joins >= 0 && (
        <p className="setsec__note">
          {joins === 0 ? (
            <>Nobody has joined through your link yet.</>
          ) : (
            <>
              <b>
                {joins} {joins === 1 ? 'collector has' : 'collectors have'}
              </b>{' '}
              joined through your link.
            </>
          )}{' '}
          <button className="btn btn--ghost btn--sm" onClick={refresh}>
            Refresh
          </button>
        </p>
      )}
      <p className="setsec__note">
        The link works whether or not you are publishing your binder — it introduces the two of you, it does not share
        your cards. What they can see is still decided by <b>Who can see it</b> above.
      </p>
    </section>
  )
}

/**
 * The other end of the invite: say who just became a friend.
 *
 * Called after a handle is claimed, and deliberately silent when there is
 * nothing to report — `befriend_referrer()` answers null for "no referral",
 * "already friends" and "blocked" alike, so a second device says nothing
 * rather than announcing the same friendship twice.
 */
export async function announceReferrer(toast: (msg: string, kind?: 'success' | 'error' | 'info') => void) {
  try {
    const handle = await befriendReferrer()
    if (handle) toast(`You and @${handle} are now friends`, 'success')
  } catch {
    // An invite that fails to introduce is not a failed sign-up. The account,
    // the handle and the referral are all already saved.
  }
}
