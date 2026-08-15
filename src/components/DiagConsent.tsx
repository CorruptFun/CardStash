import { noteDiagConsent } from '../lib/analytics'
import { DIAG_AVAILABLE } from '../lib/diagconfig'
import { needsExplicitDiagConsent, useSettings } from '../lib/settings'

/**
 * The one time we say what the diagnostics log is, before any of it leaves.
 *
 * Two shapes, and which one you get is a legal question rather than a design
 * one. In the EU/EEA/UK, ePrivacy consent covers any non-essential access to
 * storage on the user's device — not merely cookies — so the honest control
 * there is an **ask**, with nothing sent unless it is answered yes. Everywhere
 * else this is a **disclosure**: the switch already reads on, the copy says so
 * in its first line, and turning it off is one tap in the same banner.
 *
 * Either way nothing has been uploaded yet. `flushTelemetry` refuses while
 * `diagConsentAt` is 0, and `noteDiagConsent()` draws a line under the existing
 * backlog as it answers — so an install that has been collecting for weeks
 * sends what happens next, never what happened before it was asked. Retroactive
 * consent is not consent.
 *
 * It shares the banner slot with InstallPrompt and ConnectNudge, and comes
 * LAST of the three: losing your collection this week and being unable to get
 * it back both outrank a question about counters. Three stacked banners is how
 * all three get ignored.
 */
export function DiagConsent({ suppressed }: { suppressed: boolean }) {
  const config = useSettings()

  // Already answered, or there is nothing to answer — a build with no project
  // configured never posts anything, so asking would be theatre.
  if (suppressed || !DIAG_AVAILABLE || config.diagConsentAt) return null

  const mustAsk = needsExplicitDiagConsent()

  return (
    <div className="installtip" role="status">
      <div className="installtip__body">
        <strong className="installtip__title">
          {mustAsk ? 'Can we count what breaks?' : 'A note on diagnostics'}
        </strong>
        <p>
          {mustAsk
            ? 'Cardstock can send an anonymous count of what worked and what did not — how often a scan succeeds, how long it took, which step failed. It is off unless you say yes.'
            : 'Cardstock sends an anonymous count of what worked and what did not — how often a scan succeeds, how long it took, which step failed. This is on; you can turn it off here or in Settings.'}
        </p>
        <p>
          <b>Never card names, never what you searched for, never your keys.</b> A card that defeats the
          scanner is recorded as a number rather than a name, and your collection size as a range. There
          is no account attached — just a random id for this install.
        </p>
      </div>
      <div className="installtip__actions">
        <button className="installtip__go" onClick={() => void noteDiagConsent(true)}>
          {mustAsk ? 'Yes, that’s fine' : 'Got it'}
        </button>
        <button className="installtip__dismiss" onClick={() => void noteDiagConsent(false)}>
          {mustAsk ? 'No thanks' : 'Turn it off'}
        </button>
      </div>
    </div>
  )
}
