# Data model

All user data lives on the device. Two IndexedDB databases and one localStorage
key, and nothing else.

| Store | Kind | Purpose |
| ----- | ---- | ------- |
| `cardstock` | IndexedDB (Dexie) | Collection, decks, price history, scans, caches, friends, trades, wants. |
| `cardstock-analytics` | IndexedDB (Dexie) | Local diagnostics events + flush bookkeeping. Separate DB so "erase everything" and analytics clearing are independent. |
| `cardstock-settings` | localStorage | zustand-persisted preferences (see below). |
| `cardstock-version` | localStorage | Last seen `APP_VERSION`, for the "Updated to vX" toast. |

## Identity conventions

- **Card id**: `` `${game}:${apiId}` `` — e.g. `mtg:0f1c…`, `pokemon:sv3-125`,
  `yugioh:46986414`, `riftbound:612345`. Stable across sessions; it is the join
  key between collection rows, deck rows, price history and shared payloads.
- **Sealed product id**: the same shape with a `tp-` prefixed api id —
  `` `${game}:tp-${productId}` ``. `cardById` refuses to resolve these (they
  need their TCGplayer group), so sealed refreshes route through
  `refreshCard` → `sealedRefresh`.
- **TCGdex-sourced Pokémon**: api id `dex-<id>` (English) or `dex-<lang>:<id>`
  for a localized catalog card. `parseDexApiId` routes refreshes back correctly.
- **Row ids** (collection/deck/deckCard/scan/deck): `uid()` — `crypto.randomUUID`
  where available.
- **Want key**: `` `${game}|${normalizeName(name)}` `` — wants are card-level,
  so any printing matches. Never compare wants by card id.
- **Profile id**: a `uid()` minted on first share and then kept forever
  (`settings.profileId`).

## Core types (`src/lib/types.ts`)

### `Card` — one printing of one card, normalized from any source

Every adapter (`scryfall.ts`, `pokemon.ts`, `ygo.ts`, `lorcast.ts`,
`tcgcsv.ts`) produces this shape and nothing else. Fields: `id`, `game`,
`apiId`, `name`, `setCode?`, `setName?`, `number?`, `rarity?`, `releasedAt?`,
`finishes?`, `imageSmall?`, `imageLarge?`, `typeLine?`, `subtext?`, `manaCost?`,
`cmc?`, `colors?`, `supertype?`, `printings?`, `sealed?`, `prices`, `links`.

- `finishes` is *this printing's* finish list when the API declares one;
  `finishOptions()` in `games.ts` falls back to the game-wide list and is never
  empty.
- `supertype` is the coarse grouping used by deck stats (Creature / Land /
  Spell / Trap / Extra Monster / "Sealed" / …).
- `sealed` marks the card as a sealed product and carries what a price refresh
  needs (`categoryId`, `groupId`, `kind`).

### `Prices` and `PriceEntry`

`Prices` = `{ best, bestFoil, entries, updatedAt }`. `best` is the non-foil
headline, `bestFoil` the best premium finish. `entries` is the raw list; every
consumer recomputes from `entries` rather than trusting the headline, because
data stored by pre-0.5 versions can carry EUR (Cardmarket) entries.
**The app is USD-only** — `'EUR'` survives in the `Currency` type solely so
readers can filter those rows out instead of mislabelling them as dollars.

`Finish`: `nonfoil | foil | etched | holo | reverse | firstEd`.
`Condition`: `M | NM | LP | MP | HP | DMG`.
`PriceKind`: `market | low | mid | high | trend | avg30`.

### `CollectionItem` — the unit of ownership

One row = *N copies of one printing in one finish and one condition*.

Row identity for merging is **cardId + finish + condition + setCode + number
+ opened + grade**. `addToCollection` and `updateItem` both merge into an existing row
on that identity; `updateItem` additionally merges when an edit collides with
another row, summing quantities and quantity-weighting the cost basis.

| Field | Notes |
| ----- | ----- |
| `qty` | Copies owned. `setItemQty(0)` deletes the row. |
| `opened` | Sealed products only. `false` = still sealed, `true` = cracked. **Opened rows price at zero** (`itemRawUnitPrice` returns null) — the pulls get scanned in as singles. Sealed and opened copies never merge. |
| `grade` | Slab details (`GradeInfo`) when the copy is graded. **Part of the merge key** — a PSA 10 never merges into the raw row. The *cert* is not: two PSA 10s of the same card are interchangeable. Available to every game, not just sports. |
| `marketValue` | Collector-set value per copy, USD. **Overrides every computed price** and is deliberately *not* scaled by the condition factor — they priced the copy in front of them. For sports it is the only figure there is (no price feed exists). |
| `purchasePrice` | Per-copy cost basis, USD. Merges are quantity-weighted averages. |
| `forTrade` | Copies offered for trade, `0 ≤ forTrade ≤ qty`. **Every write clamps through `tradeCount()`**; `0` stores as `undefined`. |
| `card` | A denormalized snapshot of the `Card`, so the collection renders offline. `applyCardUpdate()` pushes fresh prices into every row that shows a card. |

`applyCardUpdate` reshapes a freshly fetched card to the row's chosen printing
(`cardForItem`): games where a printing is its own api id match directly; a YGO
row re-picks its set variant so a refresh doesn't silently revert it to the
default printing.

### Binders are also objects: pages and printed labels

`CustomBinder` (above) is a named selection with an audience. Most of them are
also a physical thing on a shelf, and two additions say so — without a second
concept, and without a second table:

- **`BinderCard.page`** — 1-based, stamped when the copy arrived from a binder
  page scan, absent when it was added by hand. It lives on the BINDER row, not
  the collection row, because the same copy can sit in two binders and "page 3"
  is true of only one of them. `addToBinder(binderId, itemId, qty, page)` keeps
  the page a copy was first seen on rather than overwriting it: re-reading a
  page must not move a card the earlier pass already accounted for.
- **A printed label** — `binderUrl()` builds `<origin><path>#/binders/<id>`
  from the app's own location, so a label printed from the deployed site opens
  the deployed site and one printed from a self-hosted copy opens that. It
  rides the FRAGMENT (a printed label must work offline, and a fragment is
  never sent to a server), it carries no cards, and `binderCode()` prints the
  id underneath in groups of five for a sticker too scuffed to scan.

`lib/qr.ts` is a dependency-free QR encoder that exists for that label alone —
you print one in the room the binder is in, which is exactly where an image API
would fail. `components/BinderLabel.tsx` is the sheet; the print stylesheet at
the end of `styles.css` is what gets it onto paper without the app around it.

### `GradeInfo` — a grade is a property of the copy

`{ company, grade, label?, cert?, qualifier? }`, on `CollectionItem` and never
on `Card`: the card is the printing, the grade describes the object in the
holder. Folding it into the card id would fork the catalog eleven ways and
break every price lookup. `grade: 0` is an AUTHENTIC slab — graded, unnumbered.

`slab.ts` owns both the parser and `sanitizeGrade`, which the backup path and
`social.ts` both reuse — one validation implementation, per the rule in
[extending.md](extending.md). Grades travel on `SharedCard` so a trade shows
what it really is, and round-trip through a CSV `Grade` column.

### `SportsInfo` — what a sports card is identified by

Present on `sports` cards only. Sports has no catalog, so these attributes —
`sport`, `year`, `brand`, `product`, `player`, `team`, `parallel`, `serial`,
`rookie`, `auto`, `relic` — *are* the identity rather than a description of a
looked-up one, and the card id is a deterministic slug over the subset that
distinguishes one printing from another. See
[card-data.md](card-data.md#sports-cards); `sportsSlug` is a wire format.

`Sport` is a field rather than nine more `Game` literals on purpose: sports
collectors organize by player, set and year, and every `Record<Game, …>` table
in the app would otherwise multiply. Splitting later is a data migration.

### Decks

`Deck` = `{ id, game, name, format?, coverCardId?, createdAt, updatedAt }`.
`DeckCard` = `{ id, deckId, cardId, qty, board, card }` with
`board: 'main' | 'side' | 'extra'`; the compound index `[deckId+cardId+board]`
is what makes "add one more" a single lookup.

### `PricePoint` — the history series

Keyed `[cardId+date]` with `date` as `YYYY-MM-DD` (UTC). Written by
`recordPricePoint()` on every scan and every card refresh, so history accrues
as a side effect of normal use. `pruneHistory(keepDays = 400)` runs at boot.
Readers filter to `currency === 'USD'` — one line, one currency.

### `ScanRecord` — the scan tray

Capped at 30 rows (`SCAN_TRAY_LIMIT`). Re-scanning the card already at the head
refreshes that row instead of stacking a duplicate tile.

Removing a scan only clears the tile — a card collect mode already filed stays
filed, and is removed in Collection. What the tray *shows* is narrower than
what it stores: `ScanView` hides a scan whose card has a collection row touched
at or after `at`, so a card you have since filed stops offering itself for a
second add, while a card you already owned before the scan (a price check)
keeps its tile. The rule is derived from the two tables by the live query, not
stamped on the record, so undoing the add brings the tile back and no second
copy of the fact can drift. Collect mode is exempt: it files every confident
scan itself, so the filter would empty the tray on every hit.

`finish` and `grade` are what the scanner READ off the physical copy, kept so
the batch-add screen files the copy that was in frame rather than the printing's
default; a re-scan that reads a finish replaces a blank one but never clears a
reading with nothing. Both are absent on rows the tray already held when batch
add landed.

`added` means this scan has been filed — by Collect mode or by the batch screen.
**The tray stays a log either way**: a filed row is not removed, it is marked,
and the mark is what stops the batch screen offering the same copy a second
time. Undoing either add clears it (`markScansAdded(ids, false)`), because a
stale mark would silently refuse a card the user is entitled to re-file.

### Caches

- `CatalogCache` (`catalogs`, keyed by game) — a whole TCGplayer catalog plus
  `cardGroups` (parallel array of group ids), `v` (catalog-shape version — rows
  from older builds are refetched, not trusted), `at`, and `productsAt` (when
  product lists were last fully fetched, enabling prices-only refreshes).
- `KvCacheRow` (`cache`, keyed by string) — small keyed blobs with a
  reader-checked TTL. Currently TCGplayer categories and per-game group
  indexes. `kvGet`/`kvPut` fail soft: quota noise reads as a cache miss.

### `CardPatch` — the picture and details a catalog never had

Keyed by the `cardId` it patches (one row per card, so an upsert cannot produce
two). Holds `image` (a bounded `data:` URL), `imageHash`, `fields` (only the
keys the user changed), `base` + `baseImage` (what those keys said before, so
undo is exact and works offline), `custom` (this card exists nowhere else),
`origin` (`local` | `community`) and `shared`/`sharedAt`.

Rules that hold everywhere it is used, all enforced in `lib/cardpatch.ts`:

- **Overlay, never replacement** — `mergePatch` lays the patch over the
  catalog's card; prices are never patchable, and `Card.patched` is a
  display-only marker recomputed on every merge.
- **Only inline rasters** — `sanitizeImage` accepts `data:image/(png|jpeg|webp)`
  under `MAX_IMAGE_BYTES` and nothing else. Remote URLs, `blob:` and SVG are
  refused because this value becomes an `<img src>` in a dozen places.
  `baseImage` has its own gate (`https:` only), for the same reason in reverse.
- **`custom-…` ids are minted from the printed facts** and must stay stable —
  changing `customSlug` renames every custom card anyone owns.
- Custom cards carry **no prices**, like sports cards, and are skipped by
  `refreshCard` and the bulk refresh.

### Social types

`SharedCard` is the wire form of a collection row: printing identity, finish,
condition, `qty`, `forTrade`, `image`, and `price`. **`price` is the finish's
market unit with condition NOT applied** — viewers multiply by the condition
factor themselves (`sharedRowValue`).

`WantRow` (local) / `SharedWant` (wire) are card-level.
`Friend` is a followed collector's last imported snapshot plus `sourceUrl`
(for one-tap refresh), `exportedAt` (their stamp — the freshness test) and
`lastDelta` (+added/−removed from the last refresh).
`TradeRecord` stores `give`/`get` **from the local user's perspective**;
`direction` says who proposed it. Statuses: `proposed · accepted · declined ·
completed · canceled`.

`CustomBinder` / `BinderCard` are binders the user builds by hand: a named
selection with its own `visibility` (`private | friends | public`) and its own
`tradeable` flag. **`BinderCard.itemId` points at a `CollectionItem`, not at a
card** — finish, condition, grade and price come off the copy owned, which is
why a card patch does not need a fourth denormalized `Card` chased through this
table. `SharedBinder` is the stored/wire form on a friend's record.

`SocialLink` is one place a collector can be reached — `{ platform, value }`
over a **closed** platform vocabulary, with the handle stored and the URL built
from a table in `lib/profilelinks.ts`, so an icon can never point somewhere it
does not claim to. It hangs off `ProfilePayload`/`Friend` rather than off the
hosted `profiles` row, which is what makes it inherit the binder's audience —
see [social.md](social.md) and decision 23.

`ChatThread` / `ChatMessage` (`lib/messaging.ts`) are **server-only**: there is
no Dexie table and no backup entry for them, deliberately (decision 24).

Payloads on the wire: `ProfilePayload | TradePayload | ReplyPayload |
BinderPayload`, all carrying `app: 'cardstock-social'`. A `BinderPayload` is a
separate kind on purpose — importing one files it under its sender and never
touches their card list. In a trade payload the sender's side is
`offer` and what they want back is `want`; `tradeFromPayload` flips that into
the receiver's `give`/`get`. See [social.md](social.md).

## Dexie schema and migrations (`src/lib/db.ts`)

Database name `cardstock`. Versions are additive; only v2 has an upgrade
function.

| Version | Change |
| ------- | ------ |
| 1 | `collection: 'id, cardId, game, name, addedAt'`, `decks: 'id, game, updatedAt'`, `deckCards: 'id, deckId, cardId, [deckId+cardId+board]'`, `history: '[cardId+date], cardId'`, `scans: 'id, at'` |
| 2 | `history` gains a `date` index; **upgrade** stamps `currency: 'USD'` on existing points |
| 3 | `catalogs: 'game'` — day-cached TCGplayer catalogs |
| 4 | `cache: 'key'` — small keyed caches (group lists) |
| 5 | `friends: 'id, addedAt'`, `trades: 'id, friendId, status, createdAt'` |
| 6 | `wants: 'key, game, addedAt'` |
| 7 | `collection` gains `updatedAt`, `tombstones: 'id, at'`; **upgrade** backfills `updatedAt` from `addedAt` |
| 8 | `patches: 'cardId, game, updatedAt'` — user-authored card images and fields. `custom` is deliberately **not** indexed: it is a boolean, IndexedDB has no boolean key type, and an index on one silently stores nothing |
| 9 | `binders: 'id, updatedAt'`, `binderCards: 'id, binderId, itemId, cardId, [binderId+itemId]'` — binders the user builds by hand. Keyed on the **collection row**, not the card, so a binder holds the copy actually owned; the compound index makes "already in this binder?" one lookup. `visibility` is not indexed — three strings on a table of tens of rows |

Adding a version: append a `this.version(n).stores({...})` block, never edit an
existing one, and supply `.upgrade()` if stored rows need reshaping. See
[extending.md](extending.md).

### Write-path invariants

These are the rules the CRUD layer enforces. Anything new that writes
collection rows must uphold them.

1. `forTrade` is clamped to `[0, qty]` on **every** path — add, qty change,
   remove copies, edit, backup import, trade application.
2. Sealed vs opened rows never merge (`sameOpened`).
3. Cost bases combine as quantity-weighted averages (`averagePrice`).
4. `applyTradeToCollection` decrements the *given* side preferring the exact
   printing, then rows already flagged for trade; copies the collection no
   longer holds are reported as `short` rather than blocking the booking. The
   *received* side arrives through the normal `addToCollection` path. The trade
   flips to `completed` with `appliedAt` set, in the same transaction.
5. `recordIncomingTrade` never overwrites a proposal that has already been
   answered (status ≠ `proposed` → `'kept'`).
6. `applyTradeReply` refuses to reopen a `completed`/`canceled` trade, so a
   stale link tapped twice is inert.
7. `removeFriend` deliberately leaves trades intact — a trade carries its own
   copy of the name and cards, so it survives unfollowing.
8. A patch write goes through `savePatch`/`deletePatch`, never `db.patches`
   directly. Both keep the in-memory index in step and re-stamp the
   denormalized `card` on every collection, deck and scan row for that card —
   otherwise a fix would land on the card sheet and leave the collection grid
   showing the picture the user just replaced. `deletePatch` reads the outgoing
   patch **before** dropping it, because peeling an edit back off needs to know
   what it covered.

## Settings (`src/lib/settings.ts`)

Persisted to localStorage under `cardstock-settings`. Defaults in parentheses.

| Key | Meaning |
| --- | ------- |
| `gameFilter` (`'auto'`) | Scan-screen game commitment. Always inside `enabledGames`; a non-auto value hints identification, which buys the exact collector crop, a longer per-API budget and the collector-line rescue. |
| `enabledGames` (all) | Games shown anywhere in the app. Kept in `GAMES` order, never empty. Turning a game off hides it from search/scan/deck pickers and stops downloading its catalog — **existing collection and deck data stays untouched and visible**. |
| `collectMode` (`false`) | Scan screen: every confident hit is added to the collection. |
| `haptics` (`true`) | Vibration feedback. |
| `cameraApproved` (`false`) | The camera was approved here before → skip the start gate. Cleared if the browser later denies. |
| `iosCameraHintShown` (`false`) | The one-time iOS permission explainer has been dismissed. |
| `installHintDismissed` (`false`) | The "install to keep your collection" banner was dismissed. Independent of actually installing — `IS_STANDALONE` suppresses the banner on its own. |
| `cloudSalt` / `cloudKeyCheck` (`''`) | Vault KDF salt and key fingerprint. Neither is secret; both let a returning device derive its key and reject a wrong passphrase without a round trip. |
| `cloudRevision` (`0`) / `cloudSyncedAt` (`0`) | Server revision last seen and last successful sync. A stale revision means merge before writing. |
| `cloudAuto` (`true`) | Reserved for syncing after collection writes; nothing schedules it yet. |
| `pokemonKey` | pokemontcg.io key, from `VITE_POKEMON_KEY` at build time — **not user-editable**, and `merge()` always takes the build's value over a persisted one. `geminiKey`/`geminiModel` are gone: the deck builder runs on our key through `build-deck`. |
| `diagShare` (on outside the EU/EEA/UK) / `diagConsentAt` (`0`) | Telemetry upload. The destination is not a setting (`lib/diagconfig.ts` → the app's own Supabase RPC). Uploads need the toggle **and** `diagConsentAt` — until the disclosure has been answered nothing is posted, and `noteDiagConsent()` buries the pre-consent backlog as it answers. An install predating the field is forced back to off by `merge()` rather than opted in by a new default. |
| `profileId` / `profileName` / `profileNote` / `shareScope` (`'trade'`) | Social identity and what a share includes. |
| `profileLinks` (`[]`) | Social accounts shown beside the binder. Re-sanitized on rehydrate as well as on the wire, because localStorage is editable and these become `<a href>`s in other people's apps. |
| `messageUnread` (`0`) | Unread messages, cached so the nav badge is right on the first frame. A cache of a server fact, never the authority; cleared on sign-out. |
| `referralFrom` (`''`) / `referralAt` (`0`) | The `@handle` whose link brought this install here, and when the server last gave a **final** answer about it. Written at boot from `?via=` and never overwritten — one referrer per account, for ever (`lib/referral.ts`). It is stored rather than read at the point of use because sign-in destroys the URL: the Google route returns to `origin + pathname` with query string and fragment both gone. `referralAt` is cleared on sign-out. |
| `cardSourceLookup` (`true`) | May the app ask the shared card index about cards that have **no picture at all** (`lib/cardsource.ts`)? On by default: it sends a card id and gets a picture back, the same class of request already made to Scryfall on every search, aimed at our project instead of theirs — never the session token, never a background sweep, never for a card that already has art. |
| `cardSourceShare` (`false`) | May the pictures and details this user fills in be contributed back? Off by default, and the switch that matters: a photo of a card is a photo the user took, and publishing it is a decision. The editor asks again per card on top of this. |

**Session tokens are deliberately NOT here.** They live under their own
`cardstock-cloud-session` localStorage key so they can never be swept into a
settings export. The vault passphrase and derived key are never persisted at
all — a reload asks again, which is the cost of the server being unable to
read the vault.

**Rehydration is sanitized** (`merge` in the persist config): installs predating
`enabledGames` get the full list, stored lists drop games this build doesn't
know, an empty result falls back to all games, and a `gameFilter` pointing
outside the list reverts to `'auto'`. Never bypass this by reading localStorage
directly.

`toggleGame` refuses to remove the last enabled game and resets `gameFilter` to
`'auto'` when the filtered game is switched off.

## Backup format

`exportBackup()` produces:

```jsonc
{
  "app": "cardstock", "version": 1, "exportedAt": "<ISO>",
  "collection": [...], "decks": [...], "deckCards": [...],
  "history": [...], "friends": [...], "trades": [...], "wants": [...],
  "patches": [...], "binders": [...], "binderCards": [...]
}
```

`patches` is optional on the way **in** (every backup written before v8 lacks
it) and always written on the way **out** — a photo the user took of their own
card exists nowhere else in the world, so omitting it would make "restore"
quietly lossy.

`binders`/`binderCards` are optional on the way in for the same reason (nothing
written before v9 has them) and always written out: the cards are already in
`collection`, but the **grouping** exists nowhere else. `sanitizeBackup` forces
any visibility it does not clearly recognise back to `private` — a restore must
never be the thing that publishes a binder.

`exportBackup({ imageBudget })` caps the imagery a backup carries, and **only
the vault passes one** (`VAULT_IMAGE_BUDGET`, ~6 MB): it is a single text
column rewritten on every sync, where the JSON export and the Drive backup are
real file writes. Patches past the budget are omitted **whole**, newest kept —
never stripped of their image. `mergeBackups` is a union, so an omitted row
costs nothing, but an image-less row could win on `updatedAt` and delete a
photo that existed nowhere else. Text-only patches are free and always travel.

`importBackup()` runs everything through `sanitizeBackup()` first and then
`bulkPut`s into one transaction (a merge, not a replace). Sanitization is
defensive by construction — a backup file is untrusted input:

- rejects anything whose `app` isn't `cardstock` (legacy `loupe` accepted);
- `collection` is required to be an array, the rest default to empty;
- rows missing `id`/`cardId`/`card` are dropped, not repaired;
- `game`, `finish`, `condition` are validated against the known enums and fall
  back to `mtg` / `nonfoil` / `NM`;
- quantities floor to non-negative integers, `forTrade` re-clamps, prices must
  be finite and positive, `addedAt` must be a plausible timestamp;
- patches go through `sanitizePatch`, so an image in a backup file is held to
  the same rule as one from a stranger's link;
- friends, trades and wants go through the **same sanitizers `social.ts` uses
  for pasted links** (`sanitizeFriendRecord`, `sanitizeTradeRecord`,
  `sanitizeWantRecord`) — one validation implementation, not two.

`clearAllData()` clears every user table (including `catalogs`) in one
transaction; analytics is cleared separately by `clearAnalytics()`.

## Analytics store (`cardstock-analytics`)

`events: '++id, at, t'` and `meta: 'key'`. Events are pruned to 5,000 rows once
they exceed 5,200 (checked every 32 inserts). `meta` holds the device id, the
`flushedThrough` event id and `lastFlushAt`. Contents and the redaction contract
are documented in [privacy.md](privacy.md).
