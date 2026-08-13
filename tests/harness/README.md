# Scan-pipeline regression harness

Real card images + the real on-device pipeline, end to end: `identifyFrame()`
(Tesseract OCR → name candidates → match layer → collector-line refine) runs in
headless Chromium against photographs of actual cards under camera-realistic
degradations. Only the card APIs are stubbed — with each service's query
semantics reimplemented over captured real responses — so a run is
deterministic and needs no network.

## Quick start

```sh
# 1) Fixtures (one-time). Anywhere with open internet:
node tests/harness/fetch-fixtures.mjs
#    …or in a restricted sandbox, pull the machine-generated branch that the
#    "Scan harness fixtures" workflow force-pushes:
git fetch origin harness-fixtures
git --work-tree=tests/harness/fixtures checkout origin/harness-fixtures -- .

# 2) The matrix:
npm run test:scan                       # everything
node tests/harness/run-matrix.mjs \
  --games=pokemon,riftbound --degradations=clean,glare --mode=hinted \
  --keys=tauros-fa-secret --pages=3 --verbose
```

Chromium is resolved from `$CHROMIUM_PATH`, `/opt/pw-browsers/chromium`, or
playwright's own registry, in that order.

## What a cell is

`fixture × degradation × hint-mode`. A cell passes only if the pipeline lands
on the RIGHT card (normalized-name match against ground truth) — a confident
wrong answer is a failure (`wrong-card`). Failed cells are attributed to a
stage from the pipeline's own diagnostics trace (`src/lib/scandebug.ts`):

| stage         | meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `ocr-noread`  | no plausible text came out of any band or the full-card sweep  |
| `ocr-misread` | text came out, but nothing resembling the card's name          |
| `match-none`  | the name (or close) WAS read; the match layer returned nothing |
| `match-low`   | the name was read and matched, but under the score threshold   |
| `wrong-card`  | a confident hit on the wrong card                              |
| `api-error`   | the pipeline reported an API/engine failure                    |

Degradations (`augment.mjs`, all deterministic): `clean`, `small-offset`,
`soft-focus`, `rot+5`, `rot-5`, `perspective`, `glare`, `lowlight`, `worst`.

## Guarding against regressions

```sh
node tests/harness/run-matrix.mjs --baseline=tests/harness/report/baseline.json
```

exits non-zero if any game's pass rate drops below the baseline report's.
Reports land in `tests/harness/report/` (gitignored).

## Files

- `fetch-fixtures.mjs` — CI-side: downloads real card images (TCGdex,
  TCGplayer product scans, Scryfall, YGOPRODeck) + API datasets.
- `.github/workflows/scan-harness.yml` — runs the fetcher, force-pushes the
  result to the `harness-fixtures` data branch (never merge it).
- `stub-apis.mjs` — the local card-API implementations over those datasets.
- `augment.mjs` — the degradation battery (browser canvas, seeded).
- `page.html` — loads the real `/src` pipeline modules under the Vite dev
  server; exposes `window.__harness.runCell`.
- `run-matrix.mjs` — orchestrates dev server + Chromium, grades cells, writes
  the report, prints the game × degradation grid.

Known stub bias (stable across runs, so before/after comparisons hold): an OCR
misread that a real API might fuzzy-resolve to some *other* card returns "no
match" here — both grade as failures, only the stage label differs.
