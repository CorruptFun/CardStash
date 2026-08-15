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

### Caches

- `CatalogCache` (`catalogs`, keyed by game) — a whole TCGplayer catalog plus
  `cardGroups` (parallel array of group ids), `v` (catalog-shape version — rows
  from older builds are refetched, not trusted), `at`, and `productsAt` (when
  product lists were last fully fetched, enabling prices-only refreshes).
- `KvCacheRow` (`cache`, keyed by string) — small keyed blobs with a
  reader-checked TTL. Currently TCGplayer categories and per-game group
  indexes. `kvGet`/`kvPut` fail soft: quota noise reads as a cache miss.

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

Payloads on the wire: `ProfilePayload | TradePayload | ReplyPayload`, all
carrying `app: 'cardstock-social'`. In a trade payload the sender's side is
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
| `geminiKey` / `geminiModel` (`'gemini-flash-latest'`) | AI deck builder only. **Scanning never uses Gemini.** |
| `pokemonKey` (`''`) | Optional pokemontcg.io key (higher rate limits). |
| `diagShare` (`false`) | Opt-in telemetry upload. The destination is compiled in (`lib/diagconfig.ts`), not stored — uploads need both this toggle and a build that configured `VITE_DIAG_ENDPOINT` + `VITE_DIAG_TOKEN`. |
| `profileId` / `profileName` / `profileNote` / `shareScope` (`'trade'`) | Social identity and what a share includes. |

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
  "history": [...], "friends": [...], "trades": [...], "wants": [...]
}
```

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
