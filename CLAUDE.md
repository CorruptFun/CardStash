# Cardstock — notes for agents

Vite + React 19 + TypeScript PWA. Local-first: all user data in IndexedDB via
Dexie (`src/lib/db.ts`); settings in localStorage via zustand persist
(`src/lib/settings.ts`). The deployed app has no backend — the only server in
the repo is `server/`, an optional self-hosted sync box the user opts into
(see Conventions); the app must always work fully without it.

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
- `npm run sync` — optional self-hosted live-sync server (`server/`, zero deps,
  state in the gitignored `server/data/`). The app never requires it.
- `npm run test:unit` — node tests (corner parsing, name candidates, harness
  stubs). `npm run test:scan` — the real-image scan regression matrix
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
  Riftbound/One Piece/Star Wars/Digimon/Gundam — unified in `cardsearch.ts`),
  the AI deck builder (`gemini.ts` — the app's ONLY Gemini use; scanning must
  stay fully on-device), on-device OCR + collector-line reading (`ocr.ts`,
  `corner.ts`), scan pipeline (`identify.ts`, `vision.ts` — includes the foil
  sheen detector, `camera.ts`), sealed-product scanning (`sealed.ts`, backed
  by the TCGplayer group layer in `tcgcsv.ts`; sealed collection rows carry
  an `opened` flag and stop counting at the sealed price once opened),
  multi-card / binder scanning (`multiscan.ts` — detect regions, crop, identify
  each on a reduced per-card budget; the UI reviews before anything is added),
  portfolio math (`portfolio.ts`), deck math (`deckstats.ts`), CSV
  import/export (`importexport.ts`), local diagnostics (`analytics.ts`),
  serverless social (`social.ts` — profile/trade payload build+codec+sanitize;
  the Dexie writes for friends/trades live in `db.ts`), optional live sync
  (`sync.ts` — publish/poll against `server/sync-server.mjs`).
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
- `src/store/ui.ts` — UI store: bottom sheet, toasts, search prefill, and
  `builderSeeds` (cards handed to the AI builder to design around).
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
- Prices: USD only (US/English market). `best` = non-foil headline, `bestFoil`
  = premium finish; per-item pricing multiplies by condition factor. Data
  stored by pre-0.5 versions may still carry EUR (Cardmarket) entries — the
  pickers in `prices.ts` and history readers filter them out; don't reintroduce
  them into math or UI.
- Social is serverless **by default**: everything works with no server, and
  that path must keep working — never make links/files a second-class citizen
  or route them through a server. Live sync (`sync.ts` + `server/`) is an
  opt-in overlay the user turns on with a server address; when `syncOn` is
  false nothing in `sync.ts` runs. Anything the server returns is untrusted
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
