import { useCallback, useEffect, useState } from 'react'
import {
  billingAvailable,
  FOUNDING_PRICE,
  REFERRAL_BOUNTY,
  REFERRED_PRICE,
  referralEarnings,
  startSubscriptionCheckout,
  subscriptionState,
  YEARLY_PRICE,
  type ReferralEarnings,
  type SubscriptionState,
} from '../lib/billing'
import { isSignedIn } from '../lib/authsession'
import { foundingOffer, type FoundingOffer } from '../lib/referral'
import { money, relativeAge } from '../lib/util'
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
  const [earned, setEarned] = useState<ReferralEarnings | null>(null)
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
    // Asked of everyone, subscriber or not: what you have earned by introducing
    // people does not stop mattering once you have paid.
    setEarned(await referralEarnings())
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
            and the AI deck builder are included — the rescue switched on with your subscription, and its switch under
            Scanning turns it off any time.
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
        {earned && <Earnings earned={earned} />}
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
          <b>AI deck builder</b> are yours permanently. In our 282-photo test set the rescue took identification from
          about 7 in 10 cards to about 9 in 10. It is a single payment and not a subscription: it does not renew, it
          does not run out, and there is nothing to cancel later. Everyone else pays {YEARLY_PRICE} a year for the same
          two things. Paying switches the rescue on for you; its switch, under Scanning, turns it off any time.
          Scanning, your collection, decks, trades and backup stay free either way.
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

  // Referred, but the hundred are gone: the middle price. Stated as a discount
  // off the standard one, because that is what it is and hiding the comparison
  // would make the number look arbitrary.
  const referredPrice = offer?.tier === 'referred'

  return (
    <section className="setsec">
      <h3>Subscription</h3>
      <p className="setsec__note">
        Scanning, your collection, decks, trades and backup are all free and always will be — including{' '}
        <b>50 cloud rescues</b> and <b>3 AI deck builds</b> a month. A subscription raises those to 1,000 and 12: the
        two things that cost us money to run.
      </p>
      <p className="setsec__note">
        The rescue reads the cards a camera can’t — worn faces, glare, foils, bad light. In our 282-photo test set it
        took identification from about 7 in 10 cards to about 9 in 10, and roughly doubled Pokémon reads. Subscribing
        switches the rescue on for you; its switch, under Scanning, turns it off any time. Ordinary scanning is never
        metered and never leaves this device.
      </p>
      {referredPrice && (
        <div className="audience audience--friends">
          <Icon name="heart" size={15} filled />
          <span>
            You came in through a friend’s link, so yours is <b>{REFERRED_PRICE} a year</b> rather than {YEARLY_PRICE}.
          </span>
        </div>
      )}
      <div className="setrow">
        <div className="setrow__text">
          <span>Subscribe</span>
          <em>
            {referredPrice ? REFERRED_PRICE : YEARLY_PRICE} a year. Card handled by Stripe — we never see the number.
            Cancel any time.
          </em>
        </div>
        <button className="btn btn--primary btn--sm" onClick={go} disabled={busy}>
          {busy ? 'Opening…' : 'Subscribe'}
        </button>
      </div>
      {earned && <Earnings earned={earned} />}
    </section>
  )
}

/**
 * What someone has earned by introducing people, and what is still owed.
 *
 * A FIXED BOUNTY, NOT A SHARE OF PROFIT. "A portion of the profit" cannot be
 * checked by the person earning it — profit per user depends on how much they
 * scan and is not known until long after. A flat amount per paying referral is
 * a number both sides can count.
 *
 * Founding purchases earn nothing, and the copy says so rather than leaving
 * someone to work out why a referral did not appear: a one-off lifetime fee has
 * no recurring revenue behind it to share.
 *
 * Renders nothing until there is something to report — an empty earnings panel
 * is an advert for a scheme, and this is meant to reward word of mouth rather
 * than solicit it.
 */
function Earnings({ earned }: { earned: ReferralEarnings }) {
  if (earned.referrals < 1) return null
  return (
    <div className="setrow">
      <div className="setrow__text">
        <span>
          You’ve introduced {earned.referrals} {earned.referrals === 1 ? 'subscriber' : 'subscribers'}
        </span>
        <em>
          {money(earned.earnedCents / 100)} earned at {REFERRAL_BOUNTY} each
          {earned.owedCents > 0 ? `, ${money(earned.owedCents / 100)} still to come` : ' and paid'}. Up to{' '}
          {earned.cap} referrals count; founding places earn nothing, since a one-off fee has no yearly revenue to
          share.
        </em>
      </div>
    </div>
  )
}
