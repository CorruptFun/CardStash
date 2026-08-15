# Extending the app

Task-shaped playbooks. Each lists every file the change actually touches — the
per-game tables in particular are spread across nine modules by design (each
lives next to the code that reads it), so a checklist beats a search.

---

## Add a card game

`Game` is a union in `src/lib/types.ts`, so TypeScript will point at most of
these for you — but not the CSS, the aliases or the regexes.

**1. Declare it**

- `src/lib/types.ts` — add the literal to `Game`.
- `src/lib/games.ts` — `GAMES` (order matters: it's the display order and the
  settings order), `GAME_LABEL`, `GAME_SHORT`, `GAME_FULL_NAME`,
  `GAME_FINISHES`. Add to `LIGHT_MATCH_GAMES` **only** if the game has a cheap
  by-name API — a catalog-backed game there would download a whole catalog per
  OCR candidate.

**2. Give it data** — either a new adapter or the TCGCSV catalog:

- *New API*: add `src/lib/<source>.ts` exporting `search…`, `match…`, `…ById`
  and `…Printings`, all returning the normalized `Card` shape, then wire the
  cases in `src/lib/cardsearch.ts` (`searchGame`, `matchGame`, `cardById`,
  `printingVariants`).
- *TCGCSV*: add an entry to `CATALOG_GAMES` in `src/lib/tcgcsv.ts` (a category
  regex + which finish a "Foil" price row means). It then falls into
  `cardsearch.ts`'s `default:` branch automatically.
- Either way, add the game to `GAME_CATEGORY` in `tcgcsv.ts` so sealed-product
  scanning works, and to `AUX_GROUP_CATEGORIES` if it has a second TCGplayer
  category (the way Japanese Pokémon does).

**3. Teach the scanner where things are printed**

- `src/lib/ocr.ts` — `GAME_BANDS` if the name isn't at the top of the card
  (mid-plate and bottom-banner variants already exist).
- `src/lib/corner.ts` — `CORNER_REGION` (required), plus
  `CORNER_RETRY_REGIONS` / `SOLE_EVIDENCE_REGIONS` if you want the harder
  collector-line passes. Add the game to `CODE_GAMES` if its collector number is
  a set-prefixed code (`OP01-016`), otherwise the fraction path handles it.
- `src/lib/identify.ts` — the collector-rescue branch only knows MTG, Pokémon,
  Yu-Gi-Oh and catalog games; a catalog game needs nothing, a new API needs a
  branch.

**4. Deck rules and links**

- `src/lib/deckstats.ts` — `GAME_BOARDS` and `DECK_RULES` (both are exhaustive
  records). Extend `boardForCard` if some cards belong in a separate pile.
- `src/lib/gemini.ts` — `DECKLIST_SPEC`, the sentence describing what goes
  inside the ```decklist fence.
- `src/lib/util.ts` — `EBAY_GAME_WORD`, the search word for sold-listing links.
- `src/lib/importexport.ts` — aliases in `GAME_ALIASES` so CSV imports resolve
  the game.

**5. Make it look right**

- `src/styles.css` — a `--game-xxx` token on `:root` **and** a
  `.gamechip--<game>` rule using it. Without both, the game badge renders with
  no colour.

**6. Test it**

- `tests/harness/fetch-fixtures.mjs` — add fixture picks (paper cards only).
- `tests/harness/stub-apis.mjs` — stub semantics for any new endpoint.
- Push to a `claude/**` branch so CI regenerates `harness-fixtures`, re-pull,
  re-baseline, then run the matrix.

---

## Add a sport, a brand, or a parallel

None of these is a new game — they are vocabulary in `src/lib/sportsparse.ts`:

- **A brand or product line** — add to `BRANDS` / `PRODUCTS`. Products are
  matched longest-first, so compounds ("Bowman Chrome") already beat their
  suffixes. If the line only ever covers one sport, add it to `PRODUCT_SPORT`.
- **A parallel** — add to `PARALLELS`. A bare colour never qualifies; colours
  only count next to a treatment word, via `PARALLEL_COLORS`.
- **A team** — `registerTeams(sport, [...])`. If the nickname is shared across
  leagues (Cardinals, Giants, Rangers, Kings, Panthers, Jets), add it to
  `AMBIGUOUS_TEAMS` with its cities instead, so it stays unresolved until
  something settles it.
- **A whole sport** — add the literal to `Sport` in `types.ts`, a label in
  `SPORT_LABEL` and an entry in `SPORTS` (`sports.ts`), plus league marks in
  `LEAGUE_SPORT` and positions in `POSITION_SPORT`.

Add a case to `tests/unit/sportsparse.test.mjs` for anything you add here — it
is pure, so the test is three lines. Do **not** loosen
`MIN_SPORTS_CONFIDENCE` or let sports into the auto sweep to make a card
scan; see decision 17.

## Add a data source for an existing game

Follow `pokemon.ts` — it already runs a primary with a fallback. The shape that
works:

1. Normalize into `Card` with the same id scheme (`${game}:${apiId}`); if the
   fallback's ids can collide with the primary's, prefix them (`dex-…`) and
   write a parser so `…ById` routes refreshes back to the right service.
2. Use `fetchJson` so timeouts and abort linking come for free; use `isAbort`
   to distinguish a cancelled request from a dead API.
3. Decide the fallback trigger explicitly — error, empty, or "answered but the
   answer doesn't fit the evidence" (that last one is what
   `matchPokemon`'s `< 0.98` cross-check is).
4. If the source can serve images, add its CDN host to `IMAGE_HOSTS` in
   `src/sw.js` so art is cached offline.

---

## Add a screen

1. `src/views/NewView.tsx`.
2. `App.tsx` — add a `Route` variant, a `parseRoute` case, the render line, and
   a `TABS` entry (or add the route name to an existing tab's `match` array so
   the right tab highlights).
3. Read data with `useLiveQuery`, write through `guarded()`.
4. Styles go in `src/styles.css` using existing tokens.

---

## Add or change a stored table

1. `src/lib/types.ts` — the row type.
2. `src/lib/db.ts` — declare the `Table` field, **append** a new
   `this.version(n).stores({...})` block (never edit an existing one), and add
   `.upgrade()` if stored rows need reshaping.
3. Add the table to `exportBackup`, `sanitizeBackup`/`importBackup` and
   `clearAllData` — otherwise it silently escapes backup and erase. Make the
   field **optional on the way in**: every backup written before your version
   lacks it and must still restore.
4. Add it to `mergeBackups` in `cloudmerge.ts` too, or it rides the vault
   one-way and never merges — pick the key and the recency field deliberately
   (`patches` merges on `cardId` by `updatedAt`, so the device that most
   recently corrected a card wins regardless of which vault is newer).
5. If the rows can come from outside the app, write ONE sanitizer and reuse it
   from every entry point — the backup path, the link path, the server path.
   It lives with the module that owns the data (`social.ts` for friends and
   trades, `cardpatch.ts` for card patches); what matters is that there is
   exactly one implementation, not which file it sits in.
6. Expose CRUD as functions in `db.ts`; views should not touch `db.*` for
   writes. If the row is denormalized anywhere else — `Card` is copied into
   collection, deck and scan rows — the write function owns pushing the change
   through, the way `savePatch` and `applyCardUpdate` do.
7. Remember Dexie boolean fields cannot be indexed: IndexedDB has
   no boolean key type, so `stores({ t: 'id, flag' })` silently indexes nothing
   and a query against it looks like "no rows" rather than failing.

---

## Add a setting

1. `src/lib/settings.ts` — the field, its default, and a line in the `merge`
   sanitizer if a bad stored value could break something.
2. `SettingsView.tsx` — the control, in the right section.
3. If it can disable a network path, make sure the path actually checks it
   (`syncOn` and `diagShare` are the models to copy).

---

## Add an analytics event

1. `src/lib/analytics.ts` — add the name to `EVENT_TYPES`.
2. Call `track('name', { … })` with **enum-ish strings, booleans and numbers
   only**. See [privacy.md](privacy.md) for the redaction rules — anything that
   could carry card text, a query or a key will be dropped, and shouldn't have
   been passed in the first place.
3. **Add it to the whitelist in `ingest_events()` too**
   (`supabase/migrations/0007_analytics.sql`) and apply the change. The SQL
   keeps its own copy of the list, and an unlisted name is stored as `'other'` —
   silently, by design, because rejecting it would lose the whole batch from a
   client running an older bundle. So a new event that never reaches the SQL
   still *arrives*; it just arrives unnamed, and you will not be told.
4. If the event carries a money amount, pass `amountBucket()` — never the
   figure. `amount`, `price`, `total` and friends are in `FORBIDDEN_KEYS` and
   are dropped, so an exact value does not silently sneak through under a
   different name.

---

## Change scan behaviour

1. Read [`.claude/skills/scan-harness/SKILL.md`](../.claude/skills/scan-harness/SKILL.md)
   and `references/pipeline-map.md`.
2. Run the full matrix and save the report as your baseline.
3. Change **one layer**, diagnosing from the traces rather than from intuition.
4. Every loosening needs a matching evidence gate. The overhaul's one big
   regression was adding retrieval tolerance without guards: honest misses
   became 16 confident wrong cards in a single run.
5. Re-run the full matrix with `--baseline=<pre-change report>`; ship only if no
   game drops. Then `npm run test:unit`, `npm run build`,
   `node tests/harness/smoke-app.mjs`, and `test:capture` if you touched the
   camera.
6. Reproduce any verdict twice — marginal cells flap ±1–2 between identical
   runs.

---

## Cut a release

1. Bump `version` in `package.json` **and** `APP_VERSION` in
   `src/lib/version.ts` (they feed Settings → About, the update toast and
   telemetry).
2. `npm run build` and `node tests/harness/smoke-app.mjs`.
3. Merge to `main`. CI builds and force-pushes `gh-pages` — **merging to `main`
   is deploying.** Never hand-edit `gh-pages`, never commit `dist/`.
4. Users get an "Update ready · Restart" toast on their next visibility check;
   after the reload they see "Updated to vX".

---

## Things that will bite you

- **Editing `src/lib/**` while a matrix run is live** wipes `window.__harness`
  via Vite's full reload. Views and styles are safe.
- **Pulling fixtures with a `--work-tree` checkout** stages 60 fixture files
  into the source repo's index. Use `git archive | tar -x`.
- **Adding an entry to a `Record<Game, …>` table but not its CSS token** ships a
  colourless badge; the type checker won't catch the stylesheet.
- **Reading `prices.best` directly** instead of going through `prices.ts` can
  surface a legacy EUR value as dollars.
- **Comparing wants by card id** breaks matchmaking — wants are card-level and
  keyed by `${game}|${normalizeName(name)}`.
- **Forgetting `guarded()`** on a write turns a full-storage phone into an
  unhandled rejection instead of a toast.
