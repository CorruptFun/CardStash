import { useCallback, useEffect, useState } from 'react'
import { nudgeDue, snoozeNudge, type ConnectStep } from '../lib/onboarding'
import { useSettings } from '../lib/settings'

/**
 * The three-day reminder that something is still unconnected.
 *
 * Shares the banner slot with `InstallPrompt` and yields to it: on iOS the
 * install warning is about storage being *deleted this week*, which outranks
 * anything here. Two stacked banners is how both get ignored.
 *
 * ## The copy is state-specific on purpose
 *
 * A generic "your data isn't saved!" is both untrue (it is in IndexedDB) and
 * unactionable. Each step names what is actually missing and what doing it
 * buys — see the table in `lib/onboarding.ts`. The `backup` case is the one
 * that most wants care: being signed in genuinely does **not** back anything
 * up, and someone who signed in because we told them to would otherwise be
 * left believing it did.
 *
 * There is no permanent dismissal, by request. The escape is to finish the
 * step — at which point `nextConnectStep()` returns null and this never
 * renders again.
 */

const COPY: Record<ConnectStep, { title: string; body: string; cta: string; href: string }> = {
  signin: {
    title: 'Your collection is only on this device',
    body: 'If you lose this phone, or your browser clears its storage, the cards go with it. An account takes a minute and means you can get them back — and lets friends find you by handle.',
    cta: 'Connect an account',
    href: '#/friends',
  },
  handle: {
    title: 'Pick a handle so friends can find you',
    body: "You're signed in, but nobody can add you yet. A handle is what someone types to send you a trade offer.",
    cta: 'Pick a handle',
    href: '#/friends',
  },
  backup: {
    title: 'Your cards are not backed up yet',
    body: 'Signing in proved who you are — it does not copy anything off this device. Set a passphrase to sync your collection, or switch on Drive backup, and a lost phone stops meaning a lost collection.',
    cta: 'Set up backup',
    href: '#/settings',
  },
}

export function ConnectNudge({ suppressed }: { suppressed: boolean }) {
  const config = useSettings()
  const [step, setStep] = useState<ConnectStep | null>(null)

  // Re-evaluated when the things it depends on move, so finishing the step
  // makes the banner leave rather than linger until the next launch.
  useEffect(() => {
    setStep(nudgeDue())
  }, [config.onboardedAt, config.accountNudgeAt, config.socialHandle, config.cloudKeyCheck, config.driveBackup])

  const snooze = useCallback(() => {
    snoozeNudge()
    setStep(null)
  }, [])

  if (suppressed || !step) return null
  const copy = COPY[step]

  return (
    <div className="installtip" role="status">
      <div className="installtip__body">
        <strong className="installtip__title">{copy.title}</strong>
        <p>{copy.body}</p>
      </div>
      <div className="installtip__actions">
        <a className="installtip__go" href={copy.href} onClick={snooze}>
          {copy.cta}
        </a>
        <button className="installtip__dismiss" onClick={snooze}>
          Not now
        </button>
      </div>
    </div>
  )
}
