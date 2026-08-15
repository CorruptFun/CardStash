import { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon'
import { isSignedIn } from '../lib/authsession'
import { marketAvailable, sellerReady, startSellerOnboarding } from '../lib/marketplace'
import { useUi } from '../store/ui'

/**
 * Getting set up to be paid for a card.
 *
 * A THIRD switch, deliberately not folded into SocialPanel. CLAUDE.md already
 * insists that signing in and publishing a binder are separate acts because one
 * makes you reachable and the other publishes your cards; accepting money is a
 * third thing again, and the most consequential — it means handing identity
 * documents to a payment processor and taking on an obligation to actually post
 * a card someone paid for. Nobody should arrive at that by tapping a switch
 * that looked like it was about something else.
 *
 * Renders nothing at all -- INCLUDING its own heading -- when the build has no
 * cloud configured or nobody is signed in, on the same reasoning as
 * SocialPanel: say nothing rather than offer a button that cannot work. It owns
 * the `<section>` for exactly that reason; a caller that wrapped it in one
 * would leave a "Selling" heading over empty space for every signed-out user,
 * which advertises the feature to precisely the people who cannot use it.
 */
export function SellerPanel() {
  const toast = useUi((s) => s.toast)
  const [ready, setReady] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!marketAvailable() || !isSignedIn()) {
      setReady(null)
      return
    }
    setReady(await sellerReady())
  }, [])

  useEffect(() => {
    void refresh()
    // Stripe sends people back here with ?onboard=done once they finish. The
    // account is not verified the instant they return -- Stripe may still be
    // checking -- so this is a nudge to re-ask, not a promise of success.
    if (location.hash.includes('onboard=')) {
      const timer = setTimeout(() => void refresh(), 2500)
      return () => clearTimeout(timer)
    }
  }, [refresh])

  if (!marketAvailable() || !isSignedIn()) return null

  const start = async () => {
    setBusy(true)
    try {
      const url = await startSellerOnboarding()
      // A full-page redirect rather than a popup: the same reasoning as Google
      // sign-in in SignIn.tsx -- an iOS Home Screen install has no useful popup.
      location.href = url
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start setup', 'error')
      setBusy(false)
    }
  }

  if (ready === true) {
    return (
      <section className="setsec">
        <h3>Selling</h3>
        <div className="audience audience--friends">
          <Icon name="check" size={15} />
          <span>You can be paid for cards. Friends see a Buy button on your binder.</span>
        </div>
        <p className="setsec__note">
          Money is held until the buyer confirms the card arrived, or for seven days after you mark it posted —
          whichever comes first. Cardstock keeps 8% of the card price, minimum $1; postage is yours in full.
        </p>
      </section>
    )
  }

  return (
    <section className="setsec">
      <h3>Selling</h3>
      <p className="setsec__note">
        Friends who live too far to swap can buy a card instead. Their money is held until it arrives, so neither of you
        has to go first. Setup is handled by Stripe — they verify your identity and pay out to your bank, and Cardstock
        never sees your bank details or your ID.
      </p>
      <div className="setrow">
        <div className="setrow__text">
          <span>{ready === false ? 'Finish setting up payments' : 'Get set up to sell'}</span>
          <em>
            {ready === false
              ? 'Stripe still needs something from you before you can be paid.'
              : 'Takes a few minutes. You can stop at any point and come back.'}
          </em>
        </div>
        <button className="btn btn--primary btn--sm" disabled={busy} onClick={start}>
          {busy ? 'Opening…' : ready === false ? 'Continue' : 'Set up'}
        </button>
      </div>
    </section>
  )
}
