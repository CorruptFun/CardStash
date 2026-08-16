# Decisions

The load-bearing choices, why they were made, and what they cost. If you are
about to undo one of these, this is the argument you need to beat.

---

### 1. No backend, ever, in the deployed product

**Why.** No accounts to build, no data to hold, no hosting bill, no privacy
surface. A static bundle on GitHub Pages plus IndexedDB is the whole product.

**Consequences.** Sync between a user's own devices is manual (backup files or
the optional server). There is no server-side price aggregation or cache, so
every device talks to the card APIs itself. Rate limits and dying APIs are
therefore an app-level concern — hence the budgets, fallbacks and stale-beats-
broken caching in [card-data.md](card-data.md).

---

### 2. The free scan path is fully on-device; the cloud is an opt-in rescue

**Why.** A cloud-vision scanner would be more accurate out of the box, but
making it *the* scanner would mean shipping camera frames to a third party,
needing a key to work at all, and being useless offline. "Point your camera at a
card" has to work on a train, on a first launch, with no account. That is still
the rule, and it is why the local pipeline is the one that gets the investment.

**Consequences.** A large, hard-won OCR pipeline (`identify.ts`, `ocr.ts`,
`vision.ts`, `corner.ts`) and the regression harness that keeps it honest. The
OCR engine is self-hosted (~11 MB of worker + wasm + language data) but
lazily fetched and runtime-cached, so devices that never scan never pay for it.

**What changed (v0.16).** There is now a cloud rescue, and it is deliberately
shaped so the sentence above survives it. It runs only when the user has
switched `cloudScanRescue` on, and only on a frame the local pipeline could not
settle — a full miss, or an answer of a shape measured to be confidently wrong
(guard invariants 12 and 13). A user who never opts in cannot tell the feature
exists. Signing in is not consent and neither is paying: the upload is its own
switch, because sending a camera frame somewhere is a different act from
subscribing to a tier.

"Could not settle" is the load-bearing phrase, and it is deliberately about the
ANSWER rather than about failure. A frame that produced a card can still have
settled nothing about which *printing* is in the hand: an MTG card whose
collector line never read is matched by fuzzy name, and a fuzzy name resolves to
one default printing — the ordinary frame, never the borderless one. So the
printing tie-break (invariant 13) uploads a frame the pipeline *did* identify.
That is a real widening of the boundary and it is written down here rather than
buried: the compensation is that it asks a strictly smaller question — which of
this card's printings, chosen from a list the client already holds, never which
card — it is checked first that there is more than one frame to choose between,
and it is off inside page scans. A tie-break that refuses leaves the local
answer exactly as it was.

**What changed again (the head-start round).** The rescue used to run strictly
last — after every band, every candidate lookup and the whole magnified
collector sweep, which on a hard frame is the best part of twenty seconds. For
a subscriber that is the wrong shape: the thing they pay for should race the
local passes, not queue behind them. It now starts on a **2.5-second timer**
(`CLOUD_HEADSTART_MS`) and runs alongside them, first answer wins, and a local
answer aborts the request in flight.

That is the second widening of the boundary on this page, and it is the wider
of the two: the printing tie-break above at least waits for an answer, while
this one fires on a scan that is merely SLOW — a card the local passes would
have got at four seconds now also sends its frame. Written down rather than
buried, same as the first. What remains true, and is what the switch actually
buys: nothing is uploaded unless `cloudScanRescue` is on, nothing goes before
the deadline, and a raced call is rationed (`CLOUD_RACE_COOLDOWN_MS`) so one
stubborn card in front of the lens cannot spend the month's allowance by
itself. The last-resort call — every local pass failed — is deliberately NOT
rationed; that is the case the rescue exists for.

The Gemini boundary moved with it and is now stated precisely rather than
absolutely: the key is scoped to the AI deck builder **and** the scan rescue,
and to nothing else.

---

### 2a. A first-party backend is the entitlement authority

**Why.** CLAUDE.md listed three honest options for where a paid tier's
entitlement could live — client-side flag, third-party check, first-party
backend — and the third is now chosen. The first is a suggestion rather than an
authority (a flag in localStorage is one devtools tab from being true). The
second puts a vendor between the user and their own camera. The third is the
only one that can also hold the thing that actually costs money: the model key,
and the meter that counts a subscriber's scans.

That backend already exists for other reasons — the same Supabase project that
carries the cloud vault and hosted social — so this adds a table and an edge
function rather than a new tier of infrastructure.

**Consequences.**

- **The server decides, and the client does not pre-check.** `scan-card` reads
  the caller's entitlement and allowance itself; `identify.ts` sends the frame
  and believes the answer or the refusal. A client-side entitlement check would
  only add a way to be locally wrong about it.
- **`entitlement.ts` stays the seam, and stays honest.** `cloud-scan` is the
  first feature in that table to be gated at all. `photo-upload` and
  `page-scan` remain ungated — whether *those* become paid is a separate
  product decision, and the table exists so it can be made in one place.
- **The free path still works offline with no account, and that is the
  invariant this decision is written to protect.** The backend is the authority
  on a *paid extra*, never on scanning itself. If the project is unreachable,
  or the user has no account, or the tier lapsed, the local pipeline answers
  exactly as it always did. Nothing about entitlement is allowed to gate
  `detectCardRegions` or any other shared primitive (CLAUDE.md), and analytics
  stay content-free regardless of subscription state.

---

### 3. The collector line is a first-class identifier

**Why.** Names defeat OCR regularly — ornate faces, foil glare, and any card not
printed in Latin script. But every print worldwide carries Latin digits in its
collector line.

**Consequences.** Cards in any language identify without a multilingual OCR
model. It also created the worst failure mode in the app: collector numbers are
dense, so a one-digit misread lands on a *real neighbouring card*. Hence the
guard invariants — a printed slash actually read, independent catalog/API
agreement, set-size verification, fail-closed refusals. **A refusal is a correct
answer here; a confident wrong card is not.**

---

### 4. Confident wrong answers are worse than misses

**Why.** In collect mode a wrong identification silently adds the wrong card at
the wrong price to someone's portfolio. A miss just asks them to try again.

**Consequences.** Every retrieval tolerance is paired with a quality-scaled
acceptance bar; the matrix tracks `wrong-card` as its own stage; turned frames
face a stricter bar than upright ones. The one time tolerance was loosened
without guards, honest misses became 16 confident wrong cards in a single run.

---

### 5. USD only

**Why.** One market (US/English), one currency, one number the user can trust.
Mixing Cardmarket EUR into the same figures produced totals that were neither.

**Consequences.** `'EUR'` survives in the `Currency` type purely so that data
written by pre-0.5 versions can be *filtered out* rather than mislabelled.
Every price reader recomputes from `entries` instead of trusting a stored
headline. Don't reintroduce EUR into maths or UI.

---

### 6. Social is serverless by default; sync is an overlay

**Why.** A share *is* the data — a deflate+base64url payload in a URL fragment,
or the same JSON as a file. Nothing is published anywhere unless the user hands
it to someone. That keeps the no-backend promise intact for the most obviously
"social" feature in the app.

**Consequences.** Links get long (hence the file route past ~20k chars) and
refresh is manual unless the friend hosts their snapshot somewhere. The optional
sync server exists for playgroups who want live updates — but with `syncOn`
false, nothing in `sync.ts` runs, and everything a server returns is
re-sanitized through the same code path as a pasted link. Links and files must
never become second-class.

---

### 7. Everything decoded from outside goes through one sanitizer

**Why.** Links, files, backups and server responses are all untrusted input with
the same shape. Two validation implementations means one of them is weaker.

**Consequences.** `social.ts` owns the sanitizers, and `db.ts`'s backup import
calls them rather than duplicating the rules. Caps, length limits, enum
validation and `https`-only images apply identically whichever door the data
came through.

---

### 8. A hand-written service worker

**Why.** The caching requirements are unusual enough that a plugin's defaults
would fight them: the OCR engine must be runtime-cached but never precached;
price APIs must never be cached; the shell must be all-or-nothing for *critical*
assets but tolerant of a missing icon; opaque responses need special handling.

**Consequences.** `src/sw.js` is ~260 commented lines that must be read before
being edited. Its behaviours exist for named failures: no `skipWaiting` (a
mid-session activation strands the running bundle), `ignoreVary` everywhere
(vite preview's `Vary: Origin` made every precache lookup miss), critical-asset
gating on install (a half-installed shell is a permanently blank offline
launch), and a `cors` re-request in the ext cache (an opaque 403 and a 12 MB
payload are the same object).

---

### 9. `main` is source; `gh-pages` and `harness-fixtures` are machine output

**Why.** This repo originally carried *build output only*, and the source lived
in ephemeral sessions until it was lost. The tree was reconstructed from a
deployed bundle. That must not happen twice.

**Consequences.** `dist/` is gitignored, CI regenerates and force-pushes
`gh-pages` on every push to `main`, and the fixture branch is likewise
force-pushed and never merged. Merging to `main` *is* deploying. The
corresponding discipline: always push source before a session ends.

---

### 10. Dark-only, mobile-first, one stylesheet

**Why.** The scan screen is a camera viewfinder — a light theme fights it. The
whole product is a phone product. One stylesheet with tokens beats a component
library for an app this size, and keeps first paint instant (the critical
styles are inlined in `index.html`).

**Consequences.** No theme toggle, no CSS-in-JS, no design-system dependency.
A 5k-line `styles.css` that new work extends with tokens rather than inline
values.

---

### 11. Optional keys, never required

**Why.** The app must be fully usable with zero configuration. Keys buy
*more* — higher Pokémon rate limits, the AI deck builder — but never gate the
core loop.

**Consequences.** Every key path has a keyless fallback: pokemontcg.io works
unauthenticated (and falls back to TCGdex when it's down), and the builder
simply isn't available without a Gemini key. Telemetry needs both an explicit
opt-in and a token, so it can never be on by accident.

---

### 12. Data caches are honest about being incomplete

**Why.** A partial catalog cached for a day makes real cards read as "doesn't
exist" — a failure that looks exactly like a bug in matching.

**Consequences.** Catalog and group-index loads track completeness. An
incomplete result is served immediately (better than nothing), memory-cached
*backdated* so it retries in five minutes, and **never persisted**. A total
failure falls back to a stale cache rather than an error screen. Cache-shape
versions (`CATALOG_VERSION`, the `v2` group key, the `IMG`/`EXT` suffixes) exist
so a bad cache is fixable by shipping a deploy.

### 13. The paid tier has a seam, but no authority

**Why.** Photo upload and binder/multi-card scanning are intended to become a
paid subscription. Neither is gated today, and neither should be while it is
still being built — but retrofitting a gate across call sites later is how you
end up gating the wrong thing.

**Consequences.** `lib/entitlement.ts` is a `GATED` table with every row `false`
and one `isEntitled()` check. Flipping a row is the whole change. It
deliberately reads and writes **no** settings: nothing stores an entitlement
yet, and inventing storage for one would pick an answer to the open question
below by accident.

The seam sits on **entry points** — the upload control, the page-scan path — and
**never on `detectCardRegions`**. That primitive is shared with ordinary
single-card detection on cluttered backgrounds, which is the free path and the
dominant real-world failure. Gating the detector would quietly degrade free
scanning for everyone who never buys anything.

**Still open, and deliberately so.** Entitlement has no home in this
architecture. The deployed app is a static `gh-pages` bundle with no backend,
and `server/` is a sync box the *user* hosts, so it can never be the authority
on whether that same user has paid. Three honest options, ordered by how well
they preserve local-first:

1. **Soft/client-side gating** — a settings flag, trivially bypassed via
   devtools. Fine if the subscription is support rather than enforcement. No
   backend, stays offline-first.
2. **A third-party entitlement check** (Stripe/RevenueCat/similar) at launch,
   result cached, app fully usable offline afterwards. Introduces the first hard
   network dependency — decide deliberately what happens when it is unreachable,
   and make that *keep working*, not *lock out*.
3. **A first-party backend** — contradicts decision 1 and is a much larger
   change.

Whichever is chosen: scanning keeps working offline, and analytics stay
content-free. Subscription state is not a reason to start sending card data
anywhere.

---

### 14. One device holds everything, and nothing yet moves it

**Decision.** A user's collection lives in exactly one place: IndexedDB on the
device that scanned it. There is no cloud copy, no account, and no sync unless
the user stands up `server/` themselves. The only way data leaves a device is
Settings → Export, by hand.

**Why it is written down.** This is the load-bearing consequence of decision 1
(no backend), and it is the one users feel. It has two costs that are easy to
discover the hard way:

- **Loss.** A lost, wiped or reset device takes the collection with it. On iOS
  the bar is far lower, and the shape of it matters: WebKit evicts
  script-writable storage for an origin unused for ~7 days, `persist()` is
  granted only to Home Screen web apps, **and** a Home Screen web app gets
  storage partitioned away from Safari. So durable storage on iOS requires
  installing, and installing starts from an empty collection. There is no
  in-app path from one to the other — only export → install → import, by hand.
  `InstallPrompt.tsx` (v0.12.0) walks the user through exactly that, but a
  three-step manual migration is a workaround for a missing capability, not a
  solution to it.
- **One device.** Scanning is a phone job; organising a large collection is a
  desktop job. Today those are two unrelated collections, because nothing
  carries rows between them. The app is a fine desktop *app* already — it is a
  responsive PWA — but it is not the *same* collection.

**Option 2 is chosen and half-built (2026-08-14).** `lib/drive.ts` backs the
collection up to the user's own Google Drive `appDataFolder`, daily and
automatically, with the last five kept. It holds the local-first line exactly:
the browser talks to Google directly, we host and store nothing, and the free
tier gains **no dependency on any backend of ours** — a property that must
survive the arrival of hosted sync, because a user who never signs up for
anything still deserves their collection protected.

**It closes half of the iOS trap, and the honest accounting matters.** It removes
the file handling and the "remember to export" discipline, so a restore path
exists that does not depend on the user keeping track of a download. It does not
make the migration automatic: an installed PWA is a different storage partition,
so the user signs in to Drive again on the other side. Export → install → import
becomes sign-in → install → sign-in → restore. Nothing in the web platform closes
the rest; that is the App Store note below.

**Options, ordered by how well they preserve local-first.**

1. **Export/import by hand** — what exists. Zero infrastructure, zero accounts,
   and it works offline. Costs the user a deliberate act they must remember,
   and it is the *only* thing standing between an iOS user and losing
   everything at the moment they follow our own advice to install.
2. **User-owned cloud storage** (Google Drive `appDataFolder`, Dropbox,
   OneDrive). The browser talks to the provider directly; the app hosts and
   stores nothing, and the data sits in the user's own account rather than
   ours. Solves backup *and* multi-device in one move without contradicting
   decision 1. Costs: an OAuth client id, provider review for the scope, and a
   conflict rule for two devices edited offline. Best fit on current evidence.
3. **The existing self-hosted `server/`** — already built and already syncs,
   but only for users willing to run a server.
4. **A first-party backend** — contradicts decision 1.

**On shipping to the App Store.** Worth being precise about what a native
wrapper does and does not buy, because it is easy to assume it settles all of
this at once. It solves **storage durability** (a native app's storage is not
subject to WebKit's eviction sweep), **discoverability**, and — via StoreKit
receipts — it is the first credible answer to the entitlement-authority problem in
decision 13. It does **not** solve backup, device loss, or desktop parity;
those still need option 2 or 3 above. And it adds a constraint: App Review
guideline 3.1.1 requires in-app purchase for digital features, so a paid tier
sold in the app cannot route around it. If the PWA keeps serving desktop while
iOS goes native, the two need to share a collection — which makes cross-device
sync a prerequisite of that plan, not an alternative to it.


---

### 15. The cloud vault is encrypted on the device, and that is not negotiable

> **SUPERSEDED 2026-08-15 by [15b](#15b-backup-happens-automatically-and-the-key-is-ours-supersedes-15).** The
> reasoning below still describes the cryptography accurately; what it got wrong
> was assuming people would set a passphrase. Zero of them did, and one lost a
> collection to that. The key is server-minted now, and the honest name for what
> ships is encryption at rest — not end-to-end.

**Why.** Decision 14 established that one device holding everything is a real
cost, and that iOS makes it acute. Fixing it means a server, which contradicts
decision 1 — so the contradiction is paid for as narrowly as possible: the
server stores a blob it cannot read. Sign-in (Supabase Auth) answers *who you
are*; a passphrase that never leaves the device answers *what the bytes mean*.
Collapsing those into one secret would hand whoever runs the project a
readable database of everyone's collections, which is precisely the liability
local-first existed to avoid.

**Consequences.** A second device is two steps, not one — sign in, then enter
the passphrase — and there is no reset, so the UI says so in as many words
rather than discovering it for the user later. The key is never persisted; a
reload asks again. `supabase/migrations/` is not setup, it is the lock: the
publishable key is public by design and RLS is the only thing standing between
it and the table.

**What this does not buy.** Entitlement. A Supabase login proves identity, not
payment, so decision 13 is untouched — though the same auth would be the
natural place to hang a real answer later.

---

### 16. Hosted social is plaintext, and scope is the privacy control

**Decision (2026-08-14).** Social moves onto the same Supabase project as the
vault — accounts, handles, mutual friends, a trade inbox, global want-matching
(`supabase/migrations/0001`–`0004`). The self-hosted `server/` box is
superseded. Links and files stay first-class, and decision 6 survives intact:
signed out, nothing about the link path changes.

**Why it cannot be encrypted like the vault.** Decision 15 is that the server
holds ciphertext it cannot read, and for a user's own collection that is not
negotiable. Social inverts the requirement: a friend's app has to *read* your
binder, so the server has to serve something readable. The choice was to weaken
the vault to reach social, or to give social its own narrow plaintext table.
The second, obviously — `binders` holds only what the user chose to publish,
which is the identical document that already travels in a share link today.
The vault is untouched, either feature runs without the other, and
`erase_social()` deliberately leaves `vaults` alone.

**Why scope is the control.** Rather than adding a second privacy toggle beside
the existing For trade / Everything switch, that switch *becomes* the
visibility rule: a `trade` binder is readable by any signed-in user (you
published cards you want to swap — being findable is the point, and it is what
makes global matching possible at all), an `all` binder only by accepted
friends (a full inventory is a valuation and theft target). One control, no
chance of the two disagreeing.

**Consequences.**

- **Identity becomes recoverable**, which is the single biggest win. Today's
  `profileId` is a localStorage uid: clearing storage destroys it permanently
  and orphans every follower. Do not reintroduce trust-on-first-use.
- **We now hold readable user content**, which the project did not before.
  That makes retention, a deletion path and `privacy.md`'s egress table real
  obligations rather than theoretical ones.
- **A LAN playgroup loses the no-account live tier.** That was a genuine
  property of `server/` and hosting does not replace it; links still work, so
  the floor is unchanged, but this is a real cost and not a pure upgrade.
- **`trade_offers` is never readable, only queryable.** An index of who owns
  what must not be enumerable — it is reachable solely through a capped
  `match_wants()` RPC. That is a lookup oracle, not perfection, and the
  distinction is deliberate.

**What would make this wrong.** Publishing anything the user did not choose to
publish; letting a friends-only binder become globally matchable through the
offers index; or gating the link path behind an account. The first two are
covered by tests that must keep passing.


---

### 17. Sports cards are synthesized from the card, not looked up

**Context.** Every game in the app resolves against a catalog. Sports has none
that is free: TCGplayer carries no sports singles (so the TCGCSV path is
empty), and SportsCardsPro/PriceCharting, CardHedge and Beckett are all paid
products. The choice was between making sports depend on a paid API, shipping
nothing, or identifying cards from the cards themselves.

**Decision.** Identify from the card. `sportsparse.ts` reads year, brand,
product, card number, player, team, parallel, serial and RC/auto/relic out of
OCR text; `sports.ts` synthesizes a `Card` with a deterministic slug id. There
is no sports price feed on the free path — value is the collector's own
`marketValue`, informed by an eBay sold-comps link built from the full
attribute set.

**Why this way.** It is the only option that keeps the promise the rest of the
app is built on: signed out and offline, everything works. A paid API would
have made sports the first feature in the product that stops working when a
subscription lapses or a vendor changes terms, in an app whose entire premise
is that your collection is yours and local.

It also inverts the failure mode, which is the part to keep in mind. A TCG
misread picks the wrong *real* card; a sports misread invents one, and nothing
downstream can tell it is fictional. Three guards answer that, and they are
load-bearing rather than decorative: a confidence floor
(`MIN_SPORTS_CONFIDENCE`), closed vocabularies instead of open guessing, and —
most importantly — **sports never joins the auto-mode sweep**. Auto mode
synthesizing a card for anything it failed to match would manufacture
confident wrong answers at scale.

**Consequences.**

- **Sports requires picking the game.** Same shape as collector-line rescue.
  This is a real UX cost and the right trade.
- **`sportsSlug` is a wire format.** Devices agree on a card only by computing
  the same slug from the same facts. Changing it renames every sports card
  anyone owns.
- **The collection is the catalog.** Search is local recall over cards this
  device has already seen, so it starts empty and grows. No new Dexie table —
  the full `Card` is already stored on collection rows and scans.
- **Portfolio totals for sports are user-authored.** The app reports what the
  collector entered and nothing else. That is honest, and quietly inventing
  numbers about someone's money would not be.

**What would make this wrong.** A genuinely free, openly licensed sports
catalog appearing — then this becomes an adapter like any other and the
synthesis path should retire to a fallback. Short of that, the failure mode to
watch for is guard erosion: lowering the confidence floor, letting sports into
the sweep, or widening the vocabularies into open-ended guessing. Any of those
turns honest misses into invented cards.

---

### 18. A grade belongs to the copy, not to the card

**Context.** Slabbed cards needed representing, and a PSA 10 is worth a
multiple of the same card raw. The tempting shortcut is to treat a graded card
as a different card.

**Decision.** `GradeInfo` lives on `CollectionItem`, never on `Card`. The card
is the printing; the grade describes the object in the holder. Grade joins the
row merge key so a PSA 10 never merges into the raw row — but the **cert does
not**, because two PSA 10s of the same card are interchangeable.

**Why this way.** Folding a grade into the card id would fork the catalog: the
same printing would exist eleven times, each with its own price history and
none of them matching what the price APIs return. Keying rows by cert would
fragment a collection into one row per physical object, which is a spreadsheet,
not a collection.

**Consequences.** Grading is available to **every** game, not just sports,
which is right — graded Charizards are a larger market than most of the TCGs
here. Grades travel on `SharedCard` so a trade shows what it really is, and
`sanitizeGrade` in `slab.ts` is the single validator both the backup path and
`social.ts` use.

**What would make this wrong.** Wanting per-cert provenance (which slab, bought
when, sold to whom). That is a different feature — an item-history log — and it
should not be built by turning the cert into an identity.


---

### 19. Paid trades run on Stripe, and the money is never ours to hold

**Context.** Trading only works when both people want something the other has.
When one side has nothing the other wants — or lives too far for a swap to be
worth the postage — the trade dies. Letting one friend *buy* from another fixes
that, but it needs somewhere to hold the buyer's money between "paid" and "it
arrived", and that somewhere is the whole design problem.

**Decision (2026-08-15).** A friends-only marketplace on **Stripe Connect**,
using separate charges and transfers: the buyer is charged to our platform
balance under a `transfer_group`, and a Transfer to the seller's connected
account is created on release. `orders` and `seller_accounts`
(`supabase/migrations/0006`) are the interface; `supabase/functions/stripe-escrow`
is the only code in the repo that knows what Stripe is.

**Why not Square, which we already use.** This was researched before anything
was written, because the obvious move was to reuse the existing rail. Square
cannot do it, for three independent reasons: auth-and-hold caps at **7 days**
card-not-present, shorter than posting a card and inspecting it; the Payouts API
is read-only *reporting* about money reaching your **own** bank, not a way to
pay a third party; and `app_fee_money`, its only marketplace primitive, requires
the seller to already be a Square merchant and pays them **instantly**, which is
the opposite of escrow. Square keeps the subscription (`square-billing` →
`entitlements`). The two providers share no code and no table, which is the same
separation `square-billing` already argues for — a provider belongs in exactly
one file, and the table is the interface.

**Why Stripe specifically, and not us.** Holding a buyer's funds and later
disbursing them to a seller is money transmission in most US states unless a
licensed party holds the funds. Connect exists for this: **Stripe is the
custodian and we only direct the release.** That is a legal position as much as
a technical one, and it is the reason "just hold it in our own account" — which
Square could almost have done — was never on the table. Stripe also prohibits
peer-to-peer money transmission while permitting marketplaces selling goods, so
an order always references a specific card at a specific price and there is no
arbitrary-amount path anywhere in the schema. **A lawyer still has to look at
this before real money moves** (marketplace facilitator sales tax, 1099-K).

**Consequences.**

- **A fourth opt-in cloud feature, and it ships OFF.** Two switches, both
  currently off: `VITE_MARKETPLACE` hides the UI, and `MARKETPLACE_ENABLED` on
  the edge function refuses to open an order or start onboarding. Only the
  second is a real defence — a constant in a static bundle is one devtools tab
  from being true — but shipping a Buy button the server would refuse is its own
  bug, so both exist and both must be turned on, **server first**.

  Being dormant *by accident* was the state before those flags, and it was not
  good enough: nothing stopped a purchase except that no seller could finish
  Connect onboarding, so the day Connect is enabled for any reason, buying would
  quietly go live. A switch that unrelated progress can flip is not a switch.

  **The kill switch stops new business and lets existing business finish.** With
  it off, `/onboard` and `/checkout` refuse, while shipping, confirming,
  refunding, the webhook and the sweep all keep working. An order that was paid
  for when the switch flipped must still reach an end; stranding someone's money
  because a flag changed would be the worst possible reading of "off".

  In-person trades are untouched by any of this, always. Signed out, nothing
  changes: scanning, collection, decks and link sharing still never touch a
  server.
- **The state graph lives in `advance_order()` and nowhere else.** Mirroring it
  into `logic.ts` for easier node testing was tempting and rejected: two
  authorities on a money state machine disagree eventually, and the loser is
  always the one not guarding the row. `logic.ts` decides what a Stripe event
  *means*; SQL decides whether that is allowed; `tests/harness/escrow-rls.mjs`
  proves the edges against real SQL rather than against a copy.
- **Nobody writes an order through PostgREST.** Not the buyer, not the seller.
  A buyer who could UPDATE would mark their own purchase delivered and collect a
  stranger's money; `seller_accounts.stripe_account_id` is where money *goes*,
  so a user who could write another's row would redirect their payouts. Money
  transitions are `service_role` only; ship/confirm/dispute are the users' and
  check who is asking.
- **Shipping addresses are never stored, anywhere.** Stripe Checkout collects
  one, it stays on the session, and the seller's app fetches it per request. In
  Dexie an address would ride into the JSON backup, the CSV export and the daily
  Drive backup; on the server it would be plaintext PII beside `binders`. This
  is the rare case where the privacy-preserving option is also less code.
- **Orders outlive accounts.** `buyer`/`seller` are `on delete set null`, not
  `cascade`, and `erase_social()` does not touch `orders`. A completed sale
  backs a 1099-K, a chargeback response and a tax return, none of which stop
  being true because someone closed their account. An orphaned row keeps no
  name, handle or address — two nulls and an amount — and RLS hides it from
  every user, since a null never equals an `auth.uid()`.
- **A flat percentage would lose money.** Stripe takes 2.9% + 30c and we pay it
  (`fees.payer = application`), plus 0.25% Connect, $1.50 per payout and $15 per
  dispute. 8% of a $5 card is 40c against 44.5c of cost. Hence a $5 order floor
  and a $1 fee floor, and connected accounts on weekly/manual payouts so sales
  batch into one payout.
- **Disputes are resolved by a person.** Deciding whether a card arrived as
  described is not something the schema can know, and a coin flip dressed as
  arbitration would be worse than admitting someone has to look.
- **We now carry liability we did not before** — chargebacks, negative balances
  and fraud between users are ours under `losses.payments = application`.
  Decision 16 said hosting readable user content made retention a real
  obligation; money makes it a financial one.

**What would make this wrong.** Volume low enough that the fee floors read as
gouging on cheap cards, which would argue for making this friends-only forever
and free. Chargeback losses outrunning fee income, which would argue for
delivery confirmation being required rather than optional. Or wanting an open
marketplace — that is not a bigger version of this, it is a different product
with listing moderation, seller reputation and counterfeit disputes attached,
and the friends-only scope is what keeps the current design honest.

### 15b. Backup happens automatically, and the key is ours (supersedes 15)

**Context.** Decision 15 said the vault key is derived from a passphrase on the
device and called that not negotiable. It was right about the cryptography and
wrong about people. On 2026-08-15 this project held **zero** vault rows — not a
low number, none at all, across every user who had ever signed in — and that
same day a user lost a real collection to iOS storage eviction while the backup
that would have saved it sat behind a passphrase they had never set.

**Decision (2026-08-15).** Backup is automatic for anyone signed in. The key is
minted server-side on first use (`get_or_create_vault_key()`, migration 0009)
and there is nothing for the user to set, remember, or lose.

**Why the passphrase had to go, specifically.** Not because it was weak — because
it could not be a DEFAULT. A passphrase with no reset is unrecoverable by
construction, so switching it on for everybody would have converted "some people
have no backup" into "some people are permanently locked out of theirs". The
only safe default is a key we can reissue, and a key we can reissue is a key we
hold.

**What this is, stated so nobody has to infer it.** Encryption at rest with a
key we hold. It is **not** end-to-end and must never be described as something
the server cannot read.

- It DOES defend a leak of `vaults` alone — a dumped table, a stray backup file,
  a mistaken policy. Ciphertext without `vault_keys` is noise.
- It DOES isolate users: `get_or_create_vault_key()` takes no user-id argument
  (there is deliberately no such overload) and reads `auth.uid()` only. No role
  can `select` from `vault_keys` — not `anon`, not `authenticated`, not the
  owner of the row.
- It does NOT stop anyone with full database access decrypting a collection.

**Why not plaintext, since we can read it either way.** Because the two failure
modes are not the same size. Full database compromise is one event we would know
about; a leaked table, a misconfigured grant or an errant backup file are
ordinary and quiet. Separating key from ciphertext costs one table and turns the
common accident into a non-event.

**What survives from 15.** The merge is still pure and still the hard part
(`cloudmerge.ts`), sanitizers still run over anything decoded even though we
wrote it, and the JSON export still exists as the copy that needs no account at
all. Only the key's provenance changed.

**Costs.** We can read collections; the privacy page says so plainly rather than
implying otherwise. Automatic sync also means a device that has been away pulls
and pushes without being asked, which is a network cost users on metered
connections did not opt into — hence the debounce, and hence it never runs for
signed-out users at all.

**What would make this wrong.** Collections turning out to hold something people
genuinely need hidden from us — notes are the risk, not card names — which would
argue for encrypting a subset under a real passphrase and leaving the rest
automatic. Or a jurisdiction making us a data controller for inventory in a way
that plaintext-to-us triggers and E2E would not.

### 20. Diagnostics report to the app's own project, and consent is a separate fact from the switch

**Context.** The diagnostics log had collected on every device since it was
written and had never once uploaded — which was not a bug so much as a design
that could not succeed. `flushTelemetry` required `diagShare` **and** an
endpoint **and** a bearer token, and the endpoint and token were free-text
fields in Settings. No user has an ingest token for our server and none can
obtain one, so the switch above those fields could be turned on and still send
nothing, forever. A control that cannot succeed is worse than no control,
because it reads as a working one. The shipped default endpoint pointed at a
host that serves a different application entirely.

**Decision (2026-08-15).** The receiver is `public.ingest_events(jsonb)` on
**Cardstock's own Supabase project** — the one already carrying the vault,
hosted social and orders — defined in `supabase/migrations/0007_analytics.sql`.
The endpoint and token fields are gone; there is no diagnostics credential at
all.

**Why here rather than somewhere separate.** The alternatives were a self-hosted
box on our own hardware and a brand-new project. `docs/roadmap.md` §6 argues
against putting analytics in *the shared* project (`deskabqqxqqibxjffwmb`), and
that argument is sound — three apps' migration numbers already collide there.
It does not apply to a project this app owns outright with a baselined history.
The self-hosted box would have added a tunnel, a DNS record, a second uptime
story and a token to rotate, in exchange for nothing this needs. What survives
from the roadmap's objection is the blast-radius half — an anonymous firehose
sitting beside users' encrypted vaults — and the answer to that is the trust
model, not a second database.

**No new credential, deliberately.** It posts with the publishable key that
already ships in the bundle, as `anon`. A bearer token would have been equally
readable in the same bundle plus a second thing to forget. What actually defends
the receiver is SQL: the function is the only way in, it caps every batch (500
per call, 5000 per device per hour, 4KB per event), and RLS with no policy means
nothing but `service_role` can read a row back.

**The session JWT is never sent, and `device` must never become `auth.uid()`.**
Posting as the signed-in user would tie a content-free counter to an account,
which is the one thing this log exists not to do. `device` is a random
per-install id minted in `analytics.ts`. Nothing in 0007 references `auth.uid()`
for exactly that reason.

**Unknown event names are bucketed, never rejected.** A PWA keeps users on a
cached bundle until they accept an update, so a client predating a rename is a
permanent fact rather than an error. Rejecting its batch would lose the events
we *do* understand along with the ones we do not.

**On by default — and that is only honest because consent is a second field.**
`diagShare` now starts true, but `diagConsentAt` gates the upload independently:
nothing is posted until the disclosure has actually been shown, however the flag
came to be set. Where ePrivacy applies — EU/EEA/UK, detected from the browser's
own timezone, local and with zero egress — the banner *asks* instead and starts
false.

**Retroactive consent is not consent.** `noteDiagConsent()` advances
`flushedThrough` to the newest event as it answers, so an install that has been
collecting for weeks sends what happens *next*, never what happened before it
was asked. `merge()` in `settings.ts` forces any install predating the field
back to off rather than letting a new default opt it in silently. Without both
of those, flipping the default would have uploaded weeks of events gathered
while the answer was no.

**A receiver that 200s a payload it does not understand is worse than none.**
`flushedThrough` advances on any 2xx, so those events are lost permanently and
never retried. This is why the envelope is pinned in `privacy.md` and why the
function returns a count rather than raising — a caller sending nonsense gets 0
and no explanation, and diagnostics never become a way for the app to break.

**Costs.** Anonymous writes are the one deliberate hole in the schema, and they
have to be: diagnostics are collected before anyone signs in and most users
never will. Anyone can therefore post rubbish with a key read out of the bundle,
and the caps are the only thing between that and a full table. Analytics volume
now shares a database with users' vaults and orders, which is a blast radius
that did not exist before.

**What would make this wrong.** Volume high enough that the firehose threatens
the project the vault depends on — at which point the answer is its own project,
and the client change is one constant in `diagconfig.ts`. Or wanting per-user
analytics, which this schema deliberately cannot answer and should not be
retrofitted to; that is a different product with a different consent
conversation attached.

---

### 21. A handle is claimed once and never changes hands

**Context.** Identity has been the Supabase user since decision 16, and that
part was sound: an email address maps to exactly one account, GoTrue enforces
it, and signing in on a new device gets you back. The *handle* was not sound.
`set_profile()` upserted on `user_id` and overwrote `handle`, so renaming
released the old name for anyone to claim, and `erase_social()` deletes the
profile row, which released it too. `authenticated` also held UPDATE on
`profiles` with an `auth.uid() = user_id` policy, so a straight PATCH could do
the same thing without going near the function — the rule in the RPC was not a
rule at all.

The client made it routine rather than theoretical. The welcome screen asked
for a handle after **every** sign-in, prefilled from the email local-part,
without checking whether the account already had one. A collector signing in on
a second phone was shown "Pick a handle", tapped the only prominent button, and
renamed themselves — releasing the name their friends had saved, mid-trade.

**Decision (2026-08-15).** A handle is permanent. `set_profile()` refuses any
change (`handle_locked`) and only ever writes `display_name` thereafter, and a
`handle_claims` ledger — never deleted from — is the uniqueness authority
instead of `profiles`. `supabase/migrations/0010_handle_permanence.sql`.

**Why permanent rather than "changeable, old one retired".** Both close the
impersonation hole, and retiring-on-rename is friendlier to typos. Permanence
won on explainability: it is one sentence a new user can read at the moment of
choosing ("claimed once, yours forever"), it needs no cooldown, no rename UI and
no second copy explaining why an old handle will not come back, and it matches
what collectors already expect from a trading platform's `@`. The cost is real
and accepted — a typo is permanent, and repairing one is a maintainer task
requiring the trigger to be disabled by hand.

**A deleted account retires its handle forever.** `handle_claims.user_id` is
`on delete set null`, not `on delete cascade`: when the auth user goes the row
stays with a null owner, which nobody can match. "Nobody" is the only safe
answer to who inherits @rae after Rae leaves — the whole point of the ledger is
that a name never comes to mean a second person. Handle exhaustion is not a
real cost at this scale. The RLS harness therefore sweeps its own throwaway
handles explicitly, because a test account is exactly the case where the right
answer is the opposite.

**Enforced in three places on purpose.** The RPC refuses; `authenticated` loses
INSERT/UPDATE/DELETE on `profiles` so the RPC is the only door; and a trigger
refuses the update even from the table owner, so a later edit to the definer
function cannot quietly undo it. Any one of them alone is a comment.

**What the client had to change to make it true.** Enforcement stops the
damage; it does not make the flow make sense. So: sign-in now *looks up the
profile first* and a returning account goes to a "Welcome back, @rae" step with
no handle field anywhere near it; the handle field asks the server for
availability while the user types, because a permanent choice cannot be
rejected after the tap; and `hydrateIdentity()` pulls the handle onto a device
that has never seen it, since `socialHandle` is a localStorage cache and every
"are they set up?" check reads it. Without that last one a second device looks
identical to a new user — which is precisely the mistake that caused this.

**What would reopen it.** Wanting renames after all: the ledger already makes
that safe, so the change is a `rename_handle()` RPC that inserts the new claim
while leaving the old row standing, plus copy that is honest about the old
handle never coming back. Do not implement it by relaxing `set_profile`.

---

### 22. The user is a card source, and so are we

**The problem, stated plainly.** Every card in this app comes out of somebody
else's catalog, and those catalogs have two holes no amount of client work can
close. Rows with **no picture** — TCGCSV ships them constantly, promos and
Japanese prints frequently have none — and cards in **no catalog at all**:
regional promos, prereleases the APIs have not caught up with, error prints,
playtest cards, unlisted sealed product. The first looks like a broken app (a
binder of grey rectangles, with the name sitting right there). The second is
worse: the scan misses, search finds nothing, and the collection cannot hold
the card the user is physically holding. Neither has a fix that can be bought
or waited for, because nobody is coming to fill these gaps.

**The decision.** The user fills them. `cardpatch.ts` lets anyone attach a
photo and type what a card is, and that fix is a first-class card afterwards —
it scans, searches, sits in decks, rides the backup and the vault. And the
fixes people choose to contribute pool into `card_data` on our own project
(migration 0013), so the next person to scan that promo gets the answer for
free. That is the whole ambition of this one: an app that was a consumer of
five catalogs becomes a source of card information in its own right, out of
work its users were already doing for themselves.

**Overlay, not replacement, and that is the load-bearing shape.** A patch lays
over the catalog's card instead of forking it. Prices keep refreshing
underneath, an upstream correction still lands, only the changed keys are
stored, and undo is exact because the patch remembers what each key said
before. The alternative — copying the card and editing the copy — would have
been simpler for a week and then permanently wrong: every patched card would
have stopped tracking its own price.

**A custom card carries no prices, ever.** Same rule as sports (decision 17)
and for the same reason: no feed exists for a card nobody lists, and a made-up
number about someone's money is worse than an empty one. Value comes from
`CollectionItem.marketValue`.

**The id is the contract, again.** `customSlug` mints an id from the printed
facts so two devices describing the same card agree on what it is called —
which is what makes the shared index possible at all, and what makes changing
that function a rename of every custom card anyone owns.

**Reading is anonymous; writing is not.** This asymmetry is the security model.
`lookup_card_data()` is granted to `anon` and called with the publishable key
and **never the session JWT** — the decision 20 rule, for the same reason: what
card someone is looking at must not become a row tied to their account, and it
has to work signed out because the free path is signed out. `submit_card_data()`
requires `auth.uid()`, is rate limited, and allows one row per person per card,
because contributing is the only operation here that can hurt anyone: a wrong
picture propagates to every device that asks. Per-submitter rows rather than
one global row per card is what keeps the index from being first-write-wins,
where the first blurry photo could never be improved on.

**Two switches, not one.** `cardSourceLookup` defaults **on** — it sends a card
id and gets a picture back, the same class of request already made to Scryfall
on every search, and it only ever fires for a card with no art. `cardSourceShare`
defaults **off**, and the editor asks again on the card itself, because a photo
of a card is a photo someone took in their home. Same split as
`socialConfigured()` vs `socialPublishing()` (decision 16), same reason:
benefiting from the pool and feeding it are different decisions.

**What it costs.** A moderation surface we did not have — `flag_card_data()`,
three votes to hide, `service_role` to drop a bad contributor — and a table
whose contents are only as good as the people filling it. And bytes: images are
capped at ~220 KB after a downscale-and-requantize ladder, because the same
bytes ride IndexedDB, the JSON backup and the vault. That cap is why patches
are stripped out of binder shares (`httpsImage`) rather than travelling in a
`#/x?d=…` link.

**What would reopen it.** A real catalog appearing for the missing categories,
which would make the local half redundant for those games but not the shared
index. Or contributions arriving faster than one person can moderate, at which
point the flag threshold stops being enough and this needs a review queue —
that is a scale problem to solve when it exists, not a reason to build a
moderation console for a table with nothing in it.

---

### 23. A binder is a label on a real object, and its QR is a link to nothing but this app

**Why.** Somebody who scans a whole binder into the app has done the hard part
and still cannot answer the only question they will actually ask afterwards:
*which* binder is this card in, and where in it. So binders are first-class —
but as **locations**, not as a second collection. A binder holds no cards; cards
point at one (`CollectionItem.binderId`). Everything else follows from that:
deleting a binder unfiles cards and deletes none, a card can be found without
opening a binder, and the shelf can be reorganized without touching the
collection.

**The physical half is a printed QR, and it decides the design.** A sticker
outlives the session that made it, the device that made it, and often the
person's memory of making it. So:

- **It carries a plain URL to this deployment**, `…#/binders/<id>`, built from
  the app's own `location` — never a shortener, never an id that needs a server
  to resolve. Any phone camera opens it; no account, no install, no network
  beyond loading the app itself. A stranger who scans it sees whatever *their*
  app has, which is nothing: the link carries no collection.
- **It rides the fragment**, like every other route here, so a printed label
  keeps working offline and never sends the id to a server even where one is
  listening. (The referral code is the mirror image — `?via=` rides the search
  string precisely so the two can never be confused; decision on referrals in
  social.md.)
- **The encoder is ours** (`lib/qr.ts`, ~400 lines, no dependency). You print a
  label in the room the binder is in, frequently on a laptop that has never
  signed into anything. An image API or a CDN script would be the one part of
  this feature that fails while the rest of the app works. `tests/unit/qr.test.mjs`
  decodes what it produces with a real decoder, because "it looks like a QR
  code" is not evidence and a subtly wrong encoder produces a sticker that is
  discovered to be useless weeks later, already glued down.
- **The id is designed to be typed back.** Ten characters of base32 without
  `i`, `l`, `o`, `0` or `1`, printed under the symbol in two groups of five. A
  scuffed sticker is a solvable problem; an unprintable id is not.

**The cost, stated plainly.** Binder + page make a collection row's identity
(`sameBinder`, beside `sameGrade` and `sameOpened`), so the same card in two
binders is two rows. That is the honest model — one merged row of qty 2 cannot
say what is in *this* binder — but it does mean a collection filed across
several binders has more rows than one that is not, and code that assumes one
row per printing (there is none today) would need to say which it means.
Binders are also **not tombstoned**, exactly as decks are not: a binder deleted
on one device comes back until every device has synced, which costs a tap. The
alternative — mixing binder ids into the tombstone table the collection merge
reads by id — costs cards, and that trade is not close.

**What would reopen it.** Slots rather than pages (a 3x3 page has nine
positions, and the detector already returns them in reading order), which is a
strictly additive field on the same rows. Or sharing a binder *label* with a
friend, which would be the first thing here to leave the device — and is
exactly what the current design refuses, because the QR is a route into your own
app and nothing else.
