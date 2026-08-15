import { useCallback, useState } from 'react'
import { IS_IOS, IS_STANDALONE } from '../lib/camera'
import { useUi } from '../store/ui'

/**
 * The one sign-in UI, shared by the cloud vault and hosted social.
 *
 * They are separate features with one account, so duplicating this would mean
 * two places to get the iOS caveats wrong. Both mount it and act on the
 * callback.
 *
 * **There is no separate sign-up.** An email address is the account: a code
 * sent to an address that has one signs you in, and to an address that doesn't
 * makes one (`create_user: true`). GoTrue keeps exactly one user per address,
 * so nobody can end up with two accounts and nobody has to remember which
 * button they pressed last time. Never add a "Create account" branch here —
 * two doors to one room is how people convince themselves they need a second
 * email, and a second email is a second collection.
 *
 * An iOS Home Screen app is the one place the Google button cannot be trusted:
 * the OAuth round trip has a long history of surfacing in Safari rather than
 * returning to the app, and a session that lands in Safari lands in a
 * different storage container — the exact partitioning the vault exists to
 * work around. So it is not offered there at all, rather than offered and
 * quietly broken. Every other platform keeps it.
 */
const GOOGLE_IS_A_TRAP = IS_IOS && IS_STANDALONE

export function SignIn({ onSignedIn }: { onSignedIn: (email: string) => void }) {
  const toast = useUi((s) => s.toast)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

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

  const sendCode = () =>
    run(async () => {
      const auth = await import('../lib/authsession')
      await auth.sendEmailCode(email)
      setEmail(auth.normalizeEmail(email))
      setSent(true)
      toast('Check your email for a six-digit code', 'success')
    })

  const verify = () =>
    run(async () => {
      const auth = await import('../lib/authsession')
      const session = await auth.verifyEmailCode(email, code.trim())
      setCode('')
      setSent(false)
      onSignedIn(session.email || auth.normalizeEmail(email))
    })

  const google = () =>
    run(async () => {
      const auth = await import('../lib/authsession')
      auth.startGoogleSignIn()
    })

  if (sent) {
    return (
      <>
        <p className="setsec__note">
          Enter the six-digit code sent to <b>{email}</b>. If you have used Cardstock before with this address, this
          signs you back into that same account.
        </p>
        <div className="setrow cloudrow">
          <input
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code.trim().length >= 6) verify()
            }}
          />
          <button className="btn btn--ghost btn--sm" disabled={busy || code.trim().length < 6} onClick={verify}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </div>
        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setSent(false)}>
          Use a different email
        </button>
      </>
    )
  }

  return (
    <>
      <div className="setrow cloudrow">
        <input
          className="input"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && email.includes('@')) sendCode()
          }}
        />
        <button className="btn btn--ghost btn--sm" disabled={busy || !email.includes('@')} onClick={sendCode}>
          {busy ? 'Sending…' : 'Email me a code'}
        </button>
      </div>
      {!GOOGLE_IS_A_TRAP && (
        <div className="setrow">
          <div className="setrow__text">
            <span>Or use Google</span>
            <em>Faster, but if you use Cardstock from your Home Screen, the emailed code is more reliable</em>
          </div>
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={google}>
            Google
          </button>
        </div>
      )}
    </>
  )
}
