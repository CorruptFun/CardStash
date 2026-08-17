# Marketing and informational material

The landing page lives in `marketing/index.html`. `npm run build:marketing` inlines
the three font subsets it sets and writes a single self-contained file to
`marketing/dist/` (gitignored — it is build output, and the base64 fonts alone are
~225 KB that would otherwise land in every diff).

The page leads with what Cardstock does for a collector — scan a card, watch a
collection become a portfolio, share it to trade — and treats an account as the
payoff rather than the price of entry. It deliberately carries no architecture:
no test counts, no upstream catalog list, no cache or bundle detail. That material
belongs in the chapters, not in front of someone deciding whether to try the app.

**If you change a claim on the page, change it here first** — the point of this file is that the copy has a source, and that a
claim which can't be traced to a file doesn't ship.

## The name

**Cardstock**, everywhere a person can see it. The repository and its folder are
called CardStash for historical reasons; that is not a second brand and must not
appear in copy. `docs/roadmap.md` §7 lists the rest of the naming cleanup.

Do not print a version number in marketing copy. `src/lib/version.ts` reads 0.17.0
while messaging, custom binders, page scanning and printed QR labels all shipped
after it, so the number understates the product rather than dating it.

## The position

**The conversion goal is an account.** Everything the app does works signed out and
must keep working signed out — that is an architectural guarantee in `CLAUDE.md`,
not a marketing choice — but the page is built to move a reader toward creating
one, because an account is what makes a collection recoverable and a collector
findable.

Those two facts are not in tension, and the copy must not pretend they are. The
page leads with the outcome (scan → collection → portfolio → share), and the
account section is the payoff rather than the entry fee. `docs/privacy.md` states
the obligation that comes with it: *"Signed in, there is also a copy on our server,
and it is not optional."* Say that plainly, on the page, next to the pitch.

The honest reasons to sign in, in the order the page uses them:

1. **It backs itself up as you go** — no switch, no passphrase, and a second device
   pulls the collection down on its own (`autobackup.ts`, `cloud.ts` `syncNow()`).
2. **A handle people can trade with** — friends add you by typing it, their binders
   refresh themselves, and offers arrive in the app (`socialcloud.ts`).
3. **Global want matching** — the one capability a shared link genuinely cannot
   provide, because it needs an index across every publisher (`match_wants`).
4. **Messaging a collector directly** — and this stays free, for the reason
   decision 25 gives.

There is no sign-up step: an email address *is* the account, a six-digit code
signs you in, and `SignIn.tsx` must never grow a "Create account" branch.

### How we are not allowed to sell it

- **Never "your data isn't saved."** It is false — cards are in IndexedDB and
  survive a reload — and `onboarding.ts` records why the falsehood is expensive: a
  warning a user can disprove gets dismissed reflexively for the rest of the
  product's life. Generalise the rule: never make a claim closing and reopening the
  app would disprove.
- **No fear-based framing.** Decision 25 is explicit that "don't get scammed" is a
  threat dressed as a feature, and that the free path must never be made to feel
  like the one we disapprove of. The same applies to accounts: sell what an account
  *does*, never what losing your phone would feel like.
- **The iOS eviction story is iOS-only, and has a "but."** WebKit clears storage for
  origins unopened for about a week, and installing to the Home Screen starts the
  app with *empty* separate storage — so an install prompt without a backup step is
  a data-loss trap. Do not compress this into "browsers delete your cards."
- **A handle is permanent.** Disclose it where the reader chooses one; it can never
  be changed or transferred (decision 21).
- **A handle alone does not make you reachable by strangers.** Inbox and messaging
  need an accepted friendship, a published for-trade binder, or a prior message.
  Never write "anyone can send you an offer the moment you have a handle."
- **Never fabricate a founding-seat count.** It comes from the server, only for
  accounts the server agrees were referred.

## What the page claims, and what backs it

| Claim | Backed by |
|---|---|
| Nine trading card games, plus sports | `src/lib/games.ts` (`GAMES`) |
| Scan, then one tap to add | `src/views/ScanView.tsx`, `src/lib/db.ts` (`addToCollection`) |
| Twelve cards from one binder-page photo | `src/lib/multiscan.ts` (`MAX_PAGE_CARDS`) |
| The page a card was filed on is remembered | `src/lib/db.ts` (`addToBinder`), decision 27 |
| Graded slabs read off the label; a PSA 10 is its own copy | `src/lib/slab.ts`, decision 18 |
| Sealed stops counting at the sealed price once opened | `src/lib/prices.ts` (`opened`) |
| Cards no catalog has can be photographed and described | `src/lib/cardpatch.ts`, decision 22 |
| Foil and non-foil priced apart, then adjusted for condition | `src/lib/prices.ts` |
| Cost basis, profit and loss, 30-day line, movers | `src/lib/portfolio.ts` |
| CSV import needs only a Name column | `src/lib/csv.ts` (throws when absent) |
| Share a binder as a link or a file; QR label on the spine | `src/lib/social.ts`, `qr.ts` |
| Want lists travel with a binder and match both ways | `src/lib/social.ts` (want keys) |
| Booking a trade updates both collections | `src/lib/db.ts`, `views/TradeView.tsx` |
| An email address is the account; a six-digit code signs you in | `src/lib/authsession.ts`, `components/SignIn.tsx` |
| Signed in, the collection backs itself up and syncs | `src/lib/autobackup.ts`, `cloud.ts` |
| Friends by handle, offers in the app, self-refreshing binders | `src/lib/socialcloud.ts` |
| Global want matching across every publisher | `match_wants`, `src/lib/socialcloud.ts` |
| Messaging a collector, and it stays free | `src/lib/messaging.ts`, decision 25 |
| Claiming a handle publishes nothing | `socialConfigured()` vs `socialPublishing()` |
| Export whenever you like, account or not | `src/lib/importexport.ts` |
| The rescue's paired benchmark (282-photo set, ~7 in 10 → ~9 in 10, Pokémon roughly doubled) | `docs/scanning.md` ("Where the numbers actually stand"), scan-harness lesson 85, the same sentence in `README.md` and `Subscription.tsx` |
| A subscription switches the rescue on at purchase; its switch turns it off any time | decision 2's auto-on amendment, `noteEntitlementSeen()` in `src/lib/billing.ts` |
| $11.99 a year / $9.99 a year referred / $6.99 once for the first 100 founding places | `src/lib/billing.ts` (`YEARLY_PRICE`, `REFERRED_PRICE`, `FOUNDING_PRICE`), `supabase/migrations/0014` |

## Claims we do not make

Each of these is false or unsupportable as written. They are listed because each
one is a plausible sentence somebody will eventually try to write.

- **"End-to-end encrypted" / "we can't read your collection" / "zero-knowledge" /
  "passphrase-protected."** The vault key is minted and held server-side
  (migration 0009, decision 15b). The approved phrasing is *encrypted at rest with
  a key held server-side; not end-to-end.* Note `docs/social.md`'s cloud-vault
  table is stale on this point and must not be used as a copy source.
- **"No image ever leaves your device."** True only with the qualifiers: the
  cloud rescue sends one frame, only for a card this device couldn't settle, and
  its switch is the sole authority over the image. Off by default on a free
  account — but never write "strictly opt-in" or "never switched on for you":
  **buying the subscription switches the rescue on**, once, the first time a
  device sees the entitlement, and the switch turns it off any time after with
  nothing flipping it back (decision 2's auto-on amendment, `noteEntitlementSeen()`
  in `billing.ts`). The point-of-sale copy discloses the flip before the money
  moves; the page must not contradict it in either direction.
- **"Bring your own AI key."** There is no key field; the deck builder calls our
  hosted function, so it needs an account — a free monthly allowance of builds,
  raised by a subscription, never a hard subscription gate.
- **"Buy and sell cards."** Escrow ships off in the deployed build — both
  `VITE_MARKETPLACE` and `MARKETPLACE_ENABLED` (decision 19). Only Ask is live.
- **"Public binder", implying the open web.** It means any signed-in collector.
  A binder readable by `anon` is one anybody with the publishable key can
  enumerate, which is what `trade_offers` refuses to be (decision 26).
- **"Social is encrypted."** Published binders are plaintext to us by necessity —
  a friend's app has to read them. Messages likewise, and the composer says so.
- **"No telemetry."** Diagnostics are content-free but on by default outside the
  EU, EEA and UK, where consent is asked instead (decision 20).
- **"Prices for every card."** Sports and user-authored custom cards carry none.
- **Premium framing for photo upload or page scanning.** Every row in `GATED`
  (`src/lib/entitlement.ts`) is currently false; whether they become paid is an
  open product decision.

## Numbers

Safe to quote, because they are counts of what is committed: **289** real
photographs (44 MB) under `tests/harness/photos/`, **18** seeded camera
degradations (`tests/harness/augment.mjs`), **427** unit test cases across **41**
files (the runner's own count), **20** npm test entry points, **6** upstream
catalogs, **~265 KB** gzipped app bundle, card-art cache capped at **480** images
(`src/sw.js`).

**One identification number is quotable, and in exactly one shape: the paired
before/after, anchored to its test set.** "In our 282-photo test set the cloud
rescue took identification from about 7 in 10 cards to about 9 in 10, and roughly
doubled Pokémon reads" — scan-harness lesson 85, reproduced twice; the README and
`Subscription.tsx` carry this sentence already, so reuse it verbatim rather than
re-deriving or re-rounding it. The exact fractions of record are 196/282 →
250 and 249 of 282, Pokémon 49/117 → 99–100/117 (`docs/scanning.md`, "Where the
numbers actually stand") — rounded **down** when sold, a result on that test set
and never a guarantee, and never upgraded to the collector-line door's higher
pair (269–271/282): measured, but not the sold line. The pairing is what keeps
it honest: both figures come from the same battery, so what is claimed is the
*lift* the rescue adds, never a level the scanner hits. Detached from its anchor
— "90% accurate", "identifies 9 in 10 cards" — it becomes a universal accuracy
claim, and **a lone rate quoted as the app's accuracy stays banned**: the
batteries disagree on purpose — rendered fixtures 197–198/282 (~70%) offline,
hand-curated photographs 4/12, handheld clips 10 wrong in 40 — and
`docs/scanning.md` states outright that a battery of stills cannot bound a live
scanner's wrong-card rate. Quoting the flattering one alone is precisely the
overstatement the docs name.

There are no honest numbers for users, installs, retention, cards searchable, or
scan latency. Budgets in `identify.ts` are ceilings, not measured times: "scans in
7 seconds" would be false.

## Free, account, subscription

The page carries this as a table, and the wording matters in two places.

- **No account:** scanning, collection, decks, portfolio, binders and printed
  labels, CSV/JSON in and out, and all link or file sharing. Offline throughout.
- **Free account:** automatic backup and multi-device sync, `@handle` identity that
  survives the device, friends by handle, offers in the app, self-refreshing friend
  binders, global want matching, messaging, publishing binders, invite links — plus
  a monthly allowance of AI deck builds and cloud scan rescues.
- **Subscription:** raises those two allowances, and switches the rescue on at
  purchase — once, first sight of the entitlement; the switch under Scanning
  turns it off any time and nothing flips it back (decision 2's auto-on
  amendment). Nothing else moves.

**Prices are printable; allowance figures are not.** The three prices are live in
Stripe and mirrored exactly once in `src/lib/billing.ts` — `YEARLY_PRICE` $11.99,
`REFERRED_PRICE` $9.99 a year for an account the server agrees was referred, and
`FOUNDING_PRICE` $6.99 **once** for one of the first 100 founding places
(referred accounts only; migration `0014` and `stripe-billing` decide it). Quote
them from those constants and nowhere else — they move when Stripe's do — state
the founding price as the one-off it is, and never print a seats-remaining
count: that number is the server's, and only `Subscription.tsx`, which asks for
it, may show one. The allowance figures stay **off the page**: they are
defaulted environment variables on the deployed functions, so the page sells the
idea — "monthly allowance", "higher allowance" — and Settings states the
numbers. Escrowed purchase is not sold at all: it ships off in both switches.

## Copy sources that are stale

Do not source copy from these — each is superseded and each would produce a claim
we have banned above:

- `docs/social.md`'s cloud-vault table — still says "ciphertext the server cannot
  read" and "your passphrase, never uploaded". Superseded by decision 15b.
- `src/lib/cloudconfig.ts`'s header comment — same passphrase claim.
- `docs/decisions.md` §14 ("no cloud copy, no account") — superseded by 15b.
- `src/components/Welcome.tsx`'s "Welcome back" step, which tells a returning user
  to restore from a backup in Settings and understates the automatic pull.

These are app-copy bugs rather than marketing ones, but they are listed here
because this chapter is where somebody looks for a sentence to reuse.
