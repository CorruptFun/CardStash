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

There is no user account and no cloud copy. `requestPersistence()` at boot asks
the browser not to evict the data. The user's escape hatches are the JSON
backup, the CSV export, and Settings → Erase everything (`clearAllData()`; the
analytics DB is cleared separately by `clearAnalytics()`).

## Network egress, exhaustively

| Destination | Trigger | What is sent | Optional? |
| ----------- | ------- | ------------ | --------- |
| `api.scryfall.com` | MTG search / match / refresh | a card name, set, number, or ids | required for MTG data |
| `api.pokemontcg.io` | Pokémon search / match | a query string; the user's key in a header if set | required for Pokémon data |
| `api.tcgdex.net` | Pokémon fallback, non-English lookups | a name or set/number | as above |
| `db.ygoprodeck.com` | Yu-Gi-Oh | a name or passcode | as above |
| `api.lorcast.com` | Lorcana | a query | as above |
| `tcgcsv.com` | catalog games, sealed products | nothing but the path (static files) | as above |
| card image CDNs | `<img>` rendering | standard image requests | — |
| `generativelanguage.googleapis.com` | AI deck builder run | the prompt: game, format, style, budget, seed card names, **and the collection card list if the user enabled "use my collection"**; the user's key in a header | fully opt-in (needs a key) |
| a friend's hosted binder URL | friend refresh | a plain GET, `credentials: 'omit'` | user-initiated |
| the user's sync server | while `syncOn` | binder payload, trade/reply payloads, the device token | off by default |
| the diagnostics endpoint | while `diagShare` **and** a token are set | redacted event batches + a random device id + app version | off by default |

**No image ever leaves the device.** Card identification is Tesseract and canvas
maths locally; the APIs are only queried by name, set and number. Keep it that
way — this is why the OCR engine is self-hosted rather than CDN-loaded.

## Keys

| Key | Stored | Sent to | Used for |
| --- | ------ | ------- | -------- |
| Gemini API key | `settings.geminiKey` (localStorage) | Google only, as `x-goog-api-key` | the AI deck builder, nothing else |
| pokemontcg.io key | `settings.pokemonKey` | pokemontcg.io only, as `X-Api-Key` | higher rate limits |
| Diagnostics token | `settings.diagToken` | the user's configured endpoint only, as a bearer token | authorizing telemetry upload |
| Sync device token | `settings.syncToken` (minted locally) | the user's configured sync server only | proving ownership of the profile id |

Keys are never included in analytics events (`key`, `apikey`, `token` are on the
forbidden-key list) and never travel in a share link or backup.

## Analytics contract

`src/lib/analytics.ts` is **local-first diagnostics**: counts, timings and hashed
error identities. It is designed so that content *cannot* leak, not merely so
that it doesn't today.

1. **Fixed event whitelist.** `EVENT_TYPES` — `scan_attempt`, `card_added`,
   `variant_selected`, `import_completed`, `search`, `deck_created`,
   `ai_builder_run`, `price_refresh`, `friend_added`, `social_share`,
   `trade_update`, `want_update`, `sync_run`, `error`. Adding an event means
   adding it here.
2. **Redaction on write** (`redact()`), applied to every event before it is
   stored:
   - keys must match `^[a-z][A-Za-z0-9]{0,20}$`;
   - keys on the forbidden list are dropped outright: `name`, `cardname`,
     `title`, `query`, `q`, `search`, `term`, `message`, `msg`, `text`,
     `detail`, `note`, `prompt`, `key`, `apikey`, `token`, `url`, `href`,
     `endpoint`, `email`, `user`, `id`;
   - booleans pass; numbers pass rounded to 2 decimals; **strings pass only if
     they match `^[A-Za-z0-9_.:-]{1,32}$`** — so an enum like `hit` or `mtg`
     survives and a card name does not.
3. **Errors are hashed.** `trackError` stores a sanitized component name and an
   FNV-1a hash of the message. The message text itself is never stored.
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
