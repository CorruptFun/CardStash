# Architecture

## What the app is, structurally

A single-page React application shipped as static files. There is no server
component in the deployed product: the HTML/JS/CSS bundle is served from GitHub
Pages, and everything else happens in the browser tab.

```
┌──────────────────────────── the device ─────────────────────────────┐
│                                                                     │
│  React views ──▶ zustand stores ──▶ Dexie (IndexedDB)               │
│       │              (UI + settings)      │                         │
│       │                                   ├─ cardstock (user data)  │
│       ├──▶ lib/* (pure-ish logic)         └─ cardstock-analytics    │
│       │      identify · prices · portfolio · deckstats · social      │
│       │                                                             │
│       ├──▶ Tesseract worker ×2  (OCR, self-hosted wasm)             │
│       ├──▶ camera (getUserMedia) + canvas pixel analysis            │
│       └──▶ service worker (shell / image / ocr-engine caches)       │
│                                                                     │
└───────────────┬──────────────────────────┬──────────────────────────┘
                │ read-only card data      │ opt-in only
                ▼                          ▼
   Scryfall · pokemontcg.io · TCGdex     Gemini (AI deck builder)
   YGOPRODeck · Lorcast · tcgcsv.com     Supabase (vault · social ·
                                          orders · ingest_events)
```

Everything above the line works offline once the shell and OCR engine are
cached. Everything below the line is optional, degradable, or user-initiated.

## Layers and dependency direction

Dependencies point downward. Nothing in `src/lib/` imports a view; nothing in a
view reaches past `lib` to an HTTP endpoint directly.

| Layer | Directory | Rules |
| ----- | --------- | ----- |
| Screens | `src/views/` | One file per screen. Owns layout + user intent. Talks to `lib` and the stores. |
| Shared UI | `src/components/` | Reusable widgets (sheet, icons, toasts, steppers, share actions). No domain logic. |
| Hooks | `src/hooks/` | `useScanner.ts` — the camera/scan loop state machine. |
| Stores | `src/store/ui.ts`, `src/lib/settings.ts` | Ephemeral UI state and persisted preferences. |
| Domain / IO | `src/lib/` | Data model, DB access, card APIs, scan pipeline, pricing, social codec. |
| Platform | `src/sw.js`, `vite.config.ts`, `index.html`, `public/` | Caching, build-time asset emission, PWA metadata. |

## The `src/lib/` map

| Module | Lines | Responsibility |
| ------ | ----: | -------------- |
| `types.ts` | 326 | Every stored/wire type. The vocabulary of the app. |
| `games.ts` | 102 | The `GAMES` list and per-game tables (labels, finishes, which games have a cheap by-name API). |
| `db.ts` | 733 | Dexie schema + every write to user data. Backup export/import + sanitization. |
| `settings.ts` | 114 | zustand-persist preference store (localStorage). |
| `identify.ts` | 1055 | The scan pipeline orchestrator: cache, orientation, OCR passes, lookups, collector-line rescue. |
| `ocr.ts` | 648 | Tesseract workers, image preprocessing, name-band geometry, name-candidate extraction. |
| `corner.ts` | 283 | Collector-line crop regions and the parsers that dig set code / number / passcode out of noisy OCR. |
| `vision.ts` | 939 | Frame analysis (motion, sharpness, card region), deskew/crop refinement, foil sheen, perceptual hash, sideways detection, **and `detectCardRegions` — the multi-card detector**. |
| `multiscan.ts` | 203 | Binder-page / multi-card scanning: detect regions, crop, identify each on a reduced budget, hand the lot to a review screen. Writes nothing itself. |
| `entitlement.ts` | 40 | The seam for the planned paid tier. A `GATED` table, every row `false`. Checked at entry points only — never at `detectCardRegions`. |
| `camera.ts` | 251 | `getUserMedia` lifecycle, torch/exposure controls, iOS stream parking, frame capture (incl. low-light stacking). |
| `scandebug.ts` | 76 | In-memory ring of per-attempt diagnostic traces. Local only. |
| `cardsearch.ts` | 276 | The multi-game facade: search / match / by-id / refresh / printings, and the cross-game race used by scanning. |
| `scryfall.ts` | 243 | Magic. |
| `pokemon.ts` | 614 | Pokémon: pokemontcg.io primary + TCGdex fallback, multi-language collector sweep. |
| `ygo.ts` | 185 | Yu-Gi-Oh (YGOPRODeck), incl. per-printing variants. |
| `lorcast.ts` | 114 | Lorcana. |
| `tcgcsv.ts` | 786 | TCGplayer catalog mirror: the five catalog-backed games, plus the sealed-product group layer for *all* games. |
| `sealed.ts` / `sealedmatch.ts` | 155 / 102 | Pack/box identification. `sealedmatch` is the pure, node-testable scoring half. |
| `sports.ts` / `sportsparse.ts` | 280 / 470 | Sports cards. **No catalog exists**, so `sportsparse` (pure, node-testable) reads the identity off the card and `sports.ts` synthesizes the `Card`. Search is local recall over the collection and scan tables. |
| `slab.ts` | 200 | Graded-slab labels: company, grade, cert, qualifier — pure, and the home of `sanitizeGrade`, which the backup and social paths both reuse. |
| `psa.ts` | 230 | PSA cert lookup with our compiled-in token. Non-fatal on every failure, dormant when the build ships no token, and quota-aware (a 429 stands lookups down for hours). |
| `prices.ts` | 213 | Price entry selection, condition factors, per-item unit price, comps pivot, money parsing. |
| `portfolio.ts` | 270 | Value time series, cost basis / P&L, movers, per-card trend. |
| `deckstats.ts` | 253 | Boards, per-game deck rules and warnings, curve/colour/type stats, owned-vs-missing, decklist text. |
| `social.ts` | 618 | Profile/trade/reply payload build, encode/decode, and **every sanitizer for untrusted input**. |
| `sync.ts` | 267 | The optional live-sync client and poll loop. |
| `drive.ts` | 340 | Opt-in backup to the user's **own** Google Drive (`appDataFolder`). Dormant without `VITE_GOOGLE_CLIENT_ID`; loads the third-party Google script on first use, never at boot. |
| `gemini.ts` | 211 | The AI deck builder — the app's only Gemini use. |
| `analytics.ts` | 860 | Local diagnostics store, redaction, install/session identity, the consent gate (`noteDiagConsent`) and the batched upload. |
| `diagconfig.ts` | 32 | Where diagnostics post: `ingest_events()` on the app's own project. No credential of its own — see decision 20. |
| `importexport.ts` / `csv.ts` | 241 / 62 | Collection CSV import/export and a CSV parser. |
| `demo.ts` | 431 | `?demo=1` seed data. |
| `fetchJson.ts` | 40 | `fetch` + JSON + timeout + abort linking. Every card API uses it. |
| `util.ts` | 122 | ids, dates, money formatting, Levenshtein/`similarity`/`nameScore`/`normalizeName`, external links, haptics. |
| `version.ts` | 3 | `APP_VERSION` — one source of truth. |

## Boot sequence (`src/main.tsx`)

1. `requestPersistence()` — ask the browser not to evict our IndexedDB.
2. If `?demo=1` **and** the DB is empty, seed demo data.
3. Render `<App/>` into `#root`.
4. `pruneHistory()` — drop price points older than 400 days.
5. `installErrorHooks()` — window `error` / `unhandledrejection` → hashed
   analytics events (never message text).
6. `installTelemetryFlusher()` — idle + 60s interval + on-hide flush attempts
   (no-ops unless the user opted in *and* set a token).
7. `startSyncLoop()` — 20s poll, gated on `syncOn` + visibility.
8. Service worker registration (skipped with `?nosw=1`):
   - `announceVersion()` compares `localStorage['cardstock-version']` to
     `APP_VERSION` and toasts "Updated to vX" once after an update lands.
   - `wireUpdateFlow()` — a waiting worker surfaces an "Update ready · Restart"
     toast; tapping posts `SKIP_WAITING`; the `controllerchange` reloads once.
   - `pollForUpdates()` — `registration.update()` on tab-visible and hourly.

`App.tsx` additionally schedules `warmOwnedCatalogs()` 3.5s after mount, so the
TCGplayer catalogs of games the user demonstrably plays are warm before the
first search or scan needs them.

## Routing

Hash-based, parsed in `App.tsx` (`parseRoute`). No router library.

| Hash | Route | View |
| ---- | ----- | ---- |
| `#/` or anything unknown | `scan` | `ScanView` |
| `#/search` | `search` | `SearchView` |
| `#/collection` | `collection` | `CollectionView` |
| `#/decks` · `#/decks/:id` | `decks` | `DecksView` (list or detail) |
| `#/builder` | `builder` | `BuilderView` (AI deck builder) |
| `#/friends` · `#/friends/:id` | `friends` | `FriendsView` / `FriendBinderView` |
| `#/trades` · `#/trades/:id` | `trades` | `TradeView` |
| `#/settings` | `settings` | `SettingsView` |
| `#/x?d=<blob>` | `ingest` | `IngestView` — the share-link landing screen |

Two behaviours worth knowing:

- The scan screen is **never unmounted** — it is rendered inside a `hidden`
  wrapper and receives `active`, so its scan tray, mode pills and gate state
  survive a tab hop. Every other view mounts/unmounts. The flip side: nothing
  tears the camera down for it, so `ScanView` releases it on `!active` itself
  (see scanning.md §1) — an unmounted view would have got that for free.
- Any hash change closes the card bottom sheet (`uiStore.closeSheet()`).

## State: three stores, three lifetimes

| Store | Where it lives | Lifetime | Contents |
| ----- | -------------- | -------- | -------- |
| `useSettings` (`lib/settings.ts`) | localStorage `cardstock-settings` via zustand `persist` | forever | Preferences, API keys, profile identity, sync config. Rehydration is **sanitized** (see [data-model.md](data-model.md)). |
| `uiStore` (`store/ui.ts`) | memory (vanilla zustand store + `useStore`) | tab session | Bottom-sheet request, toasts, search prefill, AI-builder seed cards. |
| Dexie live queries | IndexedDB `cardstock` | forever | Everything the user owns. Views subscribe with `useLiveQuery`, so any write anywhere re-renders every dependent screen. |

There is no global app reducer and no context provider tree; screens read what
they need directly.

### `guarded()` — the write contract

Every DB write initiated by the UI goes through `guarded()` in `store/ui.ts`.
It catches the failure that actually happens on phones — storage quota — and
turns it into a toast ("Storage is full — export a backup, then remove some
cards") instead of an unhandled rejection. New write paths must use it.

## Cross-cutting mechanisms

**HTTP.** `fetchJson()` wraps every card-API call: JSON, a default 12s timeout,
non-2xx → `Error("HTTP <status>: <body slice>")`, and `linkAbort()` so a
caller's `AbortSignal` cancels the request. `isAbort()` distinguishes
abort/timeout from real failures — used everywhere to decide whether to fall
back or to propagate.

**Aborts.** The search box aborts on every keystroke; the scanner aborts its
in-flight identification when stopped. One deliberate exception: `tcgcsv.ts`
runs its catalog download **signal-free** and shares one in-flight promise per
game, because letting a keystroke cancel (or truncate) the day-long catalog is
how whole sets went missing for hours.

**Caching layers**, from shortest-lived to longest:

| Cache | Where | TTL | Purpose |
| ----- | ----- | --- | ------- |
| frame hash cache | `identify.ts` memory, 60 entries | 30s for misses | Don't re-identify the same card sitting on the table. |
| printing variants | `cardsearch.ts` memory | 10 min | The card sheet's edition picker. |
| group contents | `tcgcsv.ts` memory | 30 min | One TCGplayer set's products. |
| catalog (per game) | memory + Dexie `catalogs` | 20 h (5 min if incomplete) | Whole-catalog search for API-less games. |
| group index / categories | Dexie `cache` (kv) | 20 h / 7 d | Sealed-product set indexes. |
| SW shell cache | Cache Storage, build-id keyed | until next deploy | Offline app shell. |
| SW image cache | Cache Storage, capped 480 | stale-while-revalidate | Card art from the CDNs. |
| SW ext cache | Cache Storage | cache-first | The self-hosted OCR engine. |

**Diagnostics.** `scandebug.ts` keeps a 24-entry ring of per-attempt traces
(what each OCR pass read, which candidates were tried, what scored what). It
feeds the on-device "what did the scanner see?" panel and the regression
harness's failure attribution. It contains card text, so it must **never** feed
`analytics.ts` — see [privacy.md](privacy.md).

## Network egress

Nothing here is required for the app to function; each degrades to "no data" or
"local only".

| Host | When | Direction |
| ---- | ---- | --------- |
| `api.scryfall.com` | MTG search/match/refresh | read |
| `api.pokemontcg.io` | Pokémon search/match (optional key) | read |
| `api.tcgdex.net` | Pokémon fallback + all non-English collector lookups | read |
| `db.ygoprodeck.com` | Yu-Gi-Oh | read |
| `api.lorcast.com` | Lorcana | read |
| `tcgcsv.com` | Catalog games + sealed products for every game | read |
| `api.psacard.com` | Slab scan with a cert; our compiled-in token, dormant if the build has none | read |
| card image CDNs | `<img>` loads only | read |
| `generativelanguage.googleapis.com` | AI deck builder, only with a user-supplied key | write prompt |
| `accounts.google.com` / `www.googleapis.com` | Only with Drive backup on, and only after the user connects | read/write, to the user's own Drive |
| the user's own binder URL (e.g. a Gist raw link) | Friend refresh | read |
| the user's sync server | Only when `syncOn` and an address is set | read/write |
| the diagnostics endpoint | Only when sharing is on **and** a token is set | write |
| the shared card index (`lookup_card_data` on our own project) | Only for cards with **no image at all**, driven by what is on screen, batched and debounced, misses cached three days. Sends card ids with the publishable key as `anon` — **never the session token**. Off with `cardSourceLookup` | read |
| the shared card index (`submit_card_data` / `flag_card_data`) | Only when the user turns on contributing **and** ticks the box on that card. Attributed, so it needs an account | write |

The scan pipeline never sends an image anywhere. Card identification is
Tesseract + canvas math on-device; the APIs are only asked by name, set and
number.
