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

**Amended by 17a**, which puts a NUMBER beside the comps link: the spread of
active eBay listings, fetched on a tap and applied only when accepted. Nothing
above changed — a synthesized `Card` still carries no prices — and the reason
that is not a contradiction is the whole of 17a.

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

### 23. Where a collector can be found rides the binder, not the directory

Collectors asked to show their Instagram, Discord and Whatnot beside their
binder. The obvious place is the `profiles` row — it is the identity table, it
already has a display name, and one more column is cheap.

**It is the wrong place, and migration 0001 says why in its own header.**
`profiles` is readable by *every signed-in user*, because resolving `@rae` to a
user id is what a directory is for, and a directory nobody can read is not one.
So it carries identity **only**. The contact blurb ("DM @rae on Discord") was
deliberately put on the binder row instead, where it inherits the visibility
rule: `scope='trade'` means any signed-in collector, `scope='all'` means
accepted friends. Social links are the same class of fact — how to reach a
person — so they go the same way, as `ProfilePayload.links` and
`Friend.links`.

Three things fall out of that, and all three are the point rather than a cost:

- **The audience is the binder's audience**, which the user already chose with
  a control they already understand. No second privacy toggle was added, for
  the same reason 0003 reused the scope control rather than adding one.
- **It works with no account at all.** Links travel in a `#/x?d=…` link and in
  a `.json` file exactly like the note beside them. Putting them on `profiles`
  would have made a serverless share strictly worse than a hosted one, which
  decision 6 forbids.
- **Moving them later widens them silently.** A column on `profiles` is visible
  to every stranger in the directory the moment it exists, with no migration
  and no notice to the people whose links they are.

**The vocabulary is closed and the URL is built, never stored.** A handle-kind
link stores the handle; `socialLinkUrl()` builds the href from a table in
`lib/profilelinks.ts`. This is the security half. Every one of these ends up as
an `<a href>` in someone else's app, rendered from a document that arrived over
the wire from a person the reader has never met — and a stored URL is a stored
redirect: the icon says Instagram and the destination says whatever the sender
typed. Building it makes "the icon matches the destination" a property of the
code. `website` is the single exception, is `https:`-only, and renders as a
neutral globe rather than borrowing anyone's mark.

**What it costs.** A closed list needs editing when a platform people actually
use is missing, and `website` is the escape hatch until then. Handle formats
are the platforms' business and they change them; the table is one edit and the
stored data does not migrate, which is the other reason not to store URLs.

**What would reopen it.** Wanting a link visible to people who have *not* been
given the binder — a public profile page. That is a different feature with a
different audience, and it would need its own decision rather than a column
quietly added to `profiles`.

### 24. Messaging is its own subsystem, and it is not the trade inbox

People buying and selling cards need to talk: is it still available, will you
take $12, can you ship Tuesday. Today that conversation happens on Discord and
Instagram — outside the app that knows which card is being discussed.

Two existing things looked like they could carry it, and neither can.

**Not `inbox` (0004).** It is recipient-read-only, sender-stamped,
drained-and-deleted, 30-day TTL, capped at 20 undrained per pair. Every one of
those properties is correct for handing someone a trade payload and wrong for a
conversation: a sender who cannot read the thread back cannot see what they
said, and a row deleted on read is not a history. Widening it would have taken
each of those guarantees away from the thing they were built for.

**Not `orders` (0006).** Decision 19 refused a free-text field on an order and
that refusal stands: a message box attached to a payment is an unmoderated
channel between two people who are, by construction, in a dispute, and it
invites "just send me the money directly" next to a button that would have
escrowed it. `messages` is the conversation *before* anyone agrees anything. It
is not attached to an order, and an order still has no free-text field.

So: `message_threads` + `messages` (0019), one row per pair, both participants
reading, RPCs as the only writers.

**Who may open one** is the `send_to_inbox()` rule plus "they spoke to me
first" — friends, `scope='trade'` publishers, or anyone already in the
conversation. Publishing nothing and accepting nobody leaves you unreachable,
which is the correct default and the same one the inbox already had.

**It is plaintext to us, and the copy in the composer says so.** `binders` is
plaintext because a friend's app has to read it; this is plaintext for exactly
the same reason. Decision 15b's honesty rule applies — never describe it as
unreadable by us. What it is instead is **bounded**: text and one optional card
reference. No attachments, no images, no addresses; there is nowhere to put
one, which removes the worst payload class by construction rather than by
policy.

**Blocking is one-sided and silent**, mirroring `request_friend()` returning
`pending` to someone who has been blocked. The thread leaves the blocker's
list, the sender's own history is untouched, and they are never told — being
told is an instruction to make a second account.

**Nothing is stored locally.** No Dexie table, for `marketplace.ts`'s reason
(a shared fact whose every button needs the network) plus one more: Dexie rows
ride `exportBackup`, the CSV export and the daily Drive backup, and a private
conversation with somebody else does not belong in a file the user hands
around.

**What it costs, stated rather than discovered later.** This is the first
unmoderated person-to-person channel in the product. The caps (15 unanswered
per pair, 120 an hour) and the reachability rule bound the spam; blocking
bounds the individual case. There is no reporting queue and no moderation
console, because there is nothing in the table yet — and building one for an
empty table is how the wrong one gets built. It is also a standing cost we did
not have: conversations are plaintext rows we hold about people, which is why
`erase_social()` was extended rather than left alone, and why the prune exists.

**What would reopen it.** Volume that makes blocking insufficient — at which
point this needs a report path and someone to read it, and the honest options
are a review queue or turning it off, not a stricter cap. Or attachments, which
would be a new decision about storage, moderation and cost, not an extension of
this one.

### 25. The handshake is free, and the escrow is the thing you pay for

**The positioning, stated so the code can be held to it:** two collectors who
find each other here may do the whole deal themselves — message, agree a price,
send the money however they like, put it in the post — and pay us nothing.
Or they can run it through escrow, where the money is held until the card
arrives, and pay the fee for that. **It is the user's call, every time, and the
product must never make the free path feel like the one it disapproves of.**

This is what eBay was before the fees became the product. Finding people and
talking to them is the thing collectors actually want and the thing a hobby
this size has no good venue for; escrow is a service some of those deals want
and most do not. Charging for the first would be charging rent on the hobby.
Charging for the second is charging for work we actually do — holding money,
carrying the chargeback, standing between two strangers who have never met.

**Six things follow, and they are engineering constraints rather than tone:**

- **Messaging is never gated on `VITE_MARKETPLACE` or on entitlement.** It is
  free, it works with the marketplace switched off (which is how the deployed
  build ships), and it works for someone who will never pay us. The Ask button
  on the card sheet is deliberately on a *wider* gate than Buy for exactly this
  reason — see `CardSheet.tsx`.
- **We never detect, score, or discourage an off-platform deal.** No scanning
  message bodies for prices or payment handles, no "are you sure you don't want
  buyer protection?" interstitial, no nudge after a conversation goes quiet.
  A platform that polices the exit has decided the exit is the enemy; ours is
  the offer.
- **`forTrade` and a sale price stay separate** (decision 19). A listing is not
  automatically a barter offer and a barter offer is not automatically for
  sale, because "I'll swap this" and "I'll sell this for $40" and "ask me" are
  three different things a collector means, and flattening them is how a
  marketplace starts deciding for people.
- **The fee is quoted before the money moves, in full, once.** Nothing about
  the free path is hidden to make the paid one look inevitable.
- **Escrow is sold on what it does, never on fear.** "The money is held until
  it arrives" is true and is the whole pitch. "Don't get scammed" is a threat
  dressed as a feature, and it is also a claim about the free path we are
  simultaneously offering.
- **No fee-avoidance clause.** The terms must not prohibit what this decision
  exists to permit; a rule we would never enforce is worse than no rule.

**What it costs, plainly.** Revenue, first: every deal done in a conversation
is a fee we chose not to earn, and the ceiling on this business is however many
people find escrow worth paying for rather than however many transactions cross
the platform. That is the trade, made with eyes open — the alternative is a
funnel, and a funnel is what "got out of hand" means.

Second, and more important: **a deal done off-platform has no recourse, and
some of those will go wrong.** No held funds, no `advance_order()` state graph,
no dispute path — two people and the post. They will still be angry at us,
because they met here, and no amount of "you chose the free path" will change
that. The honest response is the one this decision already requires: say what
escrow does, plainly, at the moment it is relevant, and then respect the answer.
What we must not do is discover that failure later and answer it by making the
free path worse.

Third: an explicit "deal privately if you like" stance is a magnet for people
who want a venue with no paper trail. The guards are the ones decision 24
already lists — reachability, caps, blocking, and a channel with nowhere to put
an attachment. If that stops being enough, the answer is moderation, not a toll
gate.

**What would reopen it.** Escrow volume that cannot fund itself, at which point
the choice is a higher fee on the people already choosing to pay, a paid tier
for something else (binder scanning — decision 13), or retiring escrow. Taking
the free handshake away is not on that list. Or a legal obligation — a
jurisdiction that makes us liable for deals arranged here regardless of where
the money went — which would be a genuine reason to revisit, and a reason to
say so out loud rather than quietly start nudging.

### 26. A binder carries its own audience, and "public" stops at signed-in

Collectors organise by binder, not by collection: the vintage run, the box for
the weekend, the cards being kept. Until now the app had exactly one binder —
your whole collection, filtered by a single **For trade / Everything** switch —
and one audience for it. `CustomBinder` gives a named selection its own
audience, and the whole-collection binder is untouched beside it.

**Three visibilities, and `private` is a real one.** `private` is never
uploaded at all — not "published to nobody", genuinely not sent — and it is
what every binder starts as, whatever the caller passes to `createBinder`. A
binder that arrived public because a picker defaulted that way is the accident
this feature must not have.

**`public` means any signed-in collector. It does not mean the open web**, and
that line is the load-bearing part. A binder readable by `anon` is a binder
anyone holding the publishable key can enumerate: an inventory of valuable
cards attached to a handle, which is precisely what `trade_offers` refuses to
be (0003: "readable means dumpable, and a dump of this is a shopping list for
anyone deciding who to rob"). The open-web version is a different feature — a
public profile page, with crawlers, an abuse surface and a scraping story — and
it deserves its own decision rather than a loosened policy.

**`tradeable` is a second switch, not a synonym for public.** Both halves are
required to enter the global want index. Friends-only is never globally
matchable — 0003's invariant, applied one level down — and a public binder that
is merely on display is a display case, not an offer. The same split as
`socialConfigured()` vs `socialPublishing()` (16) and `cardSourceLookup` vs
`cardSourceShare` (22): being visible and being available are different
sentences, and collapsing them decides for the user.

**A sibling table, not a wider `binders`.** `binders` is `primary key
(user_id)` and `pullFriends`, `match_wants`, `send_to_inbox` and `can_message`
all read that shape. Re-keying it to (user_id, binder_id) would have touched
every one of them, and re-done the RLS harness, for a feature that only adds a
case. The cost of the sibling is real and worth naming: `trade_offers` needed a
`source` column so two publishers stop evicting each other, `match_wants` grew
a second liveness check, and reachability now has two clauses instead of one.
That is three careful edits against rewriting the table everything social
depends on.

**Rows point at collection rows, not at cards.** A binder holds copies you own,
and finish, condition, grade and price all live on `CollectionItem`. Copying
them into the binder would have made a **fourth** denormalized `Card` for
`savePatch` to chase — the failure mode CLAUDE.md already warns about, where
fixing a picture updates the sheet and leaves a grid showing the old one.
Pointing at the row means a binder always shows the copy actually owned, and
the price refreshes underneath. Quantities clamp to the collection twice, in
`addToBinder` and again in `resolveBinderRows`, because the collection can
shrink long after the binder row was written and the claim is one a friend
drives across town for.

**A binder is its own payload kind**, the fourth. It could have been a
`ProfilePayload` with a name on it, and that is the version that eventually
overwrites somebody's collection snapshot with a four-card subset. A separate
kind makes "file this under its sender, never merge it into their cards" a
property of the type rather than a rule in a merge function.

**What it costs.** A fourth wire kind, which an older client rejects as "not a
Cardstock share" — acceptable, and the honest alternative was a shape that
could be misread. Forty binders per account, and a poll that fetches friends'
binders in full rather than by revision (they are selections, not collections;
a cheap revision probe would be a second round trip to save less than it
spends). And a third publishing surface for a user to keep track of, which is
why every screen names the audience in words rather than describing privacy in
the abstract.

**What would reopen it.** Wanting a binder anyone can open without an account —
which is the open-web decision above, and should be taken as one. Or binder
counts that make the fetch-in-full poll expensive, at which point these want
the `remoteRev` treatment the main binder already has.

---

### 27. A binder is also an object on a shelf, and its QR is a link to nothing but this app

**Why.** Decision 26 made a binder a named selection with its own audience.
Most of those selections are also a *physical thing* — a ring binder, a box, a
shelf — and the question a collector actually asks while holding one is "which
of these is this, and what page is the Charizard on". Two small additions
answer it without a second concept: a page number on the binder row, and a
label you print and stick on the cover.

**One binder, not two.** The alternative was a separate "physical location"
model with its own table and `CollectionItem.binderId`. That was built and
thrown away deliberately: it split a collection row per binder (a card in two
binders became two rows), and it put a second thing called "binder" in a UI
that already had one. `BinderCard.page` gets the same answer for one optional
field, and it is *better placed* — the same copy can sit in two binders, and
"page 3" is only true of one of them.

**The label decides the rest of the design.** A sticker outlives the session
that made it, the device that made it, and often the memory of making it. So:

- **It carries a plain URL to this deployment**, `…#/binders/<id>`, built from
  the app's own `location` — never a shortener, never an id that needs a server
  to resolve. Any phone camera opens it: no account, no install, no network
  beyond loading the app. A stranger who scans it sees whatever *their* app
  has, which is nothing — the link carries no cards, not even for a `public`
  binder, whose contents still travel only through `socialcloud.ts`.
- **It rides the fragment**, so a printed label works offline and the id is
  never sent to a server even where one is listening. (`?via=` rides the search
  string for the mirror-image reason — the two can never be confused.)
- **The encoder is ours** (`lib/qr.ts`, ~400 lines, no dependency). You print a
  label in the room the binder is in, often on a laptop that has never signed
  into anything. `tests/unit/qr.test.mjs` decodes what it produces with a real
  decoder, because "it looks like a QR code" is not evidence and a subtly wrong
  encoder is discovered weeks later, already glued down.
- **The id is printed underneath, grouped in fives**, because a scuffed sticker
  is a solvable problem.

**Scanning a page fills a binder.** The page-scan review is a session now: one
review screen accumulates page after page, the binder is chosen once on it, and
each confirmed row is written twice — `addToCollection` for the copy, then
`addToBinder(binderId, itemId, 1, page)` for the arrangement. That order is
deliberate: a failure between them leaves a card filed outside a binder, which
the user can fix, where the other order leaves a binder pointing at nothing.

**The cost.** `#/binders/:id` is now printed on paper, so it is the one route in
this app that can never be renamed — and deleting a binder silently retires
whatever labels are on shelves. Page numbers are also only as true as the last
scan: re-reading page 7 keeps the page a copy was first seen on rather than
moving it, which is right for a re-scan and wrong for a card that genuinely
moved. Moving cards between pages is hand-editing work this does not have yet.

**What would reopen it.** Slots as well as pages — a 3x3 page has nine
positions and the detector already returns them in reading order, which is
strictly additive on the same row. Or letting the app *read* a label through
the camera (`BarcodeDetector`), which is deliberately not in the scan pipeline
today: any phone camera already opens the link, and a per-frame barcode pass is
exactly the kind of change the scan harness exists to gate.


---

### 17a. A sports card can carry a comp, and it is an asking price the collector accepts

**Context.** Decision 17 left sports with no price feed and an eBay sold-comps
*link* as the whole answer. That was honest, and it made the one category the
app cannot price also the only one where every figure in the portfolio has to
be typed by hand — for a category where the number on the screen is most of
why people open a collection app at all.

The thing that made this look impossible was checked again rather than assumed.
It is half true: eBay's sold-comp feed (Buy → **Marketplace Insights**) is a
limited-release API that is not open to new applications, and every paid
alternative (SportsCardsPro, CardHedge, Beckett, PriceCharting) fails decision
11 on the free path. But eBay's **Browse** API is open to any developer
account, needs no approval, and returns active listings — asking prices.

**Decision.** Ship the asking-price spread, and never let it pretend to be
anything else. `supabase/functions/ebay-comps` holds the eBay credentials and
returns `{ count, scanned, low, median, high, kind: 'asking' }`;
`lib/ebaycomps.ts` fetches and caches; `components/PriceCheck.tsx` renders a
button, a spread, and the sentence "asking prices, not sales".

**Why this way.** The failure mode decision 17 is built around is a *confident
wrong number*, and an asking price is precisely that if it is presented as a
value. So the design is arranged so it cannot become one:

- **It never touches `card.prices`.** A comp becomes the collector's own
  `CollectionItem.marketValue`, and only when they tap "Use $34". Writing it to
  the `Card` would put an unsold seller's hope into portfolio totals, price
  history and every shared binder, silently, for cards nobody ever opened.
- **Nothing is fetched until asked.** No prefetch on sheet open, no bulk
  refresh, no background sweep — which is also why it needs no settings switch.
  `cardSourceLookup` has one because it fires on its own; a tap is consent.
- **Spread, not figure.** Low / median / high with the sample size beside it.
  "Median of 14 active listings" is a fact. "$34" is a claim this data cannot
  support, and it is the claim decision 17 exists to refuse.
- **The median, never the high**, is what "Use $X" hands over. The number that
  flatters a collection is not the one to make a tap away.
- **A thin sample is refused outright.** Lots, repacks, reprints and "you pick"
  listings go by title; outliers go by a five-fold band around the median; under
  three survivors the answer is "too few listings". Decision 4, applied to money.

**Why a server at all**, in an app whose first decision is "no backend". eBay
sends no CORS headers, so the browser cannot make the call; and the
client-credentials grant needs a client **secret**, which — unlike the PSA
token, merely unwise in a bundle — is an account handed over. It is the
`scan-card` shape: the credential is the reason the function exists. The app
keeps working with the function absent, which is the property that matters.

**The call is anonymous, deliberately.** `verify_jwt = false`, publishable key,
no session token — the same rule as `lookup_card_data` and diagnostics
(decision 20). The free path is signed out, so gating "what is this worth?"
behind an account would make the most basic question in the app an account
feature; and what card someone is pricing today is not a fact worth being able
to attach to a user id.

**Consequences.**

- **Sports still has no prices**, in the sense decision 17 meant. `sportsCard`
  emits an empty `prices.entries`, bulk refresh still skips sports, and a
  portfolio total is still exactly what the collector entered.
- **We now spend a shared quota.** eBay's Browse allowance is per-application,
  a few thousand calls a day across every user — the PSA arithmetic again.
  Caching answers it: an hour in the isolate, a day on the device, three days
  for a "too few" answer, and a six-hour stand-down on a 429.
- **An unauthenticated function can be called by anyone who reads the bundle.**
  Accepted, and bounded rather than hidden: no money, no user data, a capped
  and normalised query, cached answers. The worst case is that price checks go
  quiet for a day, which the client already treats as ordinary.
- **The query is shared with the link** (`sportsCompTerms`), so the number on
  screen and the eBay page the user opens to check it answer the same question.

**What would make this wrong.** Getting real sold data — Marketplace Insights
access, or a paid feed the product decides to buy — at which point `kind`
stops being a constant and every renderer of it is forced to notice that the
meaning changed. That field exists for that day. The failure mode to watch for
meanwhile is the obvious one: someone deciding the median is good enough to
write onto the card, or to fill in automatically, or to total a collection
with. Each of those is one small edit and each turns an honest reading into the
invented number decision 17 was written to prevent.
