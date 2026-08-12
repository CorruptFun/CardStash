# Cardstock — notes for agents

Vite + React 19 + TypeScript PWA. Local-first: all user data in IndexedDB via
Dexie (`src/lib/db.ts`); settings in localStorage via zustand persist
(`src/lib/settings.ts`). No backend.

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
  precache manifest via the plugin in `vite.config.ts`)
- Deploys are automatic: pushing/merging to `main` triggers the GitHub Actions
  workflow that builds and publishes `gh-pages`. `npm run deploy` is a manual
  fallback only — don't use it when Actions works.

## Layout

- `src/lib/` — data + integrations: Dexie schema/CRUD (`db.ts`), price picking
  (`prices.ts`), the three card APIs (`scryfall.ts`, `pokemon.ts`, `ygo.ts`,
  unified in `cardsearch.ts`), Gemini vision + AI deck builder (`gemini.ts`),
  OCR fallback (`ocr.ts`), scan pipeline (`identify.ts`, `vision.ts`,
  `camera.ts`), portfolio math (`portfolio.ts`), deck math (`deckstats.ts`),
  CSV import/export (`importexport.ts`), local diagnostics (`analytics.ts`).
- `src/views/` — one file per screen; `CardSheet.tsx` is the card bottom-sheet.
- `src/store/ui.ts` — UI store: bottom sheet, toasts, search prefill, and
  `builderSeeds` (cards handed to the AI builder to design around).
- `src/styles.css` — the whole stylesheet (BEM-ish, design tokens on `:root`).
  `src/fonts.css` pins the exact font subsets shipped.
- `src/sw.js` — hand-written service worker; `__BUILD_ID__` and
  `__PRECACHE_MANIFEST__` are stamped at build time. Read its comments before
  touching caching.

## Conventions

- Card ids are `${game}:${apiId}`. Games: `mtg | pokemon | yugioh`.
- DB writes from UI go through `guarded()` (`src/store/ui.ts`) so quota errors
  surface as toasts.
- Analytics events must stay content-free (no card names/queries/keys) — the
  redaction lives in `analytics.ts`; event names are a fixed whitelist.
- Prices: `best` = non-foil headline, `bestFoil` = premium finish; per-item
  pricing multiplies by condition factor. EUR entries come from Cardmarket.
