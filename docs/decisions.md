# Decisions

The load-bearing choices, why they were made, and what they cost. If you are
about to undo one of these, this is the argument you need to beat.

---

### 1. No backend, ever, in the deployed product

**Why.** No accounts to build, no data to hold, no hosting bill, no privacy
surface. A static bundle on GitHub Pages plus IndexedDB is the whole product.

**Consequences.** Sync between a user's own devices is manual (backup files or
the optional server). There is no server-side price aggregation or cache, so
every device talks to the card APIs itself. Rate limits and dying APIs are
therefore an app-level concern — hence the budgets, fallbacks and stale-beats-
broken caching in [card-data.md](card-data.md).

---

### 2. Scanning is fully on-device

**Why.** A cloud-vision scanner would be more accurate out of the box, but it
would mean shipping camera frames to a third party, needing a key to work at
all, and being useless offline. "Point your camera at a card" has to work on a
train, on a first launch, with no account.

**Consequences.** A large, hard-won OCR pipeline (`identify.ts`, `ocr.ts`,
`vision.ts`, `corner.ts`) and the regression harness that keeps it honest. The
OCR engine is self-hosted (~11 MB of worker + wasm + language data) but
lazily fetched and runtime-cached, so
devices that never scan never pay for it. The Gemini key stays scoped to the AI
deck builder — that boundary is load-bearing and stated in three places in the
source.

---

### 3. The collector line is a first-class identifier

**Why.** Names defeat OCR regularly — ornate faces, foil glare, and any card not
printed in Latin script. But every print worldwide carries Latin digits in its
collector line.

**Consequences.** Cards in any language identify without a multilingual OCR
model. It also created the worst failure mode in the app: collector numbers are
dense, so a one-digit misread lands on a *real neighbouring card*. Hence the
guard invariants — a printed slash actually read, independent catalog/API
agreement, set-size verification, fail-closed refusals. **A refusal is a correct
answer here; a confident wrong card is not.**

---

### 4. Confident wrong answers are worse than misses

**Why.** In collect mode a wrong identification silently adds the wrong card at
the wrong price to someone's portfolio. A miss just asks them to try again.

**Consequences.** Every retrieval tolerance is paired with a quality-scaled
acceptance bar; the matrix tracks `wrong-card` as its own stage; turned frames
face a stricter bar than upright ones. The one time tolerance was loosened
without guards, honest misses became 16 confident wrong cards in a single run.

---

### 5. USD only

**Why.** One market (US/English), one currency, one number the user can trust.
Mixing Cardmarket EUR into the same figures produced totals that were neither.

**Consequences.** `'EUR'` survives in the `Currency` type purely so that data
written by pre-0.5 versions can be *filtered out* rather than mislabelled.
Every price reader recomputes from `entries` instead of trusting a stored
headline. Don't reintroduce EUR into maths or UI.

---

### 6. Social is serverless by default; sync is an overlay

**Why.** A share *is* the data — a deflate+base64url payload in a URL fragment,
or the same JSON as a file. Nothing is published anywhere unless the user hands
it to someone. That keeps the no-backend promise intact for the most obviously
"social" feature in the app.

**Consequences.** Links get long (hence the file route past ~20k chars) and
refresh is manual unless the friend hosts their snapshot somewhere. The optional
sync server exists for playgroups who want live updates — but with `syncOn`
false, nothing in `sync.ts` runs, and everything a server returns is
re-sanitized through the same code path as a pasted link. Links and files must
never become second-class.

---

### 7. Everything decoded from outside goes through one sanitizer

**Why.** Links, files, backups and server responses are all untrusted input with
the same shape. Two validation implementations means one of them is weaker.

**Consequences.** `social.ts` owns the sanitizers, and `db.ts`'s backup import
calls them rather than duplicating the rules. Caps, length limits, enum
validation and `https`-only images apply identically whichever door the data
came through.

---

### 8. A hand-written service worker

**Why.** The caching requirements are unusual enough that a plugin's defaults
would fight them: the OCR engine must be runtime-cached but never precached;
price APIs must never be cached; the shell must be all-or-nothing for *critical*
assets but tolerant of a missing icon; opaque responses need special handling.

**Consequences.** `src/sw.js` is ~260 commented lines that must be read before
being edited. Its behaviours exist for named failures: no `skipWaiting` (a
mid-session activation strands the running bundle), `ignoreVary` everywhere
(vite preview's `Vary: Origin` made every precache lookup miss), critical-asset
gating on install (a half-installed shell is a permanently blank offline
launch), and a `cors` re-request in the ext cache (an opaque 403 and a 12 MB
payload are the same object).

---

### 9. `main` is source; `gh-pages` and `harness-fixtures` are machine output

**Why.** This repo originally carried *build output only*, and the source lived
in ephemeral sessions until it was lost. The tree was reconstructed from a
deployed bundle. That must not happen twice.

**Consequences.** `dist/` is gitignored, CI regenerates and force-pushes
`gh-pages` on every push to `main`, and the fixture branch is likewise
force-pushed and never merged. Merging to `main` *is* deploying. The
corresponding discipline: always push source before a session ends.

---

### 10. Dark-only, mobile-first, one stylesheet

**Why.** The scan screen is a camera viewfinder — a light theme fights it. The
whole product is a phone product. One stylesheet with tokens beats a component
library for an app this size, and keeps first paint instant (the critical
styles are inlined in `index.html`).

**Consequences.** No theme toggle, no CSS-in-JS, no design-system dependency.
A 5k-line `styles.css` that new work extends with tokens rather than inline
values.

---

### 11. Optional keys, never required

**Why.** The app must be fully usable with zero configuration. Keys buy
*more* — higher Pokémon rate limits, the AI deck builder — but never gate the
core loop.

**Consequences.** Every key path has a keyless fallback: pokemontcg.io works
unauthenticated (and falls back to TCGdex when it's down), and the builder
simply isn't available without a Gemini key. Telemetry needs both an explicit
opt-in and a token, so it can never be on by accident.

---

### 12. Data caches are honest about being incomplete

**Why.** A partial catalog cached for a day makes real cards read as "doesn't
exist" — a failure that looks exactly like a bug in matching.

**Consequences.** Catalog and group-index loads track completeness. An
incomplete result is served immediately (better than nothing), memory-cached
*backdated* so it retries in five minutes, and **never persisted**. A total
failure falls back to a stale cache rather than an error screen. Cache-shape
versions (`CATALOG_VERSION`, the `v2` group key, the `IMG`/`EXT` suffixes) exist
so a bad cache is fixable by shipping a deploy.
