# Build, PWA and deployment

## Commands

| Command | What it does |
| ------- | ------------ |
| `npm run dev` | Vite dev server. `?demo=1` seeds demo data on first run, `?nosw=1` skips service-worker registration. |
| `npm run build` | `tsc -b` then `vite build` → `dist/`. Emits `sw.js` with a stamped precache manifest and copies the OCR engine into `dist/ocr/`. |
| `npm run preview` | Serve the production build locally. |
| `npm run sync` | The optional self-hosted sync server. |
| `npm run test:unit` | Node unit tests. |
| `npm run test:scan` | The real-image scan regression matrix. |
| `npm run test:lowlight` | The harsh low-light slice of the matrix. |
| `npm run test:capture` | The real stacked-capture check in a browser. |
| `npm run deploy` | **Manual fallback only** — builds and force-pushes `dist/` to `gh-pages`. Don't use it when Actions works. |

## Vite configuration (`vite.config.ts`)

Three things beyond the React plugin:

- **`base: './'`** — every asset URL is relative, so the build works from a
  project subpath (`/CardStash/`) without knowing it. This is why the service
  worker's navigation fallback redirects deep paths to the scope root: relative
  URLs served at `/deep/path` would resolve to `/deep/assets/…` and 404.
- **`assetsInlineLimit: 0`** — nothing is inlined as a data URI, so every asset
  is a real file the precache manifest can name.
- **Two custom plugins** (below).

### `ocrAssets()` — the self-hosted OCR engine

Copies four files out of `node_modules` into `ocr/`:

| Route | Source |
| ----- | ------ |
| `ocr/worker.min.js` | `tesseract.js/dist/worker.min.js` |
| `ocr/core/tesseract-core-lstm.wasm.js` | `tesseract.js-core` |
| `ocr/core/tesseract-core-simd-lstm.wasm.js` | `tesseract.js-core` |
| `ocr/eng.traineddata.gz` | `@tesseract.js-data/eng/4.0.0_best_int` |

Those are the only cores OEM 1 ever requests (the wasm is embedded in the
`.wasm.js`), and the traineddata is the exact variant tesseract.js v6 would
otherwise pull from a CDN — same accuracy, our origin. Dev-server middleware
serves them at `/ocr`; `generateBundle` emits them into `dist/`. They are
**deliberately excluded from the precache** so only devices that actually scan
download them.

### `serviceWorker()` — stamping `sw.js`

Reads `src/sw.js` (plain JS, deliberately outside the module graph so its
lifecycle is governed only by the registration and never by Vite hashing) and
substitutes:

- `__BUILD_ID__` → a fresh per-build id, which names the shell cache;
- `__PRECACHE_MANIFEST__` → every emitted asset except `sw.js` and `ocr/*`,
  plus `index.html`, `manifest.webmanifest`, `favicon.svg` and the four icons.

## The service worker (`src/sw.js`)

Three caches, three strategies:

| Cache | Name | Strategy | Contents |
| ----- | ---- | -------- | -------- |
| shell | `cardstock-shell-<buildId>` | cache-first | The precached app shell. New name per build. |
| img | `cardstock-img-v2` | stale-while-revalidate, FIFO-capped at 480 | Card art from the six known CDNs. |
| ext | `cardstock-ext-v3` | cache-first | The self-hosted OCR engine under `ocr/` (and the legacy CDN hosts). |

Price and search API calls are **never** cached — prices must be live.

### Install is gated, not best-effort

Assets are added **per asset**, not with `addAll`, because `addAll` is atomic
and one 404 would leave the app with no offline shell at all. But tolerating
*some* loss is not tolerating *any*: `missingCritical()` re-reads the cached
`index.html` and checks that every `.js`/`.css` it references actually made it
in. If a critical asset is missing, the install **throws**, which keeps the
previous worker — and its complete shell — serving. Icons and the manifest are
allowed to fail; a missing chunk is a blank screen.

There is deliberately **no `skipWaiting()` in install**: an update that activates
mid-session strands the running bundle on caches that no longer hold its hashed
assets. The new worker waits; the page shows an "Update ready · Restart" toast
and posts `SKIP_WAITING` when the user taps it (or the next cold launch
activates it). `activate` then sweeps every `cardstock-*` cache that isn't one of
the three current names — which is also the recovery mechanism for a poisoned
image/ext cache: bump the version suffix and ship.

### Fetch routing

1. **Navigations** — network first, falling back to the cached `./index.html`.
   A same-origin navigation to a directory other than the scope root is
   redirected home first (see `base: './'` above); routing is by hash, so
   nothing is lost.
2. **Same-origin `/ocr/`** → `cacheFirstExt`.
3. **Other same-origin** → shell cache, then network.
4. **Known image hosts** → stale-while-revalidate.
5. **Known ext hosts** → `cacheFirstExt`.
6. **Everything else** (price APIs, Gemini, sync server, telemetry) → straight
   to the network, uncached.

### Two subtleties that took real debugging

- **`ignoreVary: true` everywhere.** Precache entries are stored from
  SW-constructed `Request`s, which carry no headers, while the document's own
  asset requests carry `Origin`. A host that answers `Vary: Origin` (vite
  preview does) makes every lookup miss — invisible while the network is up, a
  blank app the moment it isn't. Every cache here is single-variant by
  construction, so honouring `Vary` buys nothing.
- **Opaque responses are unreadable.** Tesseract fetches its wasm and
  traineddata `no-cors`, and an opaque response has status 0, filtered headers
  and a zero-length body — a CDN 403 and a 12 MB payload are literally the same
  object. `cacheFirstExt` therefore re-requests with `mode: 'cors'` (all ext
  hosts send `Access-Control-Allow-Origin: *`), so it can cache honestly on
  `res.ok`, and only falls back to taking an opaque payload on trust if that
  fails. The image cache accepts opaque responses because poisoning there is
  self-healing — stale-while-revalidate overwrites on the next request.

## Update flow, end to end

1. CI publishes a new build; the browser re-checks `sw.js` on tab-visible and
   hourly (`pollForUpdates`), with `updateViaCache: 'none'` so the worker script
   itself is never served stale.
2. The new worker installs, precaches, and **waits**.
3. `wireUpdateFlow` shows the "Update ready · Restart" toast for 60s.
4. Tapping posts `SKIP_WAITING` → the worker activates → `controllerchange` →
   one `location.reload()`.
5. After the reload, `announceVersion` notices `APP_VERSION` changed and toasts
   "Updated to vX".

## PWA metadata

`public/manifest.webmanifest` plus `favicon.svg` and four PNG icons (192, 512,
maskable 512, apple-touch). `index.html` carries the iOS meta tags
(`apple-mobile-web-app-capable`, black-translucent status bar, app title) and
`theme-color: #0a0908`.

## Installing, and why it is a data-durability feature

Installing is not a nicety here — for a meaningful share of users it is the
difference between keeping a collection and losing it.

Every scanned card lives in IndexedDB on the device (`src/lib/db.ts`). For a
site the user has **not** installed, WebKit's storage policy deletes
script-writable storage after roughly seven days without a visit. A user who
scans a shoebox in one sitting and doesn't reopen the app for two weeks can
find it empty, having done nothing wrong. Adding the app to the Home Screen
exempts it from that sweep. Chromium never evicts this aggressively, but an
installed app there is still the durable choice, and it earns its own window.

`InstallPrompt.tsx` is the nudge. What it has to reconcile:

- **iOS never fires `beforeinstallprompt`.** There is no API to trigger the
  install; instructions naming Share → Add to Home Screen are the only route,
  so the iOS branch shows those and no button.
- **Chromium fires the event once per page load, and only if you call
  `preventDefault()`.** The component stashes it and replays it inside the tap,
  because `prompt()` requires the user gesture.
- **No event and not iOS means the browser cannot install this at all**
  (desktop Safari, Firefox). A button that can't work is worse than no banner,
  so nothing renders.
- **It waits for `MIN_CARDS_TO_PROMPT` (5) rows.** A banner on card #1 gets
  dismissed reflexively, and dismissal is permanent — the one chance is worth
  spending on someone who has something to lose.
- **Installing is only half the answer, so the banner says so.** It points at
  Settings → Export, because a device that is lost or wiped takes its
  IndexedDB with it no matter how the app was installed. Nothing in the app
  today puts a user's collection anywhere but that one device.

Suppressed whenever `IS_STANDALONE` is true, after `appinstalled`, once
dismissed (`installHintDismissed` in settings), and on the scan and ingest
routes so it can never cover the viewfinder. `npm run test:install` drives all
of that against the built bundle.

## Deploying

**Pushing or merging to `main` *is* deploying.**
`.github/workflows/deploy.yml` runs `npm ci && npm run build`, then force-pushes
`dist/` (plus `.nojekyll` and a generated README) to `gh-pages`, with
`concurrency: cancel-in-progress`.

`npm run deploy` (`scripts/deploy.sh`) does the same thing from a local
worktree, and exists only for when Actions is unavailable.

### Branch contract

| Branch | Contains | Rules |
| ------ | -------- | ----- |
| `main` | Source only | Never commit build output. `dist/` is gitignored. |
| `gh-pages` | Build output only | **Machine-generated.** Regenerated and force-overwritten by CI on every push to `main`. Never edit, never hand-push. |
| `harness-fixtures` | Real card images + captured API datasets | **Machine-generated** by `.github/workflows/scan-harness.yml`. Never merge, never hand-edit. Consume with `git archive`, not a `--work-tree` checkout. |
| `claude/**` | Feature work | Pushes touching the fixture fetcher trigger the harness workflow. |

### Versioning

`src/lib/version.ts` (`APP_VERSION`) is the single source of truth — it feeds
Settings → About, the update toast and telemetry payloads. Keep it in step with
`package.json`'s `version` when cutting a release.
