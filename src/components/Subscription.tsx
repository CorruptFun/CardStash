import { useCallback, useEffect, useState } from 'react'
import {
  billingAvailable,
  FOUNDING_PRICE,
  startSubscriptionCheckout,
  subscriptionState,
  YEARLY_PRICE,
  type SubscriptionState,
} from '../lib/billing'
import { isSignedIn } from '../lib/authsession'
import { foundingOffer, type FoundingOffer } from '../lib/referral'
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
  const [offer, setOffer] = useState<FoundingOffer | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!billingAvailable() || !isSignedIn()) {
      setState(null)
      return
    }
    const next = await subscriptionState()
    setState(next)
    // Only asked of someone who might still buy — a subscriber is already past
    // the price, and the seat count is not news to them.
    setOffer(next.active ? null : await foundingOffer())
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
        ) : state.source === 'stripe-founding' ? (
          // A founding purchase is a one-off charge with no Stripe subscription
          // behind it, so the portal has nothing to show — and the Manage
          // button would call /checkout, which finds no live subscription to
          // manage and cheerfully sells them a second one.
          <p className="setsec__note">
            You are a founding member. That was a one-off payment and it does not expire, so there is nothing to renew,
            manage or cancel.
          </p>
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

  // The founding offer, shown only when the SERVER says both halves are true:
  // this account was referred, and a place is genuinely still free.
  // `reserve_founding_seat()` checks those same two facts at checkout, so copy
  // driven by anything else — a settings flag, a cached count — eventually
  // promises a price the till then refuses, which is worse than never having
  // made the offer.
  if (offer?.referred && offer.seatsLeft > 0) {
    return (
      <section className="setsec">
        <h3>Subscription</h3>
        <div className="audience audience--friends">
          <Icon name="sparkle" size={15} />
          <span>
            You came in through a friend’s link, so one of the <b>first 100 founding places</b> is yours if you want it
            — <b>{offer.seatsLeft}</b> {offer.seatsLeft === 1 ? 'is' : 'are'} left.
          </span>
        </div>
        <p className="setsec__note">
          Pay <b>{FOUNDING_PRICE} once</b> and <b>cloud rescue</b>, which reads the cards this device cannot, and the{' '}
          <b>AI deck builder</b> are yours permanently. It is a single payment and not a subscription: it does not
          renew, it does not run out, and there is nothing to cancel later. Everyone else pays {YEARLY_PRICE} a year for
          the same two things. Scanning, your collection, decks, trades and backup stay free either way.
        </p>
        <div className="setrow">
          <div className="setrow__text">
            <span>Claim a founding place</span>
            <em>
              Card handled by Stripe — we never see the number. Your place is held while you pay, and released again if
              you change your mind.
            </em>
          </div>
          <button className="btn btn--primary btn--sm" onClick={go} disabled={busy}>
            {busy ? 'Opening…' : `${FOUNDING_PRICE} once`}
          </button>
        </div>
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
          <em>{YEARLY_PRICE} a year. Card handled by Stripe — we never see the number. Cancel any time.</em>
        </div>
        <button className="btn btn--primary btn--sm" onClick={go} disabled={busy}>
          {busy ? 'Opening…' : 'Subscribe'}
        </button>
      </div>
    </section>
  )
}
