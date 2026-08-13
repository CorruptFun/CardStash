---
name: scan-harness
description: >
  Run, extend, and debug Cardstock's real-image scan regression harness, and
  follow the proven methodology for fixing card-scanning accuracy. Use this
  skill whenever a task touches the scan pipeline (src/lib/identify.ts,
  ocr.ts, vision.ts, corner.ts, pokemon.ts, ygo.ts, tcgcsv.ts matching,
  hooks/useScanner.ts) or scanning behavior in any form — "scanning fails",
  "card misidentified", "wrong card", "OCR problems", "identify rate",
  "test the scanner", "run the matrix", "refresh fixtures", "add a game /
  card to the tests", tuning thresholds, or evaluating any scanning change
  before merge. Never change scan-pipeline code without running this
  harness before and after — that rule is the reason scanning works.
---

# Cardstock scan-harness

Real card photographs + the REAL `identifyFrame()` pipeline in headless
Chromium, graded against ground truth, with per-stage failure attribution.
Built and battle-tested in the v0.7.0 overhaul that took the matrix from 36%
to 67% (Pokémon 3%→32%, Riftbound 48%→74%, One Piece 39%→100%, MTG 73%→88%,
YGO 31%→81%), then extended in v0.7.1 for harsh low light (dark scenes
6/21 → 17/21) and again for FOIL, which took the standard battery 71% → 77%
(Riftbound 83%→94%, YGO 81%→94%, MTG 90%→96%) — see lesson 23, the single
highest-yield change since the overhaul. Everything below exists because
synthetic tests passed while real cards failed on-device — only real imagery
finds these bugs.

Two paths the matrix CANNOT reach, so they have their own checks: the
camera itself (`npm run test:capture` drives the real stacked capture
against a live video element) and the built bundle
(`node tests/harness/smoke-app.mjs`). Anything you change in `camera.ts` or
the scan screen needs those, not just the matrix.

## Quick commands

```sh
# One-time per sandbox: fixtures (real card images + captured API datasets).
# Restricted sandboxes can't reach card CDNs — pull the CI-generated branch.
# git archive, NEVER a --work-tree checkout (that stages 60 fixture files
# into the SOURCE repo's index):
git fetch origin harness-fixtures
mkdir -p tests/harness/fixtures
git archive origin/harness-fixtures | tar -x -C tests/harness/fixtures

npm run test:unit          # node tests: corner parsing, candidates, stubs
npm run test:scan          # full matrix (~5 min, 228 cells, 3 pages)
npm run test:lowlight      # harsh low light (lowlight/dim/dark) + 3-frame stack
npm run test:foil          # holographic foil sheen (foil/foil-worst)
npm run test:capture       # real captureFrameStacked in a browser (noise ↓)
node tests/harness/run-matrix.mjs \
  --games=pokemon,riftbound --degradations=clean,glare --mode=hinted \
  --keys=tauros-fa-secret --pages=3 --verbose          # fast slice (~1 min)
node tests/harness/run-matrix.mjs \
  --baseline=tests/harness/report/baseline.json        # exit 1 on any
                                                       # per-game regression
npm run build && node tests/harness/smoke-app.mjs      # built-bundle smoke
```

Chromium resolves from `$CHROMIUM_PATH` → `/opt/pw-browsers/chromium` →
playwright registry. Reports land in `tests/harness/report/` (gitignored);
keep `baseline.json` from before your change to gate against.

## The methodology (this is the valuable part)

1. **Measure before touching code.** Run the full matrix, save the report as
   your baseline. If fixtures were refreshed since the stored baseline,
   re-run the baseline on the current snapshot first — absolute numbers are
   only comparable within one fixture snapshot (the dying pokemontcg.io
   answers differently every capture round).
2. **Diagnose from traces, not vibes.** Every cell carries the pipeline's own
   diagnostics trace (`src/lib/scandebug.ts`): raw band text, candidates,
   lookup scores, collector-line parses, crop/deskew decisions. Slice
   `report/*.json` with `node -e` — never guess which stage lost a cell when
   the trace says exactly. On a phone, the same trace is behind the eye icon
   on the no-match chip.
3. **Attribute, then fix ONE layer at a time.** Stage labels: `ocr-noread`
   (no text at all), `ocr-misread` (text, but nothing name-like),
   `match-none` / `match-low` (the name WAS read — the match layer lost it),
   `wrong-card` (confident wrong answer — the worst class), `api-error`.
   Beware: the classifier under-blames the match layer when the name sits
   inside a fused junk row — read raw band text before trusting the label.
4. **Guard every tolerance with evidence.** The overhaul's one big regression
   was adding retrieval tolerance without guards: honest misses became
   confident wrong cards (16 in one run). Every loosening needs a matching
   evidence requirement — see the guard invariants in
   `references/pipeline-map.md` before touching any threshold.
5. **Adversarially verify.** Re-run the FULL matrix with
   `--baseline=<pre-change report>`; a fix ships only if no game drops. Then
   `npm run test:unit`, `npm run build`, `smoke-app.mjs`. For large diffs,
   fan out reviewer subagents per lens (pipeline correctness, phone
   perf/battery, UI, harness integrity) and have separate agents try to
   REFUTE each finding against the working tree before acting on it.
   **Reproduce every verdict twice.** Marginal cells flap ±1–2 between
   identical runs, so a single run cannot tell a real regression from noise
   — but don't hide behind that either: track the specific cell across runs
   (`node -e` over the reports) and if it flipped the same way every time
   after your change, it IS your change. That check is what separated a
   genuine auto-mode tradeoff from noise in the low-light round.
6. **Suspect the harness too.** Several "pipeline bugs" were fixture/stub
   artifacts (see `references/lessons.md`). When a failure makes no sense,
   verify the stub answered what the real API would, and LOOK at the actual
   pixels (render the crop to a PNG and view it) before writing code.

## The foil suite (`npm run test:foil`)

Foil is not a corner case: most cards anyone collects have shine on them,
and it is the pipeline's worst input. It gets its own opt-in battery because
**the fixtures structurally cannot show it** — TCGplayer and TCGdex both
ship flat SCANS, which kill the diffraction a phone sees live. So this
battery is a MODEL, and its worth depends entirely on the model staying
honest (lesson 25).

Two cells per fixture, opt-in like dim/dark so the standard battery's
per-game gates stay comparable:

| cell | spec | what it is |
| --- | --- | --- |
| `foil` | `foil: 0.62` | a well-lit foil held to the light |
| `foil-worst` | `foil: 0.78`, downscale 0.7, blur 0.9, glare 0.4 | the ordinary hand-held phone photo of one |

Standing numbers on the current fixture snapshot (main @ 42687f9):
**33/46 overall — `foil` 21/23, `foil-worst` 12/23.** The gap between those
two columns IS the problem; a lit foil mostly reads, a real-world one mostly
doesn't. Worst cell: Pokémon `foil-worst` at 1/7.

What the model DOES cover: a saturated, hue-varying pearlescent band riding
the card in card coordinates, 55% white (`SHEEN_WHITE`), narrow envelope
(0.17 of the diagonal), calibrated by eye against a real phone photo.

**What it does NOT cover, and this is the live gap: FOIL TEXT.** The sheen
is applied to the whole card, so it models a foil BACKGROUND under neutral
ink — which is exactly the assumption the `chroma-min`/`chroma-max` fix
rests on. Real cards invert it: Yu-Gi-Oh Ultra Rares print the card NAME in
metallic gold, Secret Rares in silver/rainbow holo, on a comparatively
neutral beige name bar. Worked numerically, gold-on-beige actually favours
`chroma-min` (contrast 150 vs luma's 46), so that case may already be
handled — but no fixture is an Ultra Rare, so it is untested. The case
expected to genuinely fail is SILVER/mirror foil: near-neutral (R≈G≈B), so
every intensity projection collapses, and its real signal is specular
variance rather than hue. Modelling it needs a `foil-text` degradation that
metallizes the name band's GLYPHS, not the card.

**Real photos are the way past the model.** They already contain the camera
degradation, so they must bypass `compose()` — a photo cell feeds the image
straight to `identifyFrame` with ground truth from a manifest. They also
cannot live on `harness-fixtures` (CI force-pushes it); commit them under
`tests/harness/photos/` with their own manifest, or mirror the branch
pattern with a hand-curated one. The repo owner has offered to supply
photos of foil cards — ask early, because a couple of real Ultra Rares
anchor this whole area better than any amount of synthetic tuning.

## Fixture lifecycle

- `tests/harness/fetch-fixtures.mjs` needs open internet (TCGdex, TCGplayer
  via tcgcsv, Scryfall, YGOPRODeck). Sandboxes here can typically reach ONLY
  GitHub — so `.github/workflows/scan-harness.yml` runs the fetcher in CI
  (unrestricted egress) and force-pushes results to the **harness-fixtures**
  branch (machine-generated, like gh-pages: never merge, never hand-edit).
- CI triggers on pushes to `claude/**` touching the fetcher or the workflow,
  or via workflow_dispatch. It refuses to publish partial fetches (fixture
  floor + whole-game failure gate).
- Fixture picks must be PAPER cards. TCGdex also indexes Pokémon TCG Pocket
  (set ids `A1`/`B1`…) whose digital frames print no collector line — the
  fetcher filters them; keep that filter when adding picks.
- Adding a game/card: extend the pick logic in `fetch-fixtures.mjs` AND the
  stub semantics in `stub-apis.mjs` for any new API endpoint, push to a
  `claude/**` branch, let CI regenerate, re-pull, then re-baseline.

## When you need more depth

- `references/architecture.md` — how fetcher → data branch → stubs → harness
  page → runner fit together; stub semantics and their DOCUMENTED biases;
  degradation battery; grading rules; the dev-server/HMR trap.
- `references/pipeline-map.md` — the identify pipeline pass-by-pass with
  every threshold and guard invariant, and which file owns each fix. Read
  BEFORE changing any constant in identify.ts/ocr.ts/useScanner.ts.
- `references/lessons.md` — the war stories as transferable rules: fixture
  artifacts that masqueraded as pipeline bugs, the tolerance→wrong-card
  seesaw, why corner-first demands a printed slash, why pre-amplifying dark
  frames backfires, and more. Read when a result seems absurd — the
  explanation is probably in there.

## Cost asymmetry worth remembering

Auto mode fans out across four games in one shared budget, so a per-game
recovery retry there taxes every other game's wait — the same retry is
cheap when the user has committed to one game via the scan filter. That's
what `ApiKeys.thorough` expresses (set only when `games.length === 1`).
When adding any retry to a matcher, ask which mode pays for it: the
low-light round both lost and regained a cell learning this.
