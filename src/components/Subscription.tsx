import { useCallback, useEffect, useState } from 'react'
import { billingAvailable, startSubscriptionCheckout, subscriptionState, type SubscriptionState } from '../lib/billing'
import { isSignedIn } from '../lib/authsession'
import { relativeAge } from '../lib/util'
import { useUi } from '../store/ui'
import { Icon } from './Icon'

/**
 * The subscription: what it buys, and the one button that starts or manages it.
 *
 * This closed a real hole. The app told people "the AI deck builder is part of
 * a subscription" and "cloud rescue needs a subscription" and then offered no
 * way whatsoever to buy one — every paid feature was a locked door with no
 * handle.
 *
 * ONE BUTTON, NOT A STATE MACHINE. The server decides whether a tap means
 * "subscribe" or "manage": an account with a live Stripe subscription is handed
 * the billing portal instead of a second checkout. Keeping that choice on the
 * client would mean mirroring Stripe's state here and being wrong about it
 * whenever a card fails between renders.
 *
 * Renders nothing when there is no cloud configured or nobody is signed in —
 * the same reasoning as SocialPanel and SellerPanel. Saying nothing beats
 * offering a button that cannot work, and a signed-out user is being asked for
 * an account elsewhere already.
 */
export function Subscription() {
  const toast = useUi((s) => s.toast)
  const [state, setState] = useState<SubscriptionState | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!billingAvailable() || !isSignedIn()) {
      setState(null)
      return
    }
    setState(await subscriptionState())
  }, [])

  useEffect(() => {
    void refresh()
    // Stripe returns people here with ?subscribed=1. The webhook may land a
    // moment after the redirect, so this is a nudge to re-ask rather than a
    // promise that the row is already there.
    if (location.hash.includes('subscribed=')) {
      const timer = setTimeout(() => void refresh(), 2500)
      return () => clearTimeout(timer)
    }
  }, [refresh])

  if (!billingAvailable() || !isSignedIn() || !state) return null

  const go = async () => {
    setBusy(true)
    try {
      const { url } = await startSubscriptionCheckout()
      // Full-page redirect, not a popup — the same reasoning as SignIn: an iOS
      // Home Screen install has no useful popup.
      location.href = url
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not open the payment page', 'error')
      setBusy(false)
    }
  }

  if (state.active) {
    return (
      <section className="setsec">
        <h3>Subscription</h3>
        <div className="audience audience--friends">
          <Icon name="check" size={15} />
          <span>
            Active
            {state.expiresAt ? <> — renews in {relativeAge(state.expiresAt).replace(' ago', '')}</> : ''}. Cloud rescue
            and the AI deck builder are switched on.
          </span>
        </div>
        {state.source === 'manual' ? (
          <p className="setsec__note">This one was granted directly rather than bought, so there is nothing to manage.</p>
        ) : (
          <div className="setrow">
            <div className="setrow__text">
              <span>Manage subscription</span>
              <em>Change your card, see invoices, or cancel. Cancelling keeps access until the period you paid for ends.</em>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={go} disabled={busy}>
              {busy ? 'Opening…' : 'Manage'}
            </button>
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="setsec">
      <h3>Subscription</h3>
      <p className="setsec__note">
        Scanning, your collection, decks, trades and backup are all free and always will be. A subscription adds the two
        things that cost us money to run: <b>cloud rescue</b>, which reads the cards this device cannot, and the{' '}
        <b>AI deck builder</b>, which studies the current meta and builds around what you own.
      </p>
      <div className="setrow">
        <div className="setrow__text">
          <span>Subscribe</span>
          <em>Card handled by Stripe — we never see the number. Cancel any time.</em>
        </div>
        <button className="btn btn--primary btn--sm" onClick={go} disabled={busy}>
          {busy ? 'Opening…' : 'Subscribe'}
        </button>
      </div>
    </section>
  )
}
