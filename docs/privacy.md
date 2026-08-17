# Privacy, keys and what leaves the device

The product promise is "no accounts, no server required, your collection stays
yours". These are the mechanisms that make that true, and the rules that keep it
true when the code changes.

## Data at rest

Everything the user creates lives in browser storage on their device:

- IndexedDB `cardstock` — collection, decks, price history, scans, friends,
  trades, wants, binders, plus card-data caches.
- IndexedDB `cardstock-analytics` — local diagnostics events.
- localStorage `cardstock-settings` — preferences **including the user's own API
  keys**, and `cardstock-version`.

**Signed in, there is also a copy on our server, and it is not optional.** The
vault (`lib/cloud.ts`) backs the collection up automatically — see decision 15b.
It is encrypted with a key minted server-side and held in a table no role can
read directly, which defends a leak of the vault table alone; it is **not**
end-to-end, and anyone with full database access could decrypt a collection. It
is described that way everywhere rather than implied to be private from us.
Signed out, none of this runs and the paragraph below is the whole story.

There is no requirement to have an account. `requestPersistence()` at boot asks
the browser not to evict the data. The user's escape hatches are the JSON backup, the CSV export,
and Settings → Erase everything (`clearAllData()`; the analytics DB is cleared
separately by `clearAnalytics()`).

**One optional copy can exist off the device, and it is not ours.** With Drive
backup on (`lib/drive.ts`), a JSON backup is written daily to the user's own
Google Drive, in the `appDataFolder` — a per-app hidden folder that no other
software, and no page on the web, can enumerate or read. We host nothing, store
nothing, and never see the file; the browser talks to Google directly. The last
five backups are kept and older ones deleted, because an automatic backup that
overwrites the only good copy after a corruption is a data-loss trap of its own.

Turning it off (`disconnectDrive()`) revokes the OAuth grant. It deliberately
does **not** delete what is already in the user's Drive — that is their data, in
their account, and silently destroying it on a toggle would be the wrong default.
The copy says so.

**A printed binder label adds no egress.** Its QR code encodes a URL to this same app —
`…#/binders/<id>` — with the id in the **fragment**, which browsers never send
to a server. Scanning someone else's label loads the app and looks the id up in
the scanner's own IndexedDB, where it is not found — the label carries no cards,
not even for a `public` binder, whose contents still travel only through the
paths above. No analytics event carries a binder name or a page.

## Network egress, exhaustively

| Destination | Trigger | What is sent | Optional? |
| ----------- | ------- | ------------ | --------- |
| `api.scryfall.com` | MTG search / match / refresh | a card name, set, number, or ids | required for MTG data |
| `api.pokemontcg.io` | Pokémon search / match | a query string; the user's key in a header if set | required for Pokémon data |
| `api.tcgdex.net` | Pokémon fallback, non-English lookups | a name or set/number | as above |
| `db.ygoprodeck.com` | Yu-Gi-Oh | a name or passcode | as above |
| `api.lorcast.com` | Lorcana | a query | as above |
| `tcgcsv.com` | catalog games, sealed products | nothing but the path (static files) | as above |
| `api.psacard.com` | a slab scan whose label carried a cert number | the cert number, and **our** token as a bearer header — no user data of any kind | not opt-in, but only ever fires on a deliberate slab scan; dormant entirely if the build ships no token, and slab scanning still works without it |
| the Cardstock `ebay-comps` function | the user taps "Check eBay prices" on a sports card | the SEARCH TERMS for that one card — year, brand, player, number, grade — with the publishable key as `anon` and **no session token**, so what someone is pricing is not tied to their account. No collection data, no ids, nothing about the copy they own | user-initiated every time; there is no automatic or background lookup, and a build with no project configured shows the eBay link alone |
| card image CDNs | `<img>` rendering | standard image requests | — |
| the Cardstock `build-deck` function | AI deck builder run | the STRUCTURED request — game, format, style, budget, seed card names, **and the collection card list if the user enabled "use my collection"** — plus the session token. The prompt is assembled server-side and our key never reaches the browser | needs an account and a subscription |
| the Cardstock `scan-card` function | the same rescue, and the MTG printing tie-break, for a signed-in subscriber | that one camera frame as a JPEG, plus the session token; the model key stays server-side | off by default |
| `accounts.google.com` | the user turns on Drive backup | the OAuth consent flow for `drive.appdata` only; the script is injected on first use and **never at boot** | fully opt-in |
| `www.googleapis.com` (Drive) | Drive backup / restore | the backup JSON — the same object Settings → Export writes — into the user's **own** app-private Drive folder | fully opt-in |
| a friend's hosted binder URL | friend refresh | a plain GET, `credentials: 'omit'` | user-initiated |
| the shared card index, `lookup_card_data` | a card with **no picture at all** is on screen | that card's id (`mtg:…`), batched, with the publishable key as `anon` and **no session token** — the lookup is deliberately not tied to an account | on by default (`cardSourceLookup`), and it never fires for a card that already has art |
| the shared card index, `submit_card_data` | the user ticks "share this" while saving a card | the picture they attached and the fields they typed, plus the session token so a bad contribution can be traced and removed. **Not** their handle, display name, collection, or which cards they own | off by default (`cardSourceShare`), and the editor asks again per card |
| the Cardstock `stripe-escrow` function | opening a purchase, onboarding as a seller, shipping or confirming an order | the session token, the card id/name and the amounts, or an order id — **never an address**; the function reads one from Stripe and returns it to the seller without storing it | off by default; dormant entirely if the deployment has no Stripe secrets |
| `checkout.stripe.com` | the buyer is redirected to pay | whatever the buyer types into Stripe's own hosted checkout — card details and shipping address go to Stripe, never through us | only on a deliberate purchase |
| `connect.stripe.com` | a seller starts Connect onboarding | Stripe's hosted identity verification; **we never see a government ID or a bank number** | only when someone chooses to sell |
| the Cardstock `claim_referral()` RPC | an install that arrived through a friend's link finishes signing in | the referrer's `@handle` and the session token — **once per install**, then never again unless the device is signed out | never fires at all for an install that did not open such a link |
| a read of your own `referrals` row, then `founding_seats_left()` | the Subscription section renders for a signed-in account with no live subscription | the session token, and nothing else. The row is read-own under RLS, so this asks "was **I** referred" — never who referred whom; the seat count is a marketing number `anon` may ask for. Neither ever reaches `track()`: a handle is identity | needs an account; dormant entirely without a Supabase project |
| the Cardstock `ingest_events()` RPC | while `diagShare` is on **and** the disclosure has been answered | redacted event batches + a random per-install id + app version, as `anon` — **never the session token** | on by default outside the EU/EEA/UK, asked there; dormant entirely if the build has no Supabase project |

A cert lookup sends the certification number and nothing else — not the photo,
not the collection, not any identifier for the user. The number is already
printed on the outside of a slab that PSA themselves issued, so this reveals
nothing about the person holding it.

Because the token is ours rather than the user's, this is the one network call
in the app that is not individually opt-in. It is still tightly bounded: it
fires only on a deliberate slab scan of a PSA holder whose label carried a
cert, results are cached for months so a re-scan is silent, and a build with no
token never contacts PSA at all.

**Sports and slab scans never reach the cloud rescue below.** Not by policy but
by construction: the rescue lives inside `identifyViaOcr`, and neither
`identifySportsFrame` nor `identifySlabFrame` calls it. Sports has no catalog
for a returned name to be matched against, so there would be nothing for it to
do. If that ever changes, this page changes with it.

**No image leaves the device unless the user switches on the cloud rescue.**
Identification is Tesseract and canvas maths locally, and the card APIs are only
ever queried by name, set and number — that is the whole pipeline for every user
who leaves `cloudScanRescue` off, which is the default and is why the OCR engine
is self-hosted rather than CDN-loaded.

The rescue is the one exception, and it is narrow by construction:

- **It is off until the user turns it on.** Being signed in is not consent, and
  neither is paying: `cloudScanRescue` gates the hosted route and the
  bring-your-own-key route alike, because sending a camera frame somewhere is a
  different act from subscribing to a tier.
- **It uploads one frame, and only from a scan that is already in trouble.**
  Four shapes qualify. Every local pass failed; or the local answer is one of
  the specific shapes known to be confidently wrong (a bare Pokémon species
  that has a suffixed sibling in the catalog — the "Krookodile" that is really
  a Krookodile ex); or the card was identified but **nothing pinned which
  printing it is** — an MTG card whose collector line never read, whose name
  has printings in more than one frame, so the edition on screen is a fuzzy
  match's default guess (the printing tie-break, `docs/scanning.md`); **or the
  scan was still unsettled 2.5 seconds in** (`CLOUD_HEADSTART_MS`).
  The last two are the ones where a frame with a usable local answer can be
  uploaded, and the fourth is the widest thing on this page: a card the local
  passes would have got at four seconds now also sends its frame. The
  tie-break is narrow by construction — it asks which *printing*, never which
  card, it is checked before the upload that there is more than one frame to
  choose between, and a page scan never does it. The head start is bounded
  differently: a local answer aborts the request in flight, and a raced call is
  rationed to one per `CLOUD_RACE_COOLDOWN_MS` so a stubborn card cannot upload
  a frame per retry. What has not changed: with `cloudScanRescue` off, nothing
  is uploaded at all, ever.
- **The frame is sent, read, and not kept.** The hosted route holds the model key
  server-side so it never ships to a client; it records that a scan was spent
  against the month's allowance, not the picture or what was in it.

Everything else on this page still holds: the scan trace that carries real card
text stays on-device (see below), and analytics never learn what was scanned.

## Keys

| Key | Stored | Sent to | Used for |
| --- | ------ | ------- | -------- |
| Gemini API key | **ours, server-side only** — held as a Supabase secret by `scan-card` and `build-deck`, never in the bundle | Google only, from our edge functions | the AI deck builder and the scan rescue |
| pokemontcg.io key | **ours, compiled in** from `VITE_POKEMON_KEY` — no Settings field | pokemontcg.io only, as `X-Api-Key` | higher rate limits |
| PSA API token | **ours, compiled in** from `VITE_PSA_TOKEN` — not stored per user, no Settings field | psacard.com only, as a bearer token | resolving a scanned slab's cert to the exact card |
| Google Drive access token | **memory only — never stored** | Google only, as a bearer token | writing/reading the app-private backup folder |
| Google OAuth client id | compiled in from `VITE_GOOGLE_CLIENT_ID` | Google only | identifying the app during consent |

The Drive access token is deliberately absent from the table's "stored" column:
it lives about an hour, it is re-minted silently, and a credential that is never
written down cannot leak from a backup, a share link or a stolen device. There is
no identity scope either — the app asks for `drive.appdata` and nothing else, so
it never learns the user's name, email or Google account id. "Last backed up 3h
ago" is the whole of what it knows about them.

There is **no client secret**. A browser token flow does not use one; the client
id is public and ships in the bundle, which is expected and safe for this model.

Keys are never included in analytics events (`key`, `apikey`, `token` are on the
forbidden-key list) and never travel in a share link or backup.

## Analytics contract

`src/lib/analytics.ts` is **local-first diagnostics**: counts, timings and hashed
error identities. It is designed so that content *cannot* leak, not merely so
that it doesn't today.

1. **Fixed event whitelist.** `EVENT_TYPES` — `app_open`, `session_end`,
   `screen_view`, `scan_attempt`, `scan_failure`, `card_added`,
   `variant_selected`, `import_completed`, `backup_run`, `backup_restore`,
   `search`, `deck_created`, `ai_builder_run`, `price_refresh`, `friend_added`,
   `social_share`, `trade_update`, `want_update`, `sync_run`, `error`. Adding an
   event means adding it here.
2. **Redaction on write** (`redact()`), applied to every event before it is
   stored:
   - keys must match `^[a-z][A-Za-z0-9]{0,20}$`;
   - keys on the forbidden list are dropped outright, in three families:
     - *content* — `name`, `cardname`, `title`, `query`, `q`, `search`, `term`,
       `message`, `msg`, `text`, `detail`, `note`, `prompt`;
     - *identity and credentials* — `key`, `apikey`, `token`, `url`, `href`,
       `endpoint`, `email`, `user`, `id`, `handle`;
     - *postal and money* — `address`, `addr`, `street`, `line1`, `line2`,
       `city`, `state`, `region`, `zip`, `postcode`, `postal`, `country`,
       `phone`, `recipient`, `tracking`, `amount`, `price`, `total`,
       `subtotal`, `fee`, `cost`, `value`, `balance`, `payout`;
   - booleans pass; numbers pass rounded to 2 decimals; **strings pass only if
     they match `^[A-Za-z0-9_.:-]{1,32}$`** — so an enum like `hit` or `mtg`
     survives and a card name does not.

   The postal and money family is the one to understand, because nothing else
   would have caught it: a postcode carries no card text and `zip: '94110'`
   satisfies the string rule exactly. It is forbidden ahead of the feature that
   would supply one, since the failure mode is silent — an address in the log
   looks identical to a working event. Order values are still answerable
   through `amountBucket()`, the same way collection sizes go through
   `sizeBucket()`: a bucket is a count, an amount is a fact about one person's
   money.
3. **Errors are hashed.** `trackError` stores a sanitized component name and an
   FNV-1a hash of the message. The message text itself is never stored.
3b. **Failing cards are hashed, never named.** `scan_failure` carries the stage
   the pipeline died at plus `card` — `hashToken(readName)`, an FNV-1a hash over
   the name normalised for case, spacing, punctuation and accents. That groups
   repeat failures of one card across devices ("this card fails everywhere" is
   answerable) while the payload stays free of card names. A maintainer resolves
   a bucket by hashing *catalog* names, which needs the catalog rather than the
   log. Two caveats worth knowing: the hash is 32-bit, so within a large
   single-game catalog (Pokémon is ~20k names) there is a low but real chance of
   two cards sharing a bucket — the event's `game` field is what disambiguates —
   and a cached miss is deliberately *not* counted, since it is the same frame
   the pipeline already gave up on and counting it would just weight whichever
   card sat in front of the lens longest.
3c. **Who is here, without knowing who.** A random per-install id (minted in the
   analytics DB, not derived from anything about the device or person) plus
   `app_open` / `session_end` / `screen_view`, an install record (first seen,
   session count, active days), a coarse device shape, and collection size as a
   **bucket** — never an exact count. `clearAnalytics()` drops the install
   record along with the events.
4. **Upload is triply gated**, and each gate answers a different question:
   `DIAG_AVAILABLE` (does this build have a Supabase project at all),
   `diagConsentAt` (has this person actually been *told*), and `diagShare` (did
   they say yes). The middle gate is what makes an on-by-default defensible —
   nothing is posted before the disclosure has been shown, however `diagShare`
   came to be true. There is no endpoint or token field any more; both used to
   be typed into Settings, which made sharing nominally opt-in and practically
   impossible. Batches of 500, minimum 30s
   between flushes, 10s timeout, keepalive batches halved until under 60 KB.
   Progress is tracked by `flushedThrough`, so a failed upload simply retries
   the same events.
5. The payload carries a random per-device id (stored in the analytics DB), the
   app version and the redacted events. Nothing else.

**Scan traces are not analytics.** `scandebug.ts` holds raw OCR text, card names
and lookup scores. It is an in-memory ring of 24 entries, rendered on-device in
the "what the scanner saw" panel, and it leaves the device **only** if the user
explicitly taps Copy and pastes it somewhere. It must never be fed into
`analytics.ts`, and the analytics redaction above would strip it anyway.

## If you build a receiver

The receiver is `public.ingest_events(jsonb)` on Cardstock's own Supabase
project — `supabase/migrations/0007_analytics.sql`, which is also the only
documentation of its trust model. The client posts
`{p_batch: {app, v, device, firstSeen, sessions, activeDays, sentAt, events[]}}`
authenticated with the **publishable key**, as `anon`.

**The session JWT is deliberately never sent.** Posting as the signed-in user
would tie a content-free counter to an account, which is the one thing this log
is built not to do — `device` is a random per-install id and must never become
`auth.uid()`.

Reading is closed to everyone: RLS is on with no policy, and the table grants
nothing to `anon` or `authenticated`, so only `service_role` can query it.

**A receiver that expects some other schema is worse than none.** `flushTelemetry`
advances `flushedThrough` on any 2xx, so a receiver that answers 200 and drops
the batch — because it was written for a different app's columns — loses those
events permanently. Match the envelope above or answer non-2xx.

Four things to get right, three of
them learned the expensive way in a sibling project (`CorruptFun/viva-maya`,
whose `supabase/migrations/0010`, `0015` and `0019` are worth reading before you
write any of this):

1. **Bucket unknown event names — never reject them.** Cardstock is a PWA with a
   hand-written service worker, so users sit on several bundles at once. A
   receiver that only accepts today's vocabulary silently drops every event from
   every un-updated client. Normalise the name (lowercase, snake_case, length
   cap) and file anything unrecognised as `unknown`, where a client-side typo
   becomes *visible* instead of vanishing.
2. **Stamp receipt time server-side.** The client's `at` is its own clock and
   `sentAt` is advisory. A device with a wrong clock will otherwise bend every
   time-series query on the table.
3. **There is no idempotency key, so make the write idempotent or accept
   double-counting.** The client advances `flushedThrough` only on a 2xx, which
   is the safe direction — a *lost response* on an accepted batch means the same
   events are re-sent. If exact counts matter, have the client mint a per-event
   uuid and dedupe on it. And if the receiver is Supabase/PostgREST over an
   append-only table: `ON CONFLICT` **cannot execute** against a table with no
   SELECT policy — Postgres folds the (empty) SELECT policy list in as an extra
   `WITH CHECK` that is constant false, so every insert 401s, including the
   first. Put the conflict handling in a `SECURITY DEFINER` function instead.
   That is `0019`, and it cost that project its entire event stream while it was
   wrong.
4. **The receiver never needs to be reachable.** Analytics failing must never be
   a reason the app behaves differently. `flushTelemetry` already swallows
   everything and retries; keep it that way.

**Do not align this schema with viva-maya's.** They are different architectures
solving different problems — that project posts single rows to its own Supabase
with RLS as the trust boundary; this one posts a batched envelope to a
`security definer` function that validates and caps it. Sharing a table across
apps is what `docs/roadmap.md` §6 documents the cost of — migration numbers
collide and one app's firehose sits beside another's user data. The lessons
transfer; the schema does not.

## What a share actually contains

A profile share carries: your profile id, display name, note, scope, a
timestamp, and one row per shared card (card id, name, set, number, rarity,
finish, condition, quantity, for-trade count, an https image URL and the market
unit price), plus your want list if you have one.

**An https URL, specifically.** A card you photographed yourself carries an
inline `data:` image, and `httpsImage()` strips it out of both binder rows and
want rows on the way out. A photo taken on your table is not a side effect of
sharing a binder — contributing one is its own switch, asked separately.

- With the default `scope: 'trade'` only rows you flagged for trade travel, and
  the quantity shown is the for-trade count — not what you own.
- Opened sealed products never travel.
- No keys, no history, no decks, no other friends, no trades.
- **No orders and no address.** A purchase is not part of a share: it lives in
  `orders` on our project, readable only by its buyer and seller, and the
  shipping address is never in it — Stripe holds that, and the seller's app asks
  for it one request at a time while there is still something to post.

The share is a snapshot in a link or file. Nothing is published anywhere unless
the user sends it — or unless they explicitly turn on live sync and enter a
server address, at which point the same payload is `PUT` to that server.

## Rules for changing any of this

1. New analytics event → add it to `EVENT_TYPES`, and pass only enum-ish
   strings, booleans and numbers.
2. Never pass card names, search terms, URLs, error messages or key material
   into `track()` — even "temporarily for debugging".
3. New network destination → it must be optional, degrade cleanly, and be
   listed in the table above (and in the service worker's routing if it should
   or shouldn't be cached).
4. Anything decoded from a link, file, backup or server response goes through
   the `social.ts` sanitizers. There is one validation implementation.
5. Anything new that persists user content belongs in the `cardstock` DB so
   backup, restore and erase keep covering it.
6. A user's own photograph is user content. It may ride the backup and the
   vault, it must be stripped from anything that travels to another person by
   default, and publishing it needs its own opt-in — never a side effect of a
   switch that was about something else.
