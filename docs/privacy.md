# Privacy, keys and what leaves the device

The product promise is "no accounts, no server required, your collection stays
yours". These are the mechanisms that make that true, and the rules that keep it
true when the code changes.

## Data at rest

Everything the user creates lives in browser storage on their device:

- IndexedDB `cardstock` — collection, decks, price history, scans, friends,
  trades, wants, plus card-data caches.
- IndexedDB `cardstock-analytics` — local diagnostics events.
- localStorage `cardstock-settings` — preferences **including API keys and the
  sync device token**, and `cardstock-version`.

There is no user account. `requestPersistence()` at boot asks the browser not to
evict the data. The user's escape hatches are the JSON backup, the CSV export,
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
| card image CDNs | `<img>` rendering | standard image requests | — |
| `generativelanguage.googleapis.com` | AI deck builder run | the prompt: game, format, style, budget, seed card names, **and the collection card list if the user enabled "use my collection"**; the user's key in a header | fully opt-in (needs a key) |
| `generativelanguage.googleapis.com` | a scan the local pipeline could not read or answered suspiciously, **while `cloudScanRescue` is on and a Gemini key is set** | that one camera frame as a JPEG, plus the user's key in a header | off by default |
| the Cardstock `scan-card` function | the same rescue, for a signed-in subscriber with no key of their own | that one camera frame as a JPEG, plus the session token; the model key stays server-side | off by default |
| `accounts.google.com` | the user turns on Drive backup | the OAuth consent flow for `drive.appdata` only; the script is injected on first use and **never at boot** | fully opt-in |
| `www.googleapis.com` (Drive) | Drive backup / restore | the backup JSON — the same object Settings → Export writes — into the user's **own** app-private Drive folder | fully opt-in |
| a friend's hosted binder URL | friend refresh | a plain GET, `credentials: 'omit'` | user-initiated |
| the user's sync server | while `syncOn` | binder payload, trade/reply payloads, the device token | off by default |
| the diagnostics endpoint | while `diagShare` **and** a token are set | redacted event batches + a random device id + app version | off by default |

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
- **It uploads one frame, and only a frame the local pipeline could not settle.**
  Either every local pass failed, or the local answer is one of the specific
  shapes known to be confidently wrong (a bare Pokémon species that has a
  suffixed sibling in the catalog — the "Krookodile" that is really a
  Krookodile ex). Scans that succeed locally never reach it, so opting in does
  not put ordinary scanning on the network.
- **The frame is sent, read, and not kept.** The hosted route holds the model key
  server-side so it never ships to a client; it records that a scan was spent
  against the month's allowance, not the picture or what was in it.

Everything else on this page still holds: the scan trace that carries real card
text stays on-device (see below), and analytics never learn what was scanned.

## Keys

| Key | Stored | Sent to | Used for |
| --- | ------ | ------- | -------- |
| Gemini API key | `settings.geminiKey` (localStorage) | Google only, as `x-goog-api-key` | the AI deck builder, and — only while `cloudScanRescue` is on — the scan rescue |
| pokemontcg.io key | `settings.pokemonKey` | pokemontcg.io only, as `X-Api-Key` | higher rate limits |
| PSA API token | **ours, compiled in** from `VITE_PSA_TOKEN` — not stored per user, no Settings field | psacard.com only, as a bearer token | resolving a scanned slab's cert to the exact card |
| Diagnostics token | `settings.diagToken` | the user's configured endpoint only, as a bearer token | authorizing telemetry upload |
| Sync device token | `settings.syncToken` (minted locally) | the user's configured sync server only | proving ownership of the profile id |
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
4. **Upload is doubly gated.** `flushTelemetry` no-ops unless `diagShare` is on
   **and** an endpoint **and** a token are set. Batches of 500, minimum 30s
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

No receiver exists. `diagEndpoint` is a free-form URL the user supplies, and the
client posts `{app, v, device, firstSeen, sessions, activeDays, sentAt, events[]}`
as JSON with `Authorization: Bearer <token>`. Four things to get right, three of
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
with RLS as the trust boundary; this one posts a batched envelope to whatever
endpoint the user names, with a bearer token as the whole trust model. Sharing a
table would mean giving Cardstock a backend, which decision 1 forbids. The
lessons above transfer; the schema does not.

## What a share actually contains

A profile share carries: your profile id, display name, note, scope, a
timestamp, and one row per shared card (card id, name, set, number, rarity,
finish, condition, quantity, for-trade count, an https image URL and the market
unit price), plus your want list if you have one.

- With the default `scope: 'trade'` only rows you flagged for trade travel, and
  the quantity shown is the for-trade count — not what you own.
- Opened sealed products never travel.
- No keys, no history, no decks, no other friends, no trades.

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
