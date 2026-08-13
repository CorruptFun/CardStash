# Harness architecture

Six pieces, in data-flow order. All committed except the two gitignored dirs
(`tests/harness/fixtures/`, `tests/harness/report/`).

## 1. Fetcher — `tests/harness/fetch-fixtures.mjs` (runs where internet is open)

Downloads real card imagery + the API responses the pipeline's match layer
needs, into `tests/harness/fixtures/`:

- **Pokémon**: TCGdex (`api.tcgdex.net`) card search + hydration + set lists;
  images `<base>/high.webp`. Hydrates the TAIL of each name's briefs
  (`slice(-120)`) because `dexMatch` pools the newest briefs — a head-biased
  capture 404s exactly the hydrations the matcher needs. Paper-only picks
  (Pocket sets `/^[ab]\d/i` excluded — no printed collector line). Also
  captures pokemontcg.io rows per fixture name, recording FAILED query names
  so the stub can replay the same server errors (the API is dying; that
  flakiness is part of what's being tested).
- **Riftbound / One Piece**: tcgcsv.com verbatim (categories, groups,
  products, prices) — groups.json is trimmed to the groups actually
  captured so the catalog builder sees a COMPLETE catalog. Images are
  TCGplayer product scans (`_in_1000x1000.jpg`), which carry white padding —
  the page-side compositor trims to the card via corner-color bbox.
- **MTG**: Scryfall prints per fixture name (trimmed fields incl.
  `flavor_name`) + the full `catalog/card-names` list (fuzzy universe).
- **YGO**: exact-name rows for fixtures PLUS realistic `fname=` pools
  (dragon/magician/blossom, ~130 rows) so substring retrieval isn't tested
  against a flattering 3-card universe.
- Publishing gate: refuses to ship `< 15` fixtures or any whole-game failure
  (a partial fetch must not clobber a good snapshot via CI's force-push).

## 2. Data branch — `harness-fixtures`

Orphan branch, force-pushed by `.github/workflows/scan-harness.yml` on
`claude/**` pushes touching the fetcher/workflow (or dispatch). Treat like
gh-pages: machine-generated, never merged, never edited. Pull with
`git archive origin/harness-fixtures | tar -x -C tests/harness/fixtures`.
Security note (accepted for a personal repo): push-triggered runs execute the
pushed branch's own fetcher with a `contents: write` token.

## 3. Stubs — `tests/harness/stub-apis.mjs` (node side)

Per-service query semantics reimplemented over the captured data, served via
playwright route interception; everything not stubbed is aborted, so runs are
offline-deterministic. Highlights:

- tcgcsv: captured files verbatim → the real `tcgcsv.ts` catalog logic runs
  unmodified end to end.
- tcgdex: `cards?name=` is a lax contains-filter (like the real API);
  hydration 404s honestly for uncaptured ids.
- pokemontcg.io: Lucene-ish `name:"…"` phrase / `name:tok*` prefix-AND /
  `number:"…"` / `set.printedTotal:` over captured rows; failed-capture query
  names replay HTTP 500; whole-API-dead capture replays 503.
- scryfall: exact + fuzzy `named` over `card-names` ∪ captured
  `flavor_name`s (fuzzy = best unambiguous near-match, similarity ≥ 0.77
  with a margin), bang-exact prints search, collector lookup, collection.
- ygoprodeck: `name=` is LIVE-EXACT (case-insensitive, punctuation
  significant — a laxer stub was flattering junk-suffixed reads); `fname=`
  substring; empty ⇒ HTTP 400 like the real API.
- lorcast: always 404 = "no cards" (its real empty-result signal).

**Documented biases** (stable across runs, so before/after deltas hold):
misreads a real API might fuzzy-resolve to some OTHER card return no-match
here (both grade as failures; only the stage label differs); auto-mode
cross-game competition is thinner than live (Lorcana never competes; small
universes); scryfall fuzzy over the full 35k-name catalog is the one
near-live-fidelity fuzzy.

## 4. Harness page — `tests/harness/page.html`

Served by the Vite dev server so `/src` TypeScript loads through the app's
real toolchain. Needs `<base href="/">` because `ocr.ts` resolves its worker
via `document.baseURI` and the OCR assets are served at `/ocr` by the vite
middleware. Exposes `window.__harness.runCell({imageUrl, degradation,
hint})`: composes the card image under the degradation (augment.mjs), calls
the REAL `identifyFrame` with `ignoreMisses: true`, clears the scan cache and
trace ring between cells, returns `{outcome, ms, trace}`.

**Trap:** while a matrix run is live, editing any module in the harness
page's import graph (`src/lib/**`, `src/store/ui.ts` is NOT in it, views are
NOT) triggers a Vite full-reload that wipes `window.__harness` mid-run. Edit
views/styles freely; do not touch `src/lib/**` until the run finishes.

## 5. Degradations — `tests/harness/augment.mjs` (page side, seeded)

Frame canvas 756×1056 (63:88, matches the reticle capture's scale). Battery:
`clean`, `small-offset` (fill 0.58 + offset — exercises region detection),
`soft-focus` (0.5 downscale + blur), `rot±5`, `perspective` (strip-warp
tilt), `glare` (specular streaks — streak 1 crosses the upper half where
top-name games print, streak 2 crosses mid-plate), `lowlight`
(brightness 0.42 + seeded noise), `worst` (compound). All deterministic
(mulberry32 seeded from the spec) for cell-by-cell comparability.

Opt-in harsh low light (NOT in the standard battery, so per-game regression
gates stay comparable across reports): `dim` (brightness 0.26, noise 10) and
`dark` (brightness 0.15, noise 15 + slow-shutter softness). Select with
`--degradations=lowlight,dim,dark`; add `--stack=3` to simulate the phone's
dark-scene temporal averaging (N seed-varied composes averaged in-page —
noise decorrelates exactly like real sensor frames; don't stack glare cells,
their streak geometry is seed-positioned).

## 6. Runner — `tests/harness/run-matrix.mjs` (node)

Spawns vite (port 5197) + headless chromium (`--no-sandbox`), N pages
round-robin the cells. Cell = fixture × degradation × hint mode (hinted for
all; auto only for mtg/pokemon/yugioh/lorcana on clean/soft-focus/glare).
Grading: `outcome.ok` AND right GAME AND name similarity ≥ 0.9 — a confident
wrong card or wrong game FAILS. Known grading limit: any same-name printing
passes (edition ground truth is recorded but not gated). Failure-stage
attribution from the trace (see SKILL.md). `--baseline` compares per-game
pass rates and exits 1 on any drop; `--min-rate` sets an absolute floor.
Budget note: the app's lookup budget is wall-clock, so heavy CI contention
can flip marginal cells; run with 3 pages on 4 cores.

## App-side diagnostics (same trace the harness reads)

`src/lib/scandebug.ts` — ring of 24 per-attempt traces, populated by
identify.ts/ocr.ts. UI: eye icon on the no-match chip →
`src/components/ScanDebug.tsx` ("What the scanner saw", copyable). Strictly
local; trace content (card text) must NEVER feed `analytics.ts` — analytics
events are content-free by contract.
