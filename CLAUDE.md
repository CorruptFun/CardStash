# Cardstock — notes for agents

Vite + React 19 + TypeScript PWA. Local-first: all user data in IndexedDB via
Dexie (`src/lib/db.ts`); settings in localStorage via zustand persist
(`src/lib/settings.ts`). The deployed app is a static bundle with **four
opt-in cloud features** — Drive backup, the encrypted cloud vault, hosted
social, and paid trades — all dormant until switched on, and paid trades is
switched **off** in the deployed build. Signed out, the app must always work
fully: scanning, collection, decks and link sharing never touch a server.

## Where the full documentation is

This file is the short brief. `docs/` is the long form — read the relevant
chapter before a non-trivial change, and update it when behaviour changes:

- `docs/architecture.md` — layers, boot, routing, state, caches, egress
- `docs/data-model.md` — types, Dexie schema + migrations, settings, invariants
- `docs/scanning.md` — the scan pipeline (deep tuning lives in the skill)
- `docs/card-data.md` — games, sources, catalog caching, pricing, portfolio/deck math
- `docs/social.md` — serverless friends/trades/wants + hosted social + the vault
- `docs/ui.md` · `docs/pwa-build-deploy.md` · `docs/testing.md` · `docs/privacy.md`
- `docs/extending.md` — checklists (add a game, a table, a setting, a release)
- `docs/decisions.md` — why the load-bearing choices are what they are

## History you should know

This repo originally carried **build output only** (README pointing at the
gh-pages deploy); the app's source lived in ephemeral sessions and was lost.
The source tree here was reconstructed from the deployed v0.3.1 bundle, then
extended. Treat this tree as the source of truth from now on. Hard rules:

- **Never commit build output to main** — `dist/` is gitignored for a reason.
- **Never edit or hand-push `gh-pages`** — CI regenerates it from `main` on
  every push (`.github/workflows/deploy.yml`), force-overwriting the branch.
- **Always push your source changes** before a session ends. Work that only
  exists as a deploy is work that is lost.

## Commands

- `npm run dev` — dev server (use `?demo=1` to seed demo data, `?nosw=1` to skip SW)
- `npm run build` — `tsc -b` then `vite build` (emits `sw.js` with a stamped
  precache manifest via the plugin in `vite.config.ts`, and copies the
  self-hosted OCR engine — Tesseract worker/wasm/eng data from npm — into
  `dist/ocr/`, which is runtime-cached, never precached)
- Deploys are automatic: pushing/merging to `main` triggers the GitHub Actions
  workflow that builds and publishes `gh-pages`. `npm run deploy` is a manual
  fallback only — don't use it when Actions works.
- `npm run test:social` — the hosted-social RLS harness against a real Supabase
  project (needs `SUPABASE_SECRET`; creates and deletes its own users). Run it
  after any migration touching `binders`, `friendships`, `trade_offers` or
  `inbox`. `npm run test:messages` is its sibling for `messages` /
  `message_threads` — run it after any migration touching either, and note it
  is what proves a third party can neither read a conversation nor write into
  one, which no schema read can show. `npm run test:cardsource` is the same shape for `card_data` — run it
  after applying `0013` and after any migration touching the card index; it is
  what proves the anon-read / authenticated-write asymmetry actually holds,
  which no schema read can show. `npm run test:mirror` is the same shape for
  `catalog_printings` (0022) — run it after applying `0022` and after any
  migration touching the mirror; it proves anon can read, no user role can
  write at all, and the code-normalization the client leans on actually holds.
- `npm run test:binder` — the binder screens end to end (filing, the label, the
  link a printed QR carries, and the delete that must keep every card). No
  camera, no fixtures.
- `npm run test:unit` — node tests (corner parsing, name candidates, card
  patches, the QR encoder against a real decoder, harness stubs). `npm run test:scan` — the real-image scan regression matrix
  (headless Chromium over real card photos; fixtures come from the
  machine-generated `harness-fixtures` branch — never merge it).
  `npm run test:photos` runs the hand-curated real photographs in
  `tests/harness/photos/` — those ARE committed here, because CI force-pushes
  the fixtures branch and a photograph can't be regenerated. **Never
  change scan-pipeline code without running the matrix before and after** —
  the workflow, thresholds, guard invariants and hard-won gotchas live in
  the `scan-harness` skill (`.claude/skills/scan-harness/`); read it first.

## Layout

- `src/lib/` — data + integrations: Dexie schema/CRUD (`db.ts`), price picking
  (`prices.ts`), the card APIs (`scryfall.ts`, `pokemon.ts`, `ygo.ts`,
  `lorcast.ts` for Lorcana, `tcgcsv.ts` — a day-cached TCGplayer catalog for
  Riftbound/One Piece/Star Wars/Digimon/Gundam — unified in `cardsearch.ts`;
  `cardcode.ts` parses the printed set/batch number off a search query
  ("BLMR-EN085", "OP01-016", "SVI 123/198") so every game is searchable by the
  number on the card and not only by name),
  the AI deck builder (`gemini.ts` — the app's ONLY Gemini use; scanning must
  stay fully on-device), sports cards + graded slabs (`sportsparse.ts` and
  `slab.ts` — both pure and node-tested, `sports.ts`, and `psa.ts` for cert
  lookup on OUR compiled-in `VITE_PSA_TOKEN`, dormant when a build has none),
  on-device OCR + collector-line reading (`ocr.ts`,
  `corner.ts`), scan pipeline (`identify.ts`, `vision.ts` — includes the foil
  sheen detector, `camera.ts`), sealed-product scanning (`sealed.ts`, backed
  by the TCGplayer group layer in `tcgcsv.ts`; sealed collection rows carry
  an `opened` flag and stop counting at the sealed price once opened),
  multi-card / binder scanning (`multiscan.ts` — detect regions, crop, identify
  each on a reduced per-card budget; the UI reviews before anything is added,
  and a session spans page after page of one binder), binders and their printed
  QR labels (`binders.ts` + the dependency-free `qr.ts`),
  portfolio math (`portfolio.ts`), deck math (`deckstats.ts`), CSV
  import/export (`importexport.ts`), local diagnostics (`analytics.ts`),
  serverless social (`social.ts` — profile/trade payload build+codec+sanitize;
  the Dexie writes for friends/trades live in `db.ts`; `profilelinks.ts` — the
  closed platform vocabulary behind a collector's Instagram/Discord/Whatnot
  icons), hosted social
  (`authsession.ts` + `socialcloud.ts` — see Hosted social below;
  `messaging.ts` — collector-to-collector conversations, server-only), opt-in backup to
  the user's OWN Google Drive (`drive.ts` — `appDataFolder`, daily, last 5 kept;
  dormant without `VITE_GOOGLE_CLIENT_ID`, and the third-party Google script is
  injected on first use, NEVER at boot, so a user who never turns it on never
  contacts Google), and the automatic backup vault (`cloud.ts` — Supabase auth +
  pull-merge-push, dynamically imported, driven by `autobackup.ts`; `crypto.ts`
  — the AES-GCM envelope, encrypted with a **server-minted key** (0009), so it
  is encryption at rest and NOT end-to-end — never describe it as unreadable by
  us (decision 15b); `cloudmerge.ts` — the pure device-merge; `cloudconfig.ts`
  — project URL/publishable key). **These two overlap**: Drive is one-way
  backup to storage the user owns, the vault is multi-device sync through a
  project we run. Both are opt-in and both are dormant unless configured; the
  free path must never depend on either.
  User-authored card data — the picture and details for a card the catalogs got
  wrong or never had — is `cardpatch.ts` (the pure overlay/slug/sanitizer core),
  `cardimage.ts` (the bounded encoder) and `cardsource.ts` (the shared index
  client); see the section below.
  Sealed set matching rules are pure in `sealedmatch.ts` (node-testable);
  the group index merges the "Pokemon Japan" TCGplayer category so Japanese
  packs match by their printed set code ("sv4K").
- Cards in ANY language identify off the collector line (Latin digits on
  every print worldwide) when the name can't be read: MTG by exact
  set+number, Yu-Gi-Oh by the 8-digit passcode, Pokémon by a multi-language
  TCGdex sweep; Latin-script localized Pokémon names (Glurak, Dracaufeu)
  resolve to the EN card. Requires picking the game — auto mode has no
  collector rescue. Guards are documented in the `scan-harness` skill.
- `src/views/` — one file per screen; `CardSheet.tsx` is the card bottom-sheet.
- `src/store/ui.ts` — UI store: bottom sheet, the card editor, toasts, search
  prefill, and `builderSeeds` (cards handed to the AI builder to design around).
- `src/styles.css` — the whole stylesheet (BEM-ish, design tokens on `:root`).
  `src/fonts.css` pins the exact font subsets shipped.
- `src/sw.js` — hand-written service worker; `__BUILD_ID__` and
  `__PRECACHE_MANIFEST__` are stamped at build time. Read its comments before
  touching caching.

## Conventions

- Card ids are `${game}:${apiId}`. Games: `mtg | pokemon | yugioh | riftbound |
  lorcana | onepiece | starwars | digimon | gundam` — the list lives in
  `games.ts` (`GAMES`); per-game tables there + `deckstats.ts` (boards/rules)
  are what a new game must extend.
- DB writes from UI go through `guarded()` (`src/store/ui.ts`) so quota errors
  surface as toasts.
- Analytics events must stay content-free (no card names/queries/keys) — the
  redaction lives in `analytics.ts` (`redact`, unit-tested); event names are a
  fixed whitelist. A card that fails to scan is identified by
  `hashToken(readName)`, never by its name — the hash groups repeat failures
  and a maintainer resolves one by hashing catalog names. Who is using the app
  comes from a random per-install id plus `app_open`/`session_end`/
  `screen_view`, with collection size as a bucket and never an exact count;
  `clearAnalytics()` drops that install record along with the events. The scan
  trace ring (`scandebug.ts`) holds real card text and must never feed
  analytics.
- **Diagnostics now have a receiver, and it is our own project** —
  `ingest_events()` in `supabase/migrations/0007`, reached via `diagconfig.ts`.
  Three things about it are load-bearing (decision 20): it posts with the
  publishable key as `anon` and **never the session JWT**, because tying a
  content-free counter to an account is the one thing this log must not do;
  `analytics_events.device` is a random per-install id and must never become
  `auth.uid()`; and unknown event names are BUCKETED, never rejected, because a
  cached PWA client predating a rename is permanent rather than exceptional.
  `diagShare` defaults **on**, which is only honest because `diagConsentAt`
  gates the upload separately — nothing is posted before the disclosure has been
  shown, EU/EEA/UK gets an ask instead, and `noteDiagConsent()` buries the
  pre-consent backlog. Beware the silent failure mode: `flushedThrough` advances
  on **any** 2xx, so a receiver that 200s a shape it does not understand loses
  those events forever.
- Prices: USD only (US/English market). `best` = non-foil headline, `bestFoil`
  = premium finish; per-item pricing multiplies by condition factor. Data
  stored by pre-0.5 versions may still carry EUR (Cardmarket) entries — the
  pickers in `prices.ts` and history readers filter them out; don't reintroduce
  them into math or UI.
- Social is serverless **by default**: everything works with no account, and
  that path must keep working — never make links/files a second-class citizen
  or route them through a server. Hosted social (`socialcloud.ts`) is an
  opt-in overlay; with no handle claimed, nothing in it runs and the app makes
  no request to our server. Anything the server returns is untrusted
  and goes through the same `social.ts` sanitizers as a pasted link. Profiles,
  trade proposals and replies travel as deflate+base64url payloads in
  `#/x?d=…` links (or plain-JSON files); friends/trades are local Dexie
  tables; `forTrade` on a collection row is the count of copies offered
  (≤ qty — every write clamps via `tradeCount` in db.ts). Everything decoded
  from a link/file/backup is untrusted: route it through the sanitizers in
  `social.ts`. `SharedCard.price` is the finish's market unit with condition
  NOT applied — viewers multiply by condition factor. Wants are card-level,
  keyed `${game}|${normalizeName(name)}` (any printing matches); matchmaking
  compares want keys, never card ids.

## Hosted social (v0.15.0)

Accounts, `@handle`s, mutual friends, a trade inbox and global want-matching,
on the same Supabase project as the cloud vault. **The database is defined by
`supabase/migrations/` (0000–0022 — social is 0000–0004, messaging is 0019,
custom binders are 0020, the catalog mirror is 0022), not
`supabase/schema.sql`** — that file is a pointer, and the migration history is
baselined on the live project so a `db push` cannot replay from zero. Read
`docs/social.md` and decision 16 before touching any of it.

A new table states its own grants, `revoke all` first, then grants back exactly
what it needs (0011–0012). Supabase's default privileges hand `anon` and
`authenticated` privileges nobody asked for, and a revoke that *names*
privileges only takes back the ones you thought of — Postgres 17 added MAINTAIN
and `information_schema.role_table_grants` cannot see it, so audit
`pg_class.relacl` when the question is "does this grant anything at all".

**The CLI on a dev machine may be signed in as the wrong account.** If every
project-scoped call answers `does not have the necessary privileges`, that is
not a scope or database-password problem — compare `GET /v1/profile` against
`GET /v1/projects` and check the project is even visible. `sb doctor` reporting
"linked" proves nothing; it reads a local file, not the API.

The one rule that is not obvious from the SQL: **scope drives visibility.** A
`scope='trade'` binder is readable by any signed-in user (being findable is the
point, and it is what makes global matching possible); a `scope='all'` binder
only by accepted friends. Only `trade` publishers enter the `trade_offers`
index, so a friends-only binder is never globally matchable — `publish_binder()`
rebuilds row and index in one call to keep that true at every instant.

`binders` is plaintext and that is deliberate: a friend's app must *read* it, so
it is plaintext where `vaults` is ciphertext. Neither is end-to-end any more —
`vaults` is encrypted with a key we hold (15b) — but the two remain separate
tables with separate lifecycles, and `erase_social()` leaves `vaults` alone. Never widen what is
published beyond what the user chose.

**A handle is claimed once and never changes hands** (migration 0010, decision
21). `set_profile()` writes it once and raises `handle_locked` on any later
change; the `handle_claims` ledger — never deleted from — is the uniqueness
authority, so an erased account keeps its name reserved and a *deleted* one
retires it forever (`on delete set null`, not cascade). `authenticated` has no
INSERT/UPDATE/DELETE on `profiles`; the RPCs are the only door and a trigger
backs them up. Display names stay editable via `set_display_name()`.

This existed because the flow got it wrong, not just the schema: the welcome
screen used to ask for a handle after **every** sign-in, prefilled from the
email, so signing in on a second phone renamed you and freed the name your
friends had saved. Two client rules follow and must not erode — **look up the
profile before ever offering the handle field** (`checkForProfile` in
`Welcome.tsx`; a returning account goes to "Welcome back, @rae"), and
**`hydrateIdentity()` pulls the handle onto a new device**, because
`socialHandle` is a localStorage cache and every "are they set up?" check reads
it. There is no separate sign-up: an email address *is* the account, one per
address, and `SignIn.tsx` must never grow a "Create account" branch.

**Two switches, not one.** `socialConfigured()` (signed in + handle) and
`socialPublishing()` (+ `socialOn`) are different questions on purpose:
claiming a handle publishes no cards and only makes you reachable; putting the
binder up is the separate, privacy-bearing act. Don't collapse them.

**First run asks for an account** (`Welcome.tsx`, state machine in
`lib/onboarding.ts`), and `ConnectNudge.tsx` re-asks every three days until
there is nothing left to connect. It is prominent but **skippable on purpose**
— a hard gate would break offline first launch and put every new user behind
the mail provider's uptime; `ALLOW_SKIP` in `Welcome.tsx` is the whole change
if that is ever wanted, and `?welcome=0` must go with it. Harnesses skip it
with `?welcome=0`.

**Never write "your data isn't saved" in that copy.** It is false — cards are
in IndexedDB — and signing in does not back anything up either; the vault needs
a passphrase — that is now stale: signing in DOES back you up (15b), so the
`backup` step only remains for people who want a second copy in their own Drive.
`nextConnectStep()` returns `signin | handle | backup` and each
has copy naming what is actually missing. A warning users can disprove gets
dismissed reflexively for the rest of the product's life.

- `lib/authsession.ts` — sign-in, shared by the vault and social. `cloud.ts`
  re-exports it so existing call sites keep one import site.
- `lib/socialcloud.ts` — the hosted transport. Everything it receives still
  goes through `social.ts`'s sanitizers.
- `components/SignIn.tsx` — the one sign-in UI; `SocialPanel.tsx` — the front
  door on the Friends screen.
- **`server/` and `lib/sync.ts` are deleted** (the app had no users, so no
  compatibility path was carried). Don't reintroduce a second live tier.

## Where a collector can be found, and talking to them

**Social profile links ride the BINDER, never `profiles`** (`profilelinks.ts`,
`ProfilePayload.links`, `settings.profileLinks`, decision 23). Migration 0001's
header is explicit that `profiles` is readable by every signed-in user and
carries identity only; contact details live on the binder row so they inherit
scope-driven visibility. Two things are load-bearing: the audience is the
binder's audience (no second privacy toggle), and **the vocabulary is closed
and the URL is built from a table, never stored** — a stored URL under a
platform icon is a redirect a payload could point anywhere. `website` is the
one URL-holding kind, `https:` only; Discord has no profile page and is
copy-to-clipboard.

**Messages are their own subsystem** (`supabase/migrations/0019`,
`lib/messaging.ts`, `views/MessagesView.tsx`, decision 24). Read
`docs/social.md` before touching any of it. Four things that are load-bearing:

- **It is NOT the trade inbox and must not become it.** `inbox` is
  recipient-read-only, drained-and-deleted and 30-day TTL — right for a trade
  payload, wrong for a conversation. `orders` still has no free-text field.
- **Nothing writes these tables directly.** No INSERT/UPDATE/DELETE policy and
  only `select` granted; `send_message` / `list_threads` / `mark_thread_read` /
  `set_thread_block` are the doors, because the denormalized preview, the read
  watermarks and the block flags are all things a client could forge about the
  *other* person's row.
- **No local mirror.** Dexie rows ride `exportBackup`, the CSV export and the
  Drive backup; a private conversation with somebody else does not belong in a
  file the user hands around. Threads are fetched, like orders.
- **Plaintext to us, and the composer says so** (15b's honesty rule). Bounded
  instead: text plus one optional `SharedCard`, which goes through
  `sanitizeSharedCard` — the same door a share link uses. No attachments, no
  images, no addresses. Blocking is one-sided and silent, mirroring
  `request_friend()`; the badge (`settings.messageUnread`) is a cache, never
  the authority.

**The handshake is free and the escrow is what you pay for** (decision 25) —
this is the product's position, not a temporary state, and it constrains code.
Two collectors may do the whole deal in a conversation and pay us nothing;
escrow is the optional service the fee buys. Therefore: messaging is **never**
gated on `VITE_MARKETPLACE` or entitlement (Ask sits on a wider gate than Buy
in `CardSheet.tsx`, on purpose); we never scan message bodies, interstitial the
way out, or nudge a quiet thread; escrow is sold on what it does, never on fear
of the free path we are simultaneously offering. Read decision 25 before
writing copy near this or adding anything that measures where a deal ended up.

## Custom binders

Binders the user builds by hand, each with **its own audience** — `lib/binders.ts`
(pure), `views/BindersView.tsx`, Dexie v9 (`binders`, `binderCards`),
`supabase/migrations/0020`. They sit BESIDE the whole-collection binder, never
instead of it. Read decision 26 and `docs/social.md` first. Five load-bearing
things:

- **`public` means any signed-in collector, NOT the open web.** A binder
  readable by `anon` is one anybody with the publishable key can enumerate,
  which is what `trade_offers` refuses to be. Changing that is a decision, not
  a policy edit.
- **`tradeable` is a second switch.** Only `public AND tradeable` enters the
  global want index (`isDiscoverable`), and `publish_custom_binder` computes
  that itself rather than trusting the caller. Friends-only is never globally
  matchable. Publishing one also makes you reachable (`can_message`,
  `send_to_inbox`) — otherwise the offer exists and nobody may ask about it.
- **`BinderCard.itemId` points at a COLLECTION ROW, not a card.** Finish,
  condition, grade and price come off the copy owned; copying them would be a
  fourth denormalized `Card` for `savePatch` to chase. Quantities clamp to the
  collection in `addToBinder` *and* `resolveBinderRows`.
- **A binder is its own payload kind** (`kind: 'binder'`). `upsertFriendBinder`
  files it under its sender and never touches `Friend.cards`; `friendFromProfile`
  returns the favour by keeping binders a profile refresh knows nothing about.
- **`trade_offers.source`** is what stops the two publishers evicting each
  other (`''` = main binder). `unpublish_binder` is narrowed to `source = ''`
  for the same reason. A binder starts `private` whatever the caller passes,
  and `sanitizeBackup` forces an unrecognised visibility back to private — a
  restore must never be the thing that publishes a binder.

## Paid trades — buying a card from a friend (in progress)

Escrowed purchases between accepted friends: the buyer pays, the money is held,
the seller ships, and it is released on confirmation. `supabase/migrations/0006`
(`orders`, `seller_accounts`) and `supabase/functions/stripe-escrow` are the
whole server side. **Read decision 19 before touching any of it.** Server half
is built and tested; there is no UI yet, so nothing is user-reachable.

**Stripe runs BOTH now (2026-08-15).** The subscription moved off Square to
`stripe-billing` → `entitlements`; `square-billing` stays deployed but dormant
until existing subscribers are migrated, then goes. **They are still two
separate integrations**: Stripe *Billing* (recurring) and Stripe *Connect*
(escrow) share an account and a secret key but have their own webhook endpoints
and their own signing secrets — never reuse `STRIPE_WEBHOOK_SECRET` for
billing. The swap cost nothing in `src/` because `entitlements` is the
interface, which is exactly what that design was for.

Square could not have run the escrow half regardless: its auth-and-hold caps
at 7 days, its Payouts API only reports money reaching *our own* bank, and
`app_fee_money` pays sellers instantly. The two providers share no code and no
table. A provider belongs in exactly one file; the table is the interface.

Four things that are load-bearing rather than incidental:

- **Nobody writes an order through PostgREST** — not the buyer, not the seller.
  Money transitions (`paid`/`released`/`refunded`) are `service_role` only;
  ship/confirm/dispute are user RPCs that check who is asking.
  `seller_accounts.stripe_account_id` is where money *goes*, so it is the most
  dangerous column in the schema and nothing may write it but the webhook.
- **The state graph lives in `advance_order()` and nowhere else.** `logic.ts`
  decides what a Stripe event *means*; SQL decides whether it is allowed. Do not
  add a second copy for easier unit testing — `tests/harness/escrow-rls.mjs`
  proves the edges against real SQL. Run it after any migration touching
  `orders` or `seller_accounts`.
- **Never store a shipping address.** Stripe Checkout holds it; the seller's app
  fetches it per request. In Dexie it would ride into the JSON backup, the CSV
  export and the daily Drive backup; on the server it would be plaintext PII
  beside `binders`. `redact()` also drops the postal and money key families —
  order value travels through `amountBucket()`, never as an amount.
- **`forTrade` is not "for sale."** It sets the shared quantity under
  `scope: 'trade'` *and* feeds the global `trade_offers` index. A sale needs its
  own count and price with its own clamp beside `tradeCount()`, or every listing
  silently becomes a globally enumerable barter offer.

**It ships OFF, on purpose, and there are two switches.** `VITE_MARKETPLACE`
hides the UI; `MARKETPLACE_ENABLED` on the edge function refuses to open an
order or start onboarding. Only the second is a real defence (decision 2a); the
first stops us offering a purchase the server would refuse. Turn both on,
**server first**. With it off, `/onboard` and `/checkout` are refused while
shipping, confirming, refunding, the webhook and the sweep stay live — a kill
switch stops new business without stranding money already in flight.

Also dormant without `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`, as Drive is
without a client id. `STRIPE_WEBHOOK_SECRET` takes a **comma-separated list** —
a Connect platform needs two endpoints (platform scope for checkout/charge,
connected-accounts scope for `account.updated`) and each has its own secret.

## Referrals and the founding offer

The first 100 people who arrive through a friend's link buy lifetime access for
a one-off fee; everyone else buys the year. `supabase/migrations/0014` and
`stripe-billing` decide all of it — `src/lib/referral.ts` is the client half and
decides nothing. Read the section at the end of `docs/social.md` before touching
it. Four things are load-bearing:

- **`?via=<handle>` rides the SEARCH string, never the fragment.** `parseRoute`
  reads the fragment and `decodeShareText` scans it for `[?&]d=`, so a code in
  the search half can never be confused with a payload in either direction — and
  it sits ahead of a blob that can run to 20k characters, which is the end a
  chat app truncates. A sharer with **no handle** must keep getting a
  byte-identical link; that is the serverless default, not a fallback.
- **Capture at boot, redeem later, because sign-in destroys the URL.** The
  Google round trip returns to `origin + pathname` with query and fragment both
  gone, so `captureReferral()` is the first statement of `boot()` and
  `redeemReferral()` runs once there is an `auth.uid()`. Reading the URL at the
  moment of claiming works for an emailed code and never fires for Google.
- **The first link wins and the server is asked once.** `referralFrom` is never
  overwritten (one referrer per account, for ever); `referralAt` records that a
  *final* answer arrived — a refusal is final, only being offline is not.
- **Eligibility comes from the server, not from settings**, and the copy is
  held to the same standard as the connect nudges: a one-off payment, stated as
  one, with a seat count that is real. Nothing here may reach `track()` — a
  handle is identity.
- **An invite ends in a friendship** (`0017`, `components/InvitePanel.tsx`).
  `befriend_referrer()` takes **no argument** — the `referrals` row is the only
  thing that authorises the accepted edge, which is why this does not breach
  0002's consent gate: both sides acted, one by inviting and one by following.
  A `blocked` row in either direction ends the call untouched; an invite must
  never launder a refusal. `seedFriendRows()` gives an accepted friend a local
  row before they publish, or the Friends screen contradicts the toast.

## Cards the catalogs got wrong, or never had

A card with **no picture** (TCGCSV ships those constantly) and a card in **no
catalog at all** (regional promos, prereleases, error prints) are both ordinary,
and both used to be dead ends. Now the user fixes them: attach a photo, type
what the card is. `lib/cardpatch.ts` is the pure core, `db.ts` owns the
`patches` table (Dexie v8) and the in-memory index, `components/CardEditor.tsx`
is the UI, entered from the card sheet, the search empty state and the scan
miss (which hands the editor the frame it just failed on). Read decision 22 and
`docs/card-data.md` before touching any of it.

Four things are load-bearing:

- **A patch is an OVERLAY, never a replacement.** `mergePatch` lays it over the
  catalog's card, so prices keep refreshing underneath and an upstream fix still
  arrives. Only changed keys are stored; `base` remembers what they said before,
  which is what makes undo exact and offline (`unmergePatch`). Prices are never
  patchable. Never "fix" this by forking the card.
- **The id is the contract**, as it is for sports. `customSlug` mints
  `custom-<set>-<number>-<name>` from the printed facts — changing it renames
  every custom card anyone owns. A custom card carries **no prices at all**, and
  `refreshCard`/the bulk refresh skip it rather than counting it as a failure.
- **Writes go through `savePatch`/`deletePatch`, never `db.patches`.** `Card` is
  denormalized into collection, deck and scan rows, so a patch that only updated
  the index would fix the sheet and leave the grid showing the old picture.
  `deletePatch` reads the outgoing patch **before** dropping it — undo needs to
  know what it covered.
- **Images are bounded and inline.** `cardimage.ts` downscales to 720px and
  steps a quality/scale ladder down to `TARGET_IMAGE_BYTES` (64 KB) — a
  **target, not a ceiling**: accepting the first encoding under the hard cap
  put every picture at ~78 KB median / 105 KB p90, where targeting gives a flat
  57 KB median. Don't "simplify" that back into a fits-under-the-cap check.
  `sanitizeImage` accepts only `data:image/(png|jpeg|webp)` because the value
  becomes an `<img src>` in a dozen places. They ride the backup and the vault
  (the vault up to `VAULT_IMAGE_BUDGET`, newest first, rows past it omitted
  **whole** — a gutted patch could win on `updatedAt` and delete a photo that
  existed nowhere else), and are **stripped from binder shares and want lists**
  (`httpsImage` in `social.ts`) — a `#/x?d=…` link cannot carry them, and
  publishing someone's photo is not a side effect of sharing a binder.

**The shared index makes us a source, not just a consumer** (`cardsource.ts`,
migration `0013`). Reading is anonymous — `lookup_card_data()` is granted to
`anon`, called with the publishable key and **never the session JWT** (the
decision 20 rule), only for cards with no image at all, driven by what is on
screen and misses cached three days. Writing is attributed: `submit_card_data()`
needs `auth.uid()`, is rate limited, and allows one row per person per card.
Everything the server returns goes through `sanitizePatch`, and **a local patch
always beats a fetched one**. Two switches: `cardSourceLookup` (on) and
`cardSourceShare` (off) — don't collapse them.

**The catalog mirror is the other half of being a source** (`catalog.ts` +
`catalogmatch.ts`, migration `0022`, decision 28): our own copy of Scryfall /
TCGdex / YGOPRODeck rows, consulted only AFTER a game's own API failed or
answered empty — never first — under the same `cardSourceLookup` switch and
the same anon-key rule, behind code lookup, name search, the match layer and
the variants picker alike. It stores each game's own api-id namespace so
mirror answers dedupe with live ones and synthesizes cards **without prices**
(`refreshCard` fills real ones); rows come only from the sync worker
(`scripts/sync-catalog.mjs`, service key, the table's only writer). The
schema also reserves an `art_hash` column for a future artwork fingerprint —
unpopulated, unread by any client code, its format deliberately not yet a
contract (the scan pipeline's own printing work is `arthash.ts`, a separate
system). `npm run test:mirror` proves the grants.

## Sports cards have no catalog

Sports is the one category with no data source: no free API publishes the set
of printed sports cards, so `sportsparse.ts` reads the identity off the card
and `sports.ts` SYNTHESIZES the `Card`. That inverts the failure mode — a TCG
misread picks the wrong real card, a sports misread invents one — so three
guards are load-bearing and must not erode: the `MIN_SPORTS_CONFIDENCE` floor,
closed vocabularies rather than open guessing, and **sports never joining the
auto-mode sweep** (`sweepable` in `identify.ts`). Sports cards carry no prices
at all; value is the collector's `CollectionItem.marketValue`. See decision 17.

Grades live on `CollectionItem`, never on `Card`, for every game — see decision
18. `slab.ts` owns `sanitizeGrade`, reused by the backup and social paths.

**`psa.ts` uses our key, not the user's.** It is compiled in from
`VITE_PSA_TOKEN` and there is no Settings field. Two things follow that are
easy to forget: the token is READABLE in the static bundle (unlike the Google
client id and Supabase key, nothing else backstops it), and its ~100/day free
quota is now shared across all users rather than per-person. Certs cache for
months and a 429 stands lookups down for hours. The real fix is a proxy holding
the token server-side — point `VITE_PSA_ENDPOINT` at one and nothing else
changes.

## Binders are also objects on a shelf

The section above is a binder's *audience*; this is its *body*. Most binders
are a real thing you can hold, so two additions say so without inventing a
second concept — read decision 27 before touching either:

- **`BinderCard.page`** — 1-based, stamped by a binder page scan, absent when a
  card was added by hand. It lives on the BINDER row rather than the collection
  row because the same copy can sit in two binders and "page 3" is true of only
  one of them. `addToBinder` keeps the page a copy was **first** seen on: a
  re-scan of page 7 must not move a card page 3 already accounted for.
- **A printed QR label** (`components/BinderLabel.tsx` + the dependency-free
  `lib/qr.ts`) carrying `…#/binders/<id>`, built from the app's own `location`
  and riding the FRAGMENT so a label works offline and the id never reaches a
  server. Any phone camera opens it; it carries no cards, so a stranger who
  scans it gets nothing — not even for a `public` binder. `#/binders/:id` is
  **printed on paper**: it is the one route that can never be renamed.

The encoder is ours and stays ours — you print a label in the room the binder
is in. `tests/unit/qr.test.mjs` decodes what it emits with a real decoder,
because a subtly wrong encoder still renders a plausible square and the sticker
is glued down by the time anyone notices.

A page scan is a **session**, not a screen: "Next page" parks the review behind
the viewfinder and the next page's rows append under their own heading. The
review is parked with `display:none`, never unmounted — remounting would throw
away every tick already made and the binder already chosen. Filing writes the
collection row first and the binder row second (`addToCollection` then
`addToBinder`), so a failure between them leaves a card outside a binder rather
than a binder pointing at nothing. Run `npm run test:binder` (no camera, no
fixtures) after touching any of it.

## Planned paid tier — binder scanning and photo upload

**Photo upload and binder/multi-card scanning are intended to become a paid
subscription option.** Neither is gated today and neither should be gated
while it is still being built — the note exists so the seam is designed in
rather than retrofitted.

The seam now exists: `src/lib/entitlement.ts`, a `GATED` table with every
feature set to false, checked at the two entry points — the upload control
(`UploadButton` in `ScanView.tsx`) and the page-scan path (the Page pill's
live tap and the page branch of an upload). Flipping a row there is the whole
change. It deliberately does NOT read or write settings: nothing stores an
entitlement yet, and inventing storage for one would pick an answer to the
question below by accident.

Where the seam goes matters more than the note. Gate the ENTRY POINTS — the
upload control, the multi-card review screen, the "scan a whole page" path —
and **never `detectCardRegions` itself.** That primitive is shared: it also
fixes ordinary single-card detection on cluttered backgrounds, which is the
free path and the dominant real-world failure (see the scan-harness skill,
lessons 32 and 34-38). Gating the detector would quietly degrade free
scanning for everyone.

Entitlement has no home in this architecture yet, and that is a real decision
rather than an oversight. The deployed app is a static gh-pages bundle with no
backend; `server/` is an opt-in self-hosted sync box the user runs themselves,
so it can never be the authority on whether that same user has paid. Three
honest options, in the order they preserve the local-first promise:

- **Soft/client-side gating** — a flag in settings, trivially bypassable by
  anyone who opens devtools. Fine if the subscription is treated as support
  rather than enforcement; needs no backend and keeps the app offline-first.
- **A third-party entitlement check** (Stripe/RevenueCat/similar) called on
  launch, with the result cached and the app fully usable offline afterwards.
  Introduces the first hard network dependency — decide deliberately what
  happens when it is unreachable, and make that "keep working", not "lock out".
- **A first-party backend**, which contradicts "the app must always work fully
  without a server" as written above and would be a much larger change.

Whichever is chosen: scanning must keep working offline, and analytics stay
content-free (`analytics.ts`) — subscription state is not an excuse to start
sending card data anywhere.
