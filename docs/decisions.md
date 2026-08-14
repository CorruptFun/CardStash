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

### 13. The paid tier has a seam, but no authority

**Why.** Photo upload and binder/multi-card scanning are intended to become a
paid subscription. Neither is gated today, and neither should be while it is
still being built — but retrofitting a gate across call sites later is how you
end up gating the wrong thing.

**Consequences.** `lib/entitlement.ts` is a `GATED` table with every row `false`
and one `isEntitled()` check. Flipping a row is the whole change. It
deliberately reads and writes **no** settings: nothing stores an entitlement
yet, and inventing storage for one would pick an answer to the open question
below by accident.

The seam sits on **entry points** — the upload control, the page-scan path — and
**never on `detectCardRegions`**. That primitive is shared with ordinary
single-card detection on cluttered backgrounds, which is the free path and the
dominant real-world failure. Gating the detector would quietly degrade free
scanning for everyone who never buys anything.

**Still open, and deliberately so.** Entitlement has no home in this
architecture. The deployed app is a static `gh-pages` bundle with no backend,
and `server/` is a sync box the *user* hosts, so it can never be the authority
on whether that same user has paid. Three honest options, ordered by how well
they preserve local-first:

1. **Soft/client-side gating** — a settings flag, trivially bypassed via
   devtools. Fine if the subscription is support rather than enforcement. No
   backend, stays offline-first.
2. **A third-party entitlement check** (Stripe/RevenueCat/similar) at launch,
   result cached, app fully usable offline afterwards. Introduces the first hard
   network dependency — decide deliberately what happens when it is unreachable,
   and make that *keep working*, not *lock out*.
3. **A first-party backend** — contradicts decision 1 and is a much larger
   change.

Whichever is chosen: scanning keeps working offline, and analytics stay
content-free. Subscription state is not a reason to start sending card data
anywhere.

---

### 14. One device holds everything, and nothing yet moves it

**Decision.** A user's collection lives in exactly one place: IndexedDB on the
device that scanned it. There is no cloud copy, no account, and no sync unless
the user stands up `server/` themselves. The only way data leaves a device is
Settings → Export, by hand.

**Why it is written down.** This is the load-bearing consequence of decision 1
(no backend), and it is the one users feel. It has two costs that are easy to
discover the hard way:

- **Loss.** A lost, wiped or reset device takes the collection with it. On iOS
  the bar is far lower, and the shape of it matters: WebKit evicts
  script-writable storage for an origin unused for ~7 days, `persist()` is
  granted only to Home Screen web apps, **and** a Home Screen web app gets
  storage partitioned away from Safari. So durable storage on iOS requires
  installing, and installing starts from an empty collection. There is no
  in-app path from one to the other — only export → install → import, by hand.
  `InstallPrompt.tsx` (v0.12.0) walks the user through exactly that, but a
  three-step manual migration is a workaround for a missing capability, not a
  solution to it.
- **One device.** Scanning is a phone job; organising a large collection is a
  desktop job. Today those are two unrelated collections, because nothing
  carries rows between them. The app is a fine desktop *app* already — it is a
  responsive PWA — but it is not the *same* collection.

**Option 2 is chosen and half-built (2026-08-14).** `lib/drive.ts` backs the
collection up to the user's own Google Drive `appDataFolder`, daily and
automatically, with the last five kept. It holds the local-first line exactly:
the browser talks to Google directly, we host and store nothing, and the free
tier gains **no dependency on any backend of ours** — a property that must
survive the arrival of hosted sync, because a user who never signs up for
anything still deserves their collection protected.

**It closes half of the iOS trap, and the honest accounting matters.** It removes
the file handling and the "remember to export" discipline, so a restore path
exists that does not depend on the user keeping track of a download. It does not
make the migration automatic: an installed PWA is a different storage partition,
so the user signs in to Drive again on the other side. Export → install → import
becomes sign-in → install → sign-in → restore. Nothing in the web platform closes
the rest; that is the App Store note below.

**Options, ordered by how well they preserve local-first.**

1. **Export/import by hand** — what exists. Zero infrastructure, zero accounts,
   and it works offline. Costs the user a deliberate act they must remember,
   and it is the *only* thing standing between an iOS user and losing
   everything at the moment they follow our own advice to install.
2. **User-owned cloud storage** (Google Drive `appDataFolder`, Dropbox,
   OneDrive). The browser talks to the provider directly; the app hosts and
   stores nothing, and the data sits in the user's own account rather than
   ours. Solves backup *and* multi-device in one move without contradicting
   decision 1. Costs: an OAuth client id, provider review for the scope, and a
   conflict rule for two devices edited offline. Best fit on current evidence.
3. **The existing self-hosted `server/`** — already built and already syncs,
   but only for users willing to run a server.
4. **A first-party backend** — contradicts decision 1.

**On shipping to the App Store.** Worth being precise about what a native
wrapper does and does not buy, because it is easy to assume it settles all of
this at once. It solves **storage durability** (a native app's storage is not
subject to WebKit's eviction sweep), **discoverability**, and — via StoreKit
receipts — it is the first credible answer to the entitlement-authority problem in
decision 13. It does **not** solve backup, device loss, or desktop parity;
those still need option 2 or 3 above. And it adds a constraint: App Review
guideline 3.1.1 requires in-app purchase for digital features, so a paid tier
sold in the app cannot route around it. If the PWA keeps serving desktop while
iOS goes native, the two need to share a collection — which makes cross-device
sync a prerequisite of that plan, not an alternative to it.


---

### 15. The cloud vault is encrypted on the device, and that is not negotiable

**Why.** Decision 14 established that one device holding everything is a real
cost, and that iOS makes it acute. Fixing it means a server, which contradicts
decision 1 — so the contradiction is paid for as narrowly as possible: the
server stores a blob it cannot read. Sign-in (Supabase Auth) answers *who you
are*; a passphrase that never leaves the device answers *what the bytes mean*.
Collapsing those into one secret would hand whoever runs the project a
readable database of everyone's collections, which is precisely the liability
local-first existed to avoid.

**Consequences.** A second device is two steps, not one — sign in, then enter
the passphrase — and there is no reset, so the UI says so in as many words
rather than discovering it for the user later. The key is never persisted; a
reload asks again. `supabase/schema.sql` is not setup, it is the lock: the
publishable key is public by design and RLS is the only thing standing between
it and the table.

**What this does not buy.** Entitlement. A Supabase login proves identity, not
payment, so decision 13 is untouched — though the same auth would be the
natural place to hang a real answer later.
