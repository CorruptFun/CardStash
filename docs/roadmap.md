# Roadmap — measurement, backup, sync

Written 2026-08-14, at the point the repo got its first local checkout. This is
the plan of record for the next several rounds and the reasoning behind the
order. It is not a wish list: each round names what it changes, what must not
change, and what would make it wrong.

**The end state is users all over the world.** The shape is a tiered hybrid —
three data flows, three homes:

| Flow | Home | Who |
| ---- | ---- | --- |
| Collection data, free tier | local IndexedDB + backup to the **user's own** Drive/iCloud | everyone |
| Collection data, sync users | **our** hosted sync, N devices + live social | opt-in |
| Analytics events | **ours**, content-free receiver | everyone, opt-out |
| Entitlement / payment state | **ours** (or StoreKit if native) | seam only, nothing gated |

**Monetization is deliberately deferred.** Everything below ships working and
free. Live social is the strongest paid candidate — it is the only feature with
an unavoidable ongoing per-user cloud cost — but that call gets made from data,
and the data does not exist yet. Hence the order: measurement first.

One economic constraint to design around rather than decide on: **a one-time fee
cannot fund a recurring per-user cost.** It fits pure-client features (binder
scanning, upload — zero marginal cost); it structurally mismatches hosted sync.

---

## Settled decisions

| Question | Answer | Consequence |
| -------- | ------ | ----------- |
| Analytics consent | **Opt-out** — on by default, disclosed, one tap off | Needs a first-run disclosure and an EU carve-out (below). Without it the measured population is ~0. |
| Receiver platform | **Supabase — a NEW project, in its own organization** | See "Why not the shared project" below. The `first-party-analytics` and `supabase-migrations` skills target this shape, and viva-maya's `0010`/`0015`/`0019` lessons transfer directly. Reusable as the round-3 sync backend. |
| Consent geography | **US-first; timezone-derived EEA/UK carve-out** | No geolocation API, no IP lookup, no prompt. US users are auto-on with zero interaction. |
| Naming | **CardStash** for the product; storage/wire identifiers **frozen** as `cardstock` | See round 7 — renaming the Dexie DB would orphan every existing collection. |

---

## What orientation found

Four things that the docs get wrong or omit, each of which changes a round.

### 1. The analytics client cannot measure anyone as built

[`analytics.ts`](../src/lib/analytics.ts) `flushTelemetry` no-ops unless
`diagShare` **and** an endpoint **and** a **`diagToken`** are set. The token is a
free-text field in Settings. No real user types a bearer token into a scanner
app, so a perfect receiver would collect events from exactly one person.

**The receiver is necessary but not sufficient.** Round 0 is *client gate +
receiver*, and the gate is a privacy decision, not a code decision.

### 2. `docs/social.md`'s "storage swap rather than a client rewrite" is half true

Verified against the source rather than taken on trust.

- **True for the social overlay.** `binders` (whole-document PUT) and `inbox`
  (append + cursor drain) port onto Postgres tables with RLS cleanly.
- **False for collection sync**, which is what the paid tier actually needs.

What travels today is `ProfilePayload.cards: SharedCard[]`, built by
`shareableItems()`. Against `CollectionItem` it:

- **drops** `id` (row identity), `purchasePrice` (**all cost basis and P&L**),
  `note`, `addedAt`, `opened`, and the entire `card` object;
- **overwrites `qty` with the for-trade count** under the default `scope: 'trade'`;
- **excludes opened sealed rows entirely**;
- carries **no decks, deckCards, history or scans**.

And the transport has no sync semantics: a full-document `PUT` gated on a payload
hash, with **no deletions** (absence ≠ delete), **no per-row versioning**, and
**no `updatedAt` on `CollectionItem`** — only `addedAt`. `pullFriends` applies a
snapshot wholesale when `payload.at > friend.exportedAt`, which *is*
last-write-wins.

**Collection sync is a new subsystem.** Plan for the rewrite.

### 3. The `detectCardRegions` rationale is stale — the rule survives, the reason does not

[`CLAUDE.md`](../CLAUDE.md) and [`entitlement.ts`](../src/lib/entitlement.ts) both
say the detector is "shared with free single-card scanning on cluttered
backgrounds." **Scan-harness lesson 41 measured that hypothesis and rejected
it** — 3 boxes and none the card on one photo, 7 and none on another; "the
single-card substitution was NOT shipped." The only production caller is
[`multiscan.ts`](../src/lib/multiscan.ts). `ScanView.tsx` already says this
correctly; `entitlement.ts` contradicts it.

**Keep the rule — never gate the detector.** The honest reason is
forward-looking: it is the *named fix path* for the free single-card gap (run the
gradient on a chroma projection rather than luma, the same fix that paid off for
OCR), so gating it would gate the fix before it ships. Correct the rationale, or
someone finds the contradiction and flips the rule.

### 4. The scan pipeline's real problem is wrong cards on the live path

Lesson 47: the still matrix reports **0 wrong cards across 282 cells**; two
ordinary handheld clips produced **10 wrong in 40 identifications**. Decision 4
calls a confident wrong card the worst failure class, and in **collect mode it is
filed silently with no confirmation.** Identify rate is not the number to move.

### 5. `telemetry.corrupt.solutions` is not a telemetry receiver (verified 2026-08-14)

It ships as `DEFAULT_DIAG_ENDPOINT` in every install, and it is not what it looks
like:

| Check | Result |
| ----- | ------ |
| DNS | resolves, Cloudflare-proxied |
| `GET /` | **200 — serves Family Hub** |
| `GET /ingest/telemetry` | **404** |
| References across `~/Creative` | **only CardStash** |

No harm has been done, because the `diagToken` gate meant nothing was ever sent.
But removing that gate without repointing the endpoint would 404 every event into
Family Hub's origin. **The endpoint constant and the `merge()` rewrite in round 0a
are therefore both required, not optional.**

What the sibling apps actually use: viva-maya, Turbo Maze and primos-run all POST
directly to Supabase project `deskabqqxqqibxjffwmb` at
`/rest/v1/rpc/ingest_events`. The "Gmail for game saves" path is viva-maya's
`core/cloud.ts` — Google OAuth straight to that same project. Its contract is a
good model for round 3: **dormant until configured, localStorage stays
authoritative, the cloud is a mirror.**

### 6. Why not the shared Supabase project

Three apps already share `deskabqqxqqibxjffwmb`, and
`primos-run/docs/ANALYTICS.md` documents what that cost:

- `schema_migrations` is **per-project, not per-app**, so Primos' `0001`–`0003`
  collided with Viva Maya's and Turbo Maze's by numeric coincidence.
- **`supabase db push` applied nothing and reported success.** Silent failure.
- The CLI's suggested repair would have marked **Viva Maya's and Turbo Maze's
  twenty migrations as reverted.**
- The standing workaround is applying every migration by hand via `db query` and
  recording nothing in `schema_migrations` — permanently.

CardStash would be the fourth app paying that tax, and it needs the most
migrations of any of them (analytics now, sync schema later, entitlement later).
Blast radius compounds it: an anonymous high-volume event firehose must never be
able to fill the database holding users' game saves.

**A new project in its own organization** sidesteps both the migration collision
and the per-org free-project cap. ⚠️ Confirm the current cap in the dashboard —
`deskabqqxqqibxjffwmb` + `family-hub` may already occupy it, and that limit has
moved before.

### Also worth knowing

- `tests/harness/fixtures/` is empty and there is no `report/baseline.json`, so
  **`npm run test:scan` cannot run** until `harness-fixtures` is pulled via
  `git archive` (never a `--work-tree` checkout). `test:photos` and `test:clips`
  work now — those are committed.
- Health at checkout: `npm run build` exit 0 in 1.14s (main chunk 621.55 KB /
  199.97 KB gzip); `npm run test:unit` 98 pass / 1 skipped / 0 fail.

---

## Round 0 — Measurement

The highest-value round and the current blind spot. "I need users first" and "I
cannot measure users" are the same problem.

### 0a. Client consent gate

- **`diagShare` defaults to `true`**, with a first-run disclosure and a one-tap
  off in Settings. The payload is content-free by construction, which is what
  makes this defensible — it is not a licence to relax the redaction contract.
- **Drop the mandatory `diagToken`** for the first-party endpoint. Keep token
  auth for the *custom endpoint* path, which becomes the advanced option.
- **EU/UK carve-out.** ePrivacy consent applies to any non-essential storage
  access, not just cookies, so worldwide opt-out is not lawful everywhere. Detect
  an EU/EEA/UK timezone from `Intl.DateTimeFormat().resolvedOptions().timeZone` —
  local, zero egress, no IP geolocation — and show a first-run *ask* there
  instead of a disclosure. Everywhere else gets opt-out.
- ⚠️ **`diagEndpoint` is already persisted in every existing install.** zustand
  `persist` writes the whole settings object, so the shipped default
  `https://telemetry.corrupt.solutions/ingest/telemetry` sits in users'
  localStorage today. Changing the constant does **not** move them. The
  `merge()` function in [`settings.ts`](../src/lib/settings.ts) must rewrite a
  stored endpoint that equals the old default — `merge()` already sanitizes
  `enabledGames`/`gameFilter`, so the precedent is there. Miss this and every
  existing install posts at a dead host forever.
- Add `EVENT_TYPES` entries for the new surfaces (backup, restore, sync
  lifecycle) **before** the receiver ships, so the receiver never meets a name it
  has to bucket on day one.

**Unchanged, and non-negotiable:** the fixed event whitelist, the forbidden-key
list, `SAFE_STRING`, hashed errors, `hashToken(readName)` for failing cards,
bucketed collection size, and the rule that `scandebug.ts` never feeds analytics.

### 0b. The receiver

Supabase. Follow the `first-party-analytics` skill's invariants; **do not align
the schema with viva-maya's** — different trust models, and `privacy.md` is
explicit that the lessons transfer and the schema does not.

Non-negotiables:

1. Append-only table: **INSERT policy, no SELECT policy, ever.** An event log is
   a per-device behavioural history.
2. Ingestion through a **`SECURITY DEFINER` function** with
   `set search_path = public, pg_temp`. **Never `ON CONFLICT` against the table**
   — Postgres folds the empty SELECT policy list in as a constant-false
   `WITH CHECK`, so every insert 401s *including the first*, and the client drops
   the batch as permanently rejected. That is viva-maya `0019`, and it took that
   project's event stream entirely dark.
3. **Bucket unknown event names to `unknown`, never reject.** A PWA with a
   hand-written service worker has several bundles live at once.
4. **Stamp receipt time server-side.** The client's `at` is its own clock.
5. Guard trigger bounds the damage (name shape, props size) and **never throws**.
6. The wire shape is our **batched envelope**
   (`{app, v, device, firstSeen, sessions, activeDays, sentAt, events[]}`), not
   viva-maya's per-row POST. The ingest function unrolls it.
7. **The receiver never needs to be reachable.** Analytics failing must never
   change app behaviour. `flushTelemetry` already swallows everything; keep it.

Two-phase deploy per the `supabase-migrations` rule: schema first, client second.
Cached clients sit on old bundles for days.

### 0b-ii. Volume — retention and rollups are day-one, not later

At ~38 events/day per active user and ~350 bytes/row all-in with indexes:

| Users | Raw, no retention | With 60-day retention (steady state) |
| ----- | ----------------- | ------------------------------------ |
| 100 DAU | 40 MB/mo | ~80 MB — free tier, indefinitely |
| 1,000 DAU | **400 MB/mo — free tier gone in ~5 weeks** | ~800 MB — needs Pro (8 GB) |
| 10,000 DAU | ~4 GB/mo | ~8 GB — at Pro's included limit |

**~1,000 DAU eats the free tier in about a month.** Three levers, in the order
they should exist:

1. **Nightly rollups into `metrics_daily`** — DAU, sessions, scan success by
   game, top failure hashes. A few KB/day, **~2 MB/year, kept forever.** Raw
   events become the expensive disposable layer; aggregates become the cheap
   permanent one. This is the structural answer to volume.
2. **60-day retention on raw events** — viva-maya's `prune_events` pattern,
   tighter. Nobody queries a raw scan attempt from six months ago.
3. **Sampling on `scan_attempt` only** — it is ~40% of all volume and the least
   individually valuable (one binder session fires ~50). 1-in-5 cuts total volume
   ~32% while `scan_failure` stays at 100%, because failure diagnosis needs every
   failure. **A knob for if volume shows up — do not turn it on before measuring.**

### 0c. Dashboard

Retention, funnels, and `scan_failure` grouped by `hashToken` bucket × game ×
stage. That last view is the direct input to round 6 — it is how "which cards
defeat the scanner" gets answered without ever storing a card name.

### 0d. Doc debt (rides along — pure prose)

- **Decision 1 superseded, narrowly.** A backend now exists. Its spirit survives:
  the free tier is still local-first, no account, no server, fully offline.
- **Decision 13 grows** to record that the seam spans sync/live-social too, and
  that monetization is deferred until there are users to measure.
- **Decision 14** updated with what round 1 does and does not close.
- **`privacy.md`** — egress table, data-at-rest and keys gain two opt-in
  destinations (the user's Drive/iCloud; our sync + analytics endpoints).
  GDPR/CCPA becomes real for subscribers: retention, deletion path, and
  Settings → Erase must also erase server-side.
- **`README.md`'s "no accounts, no server required" is reworded, not retracted** —
  it stays true for the free tier, "+ optional sync".
- **`entitlement.ts`'s `detectCardRegions` rationale corrected** per finding 3.

### 0e. One schema change that cannot wait

Add **`updatedAt` to `CollectionItem`** and a **tombstone table** (Dexie v7).

~20 lines now, **unbackfillable later**. Every row written between now and round
3 otherwise has no merge basis, and merging without one is exactly the ManaBox
footgun. This is the cheapest possible insurance against the round-3 failure mode
that costs other apps their support queue.

---

## Round 1 — Free-tier backup to user-owned cloud

The piece that closes the iOS trap for everyone at zero storage cost to us. It
should be boring and reliable, not clever.

**Google Drive `appDataFolder`.** Scope `drive.appdata` grants access only to a
hidden per-app folder and never to user files, which is why it is the right scope
rather than `drive.file`. On current understanding it sits in the **non-sensitive**
tier — no restricted-scope security assessment, no audit — so the cost is an
OAuth client id and a consent screen. ⚠️ **Verify against current Google docs
before committing to that estimate**; scope tiers have moved before.

**iCloud is not symmetric with Drive, and the plan's table implies it is.** There
is **no web API for iCloud Drive**. CloudKit JS needs an Apple Developer account
and a container tied to a native app. For a PWA, "iCloud backup" realistically
means the iOS share sheet — *save the export into iCloud Drive* — which can be
one-tap but not automatic. Real symmetry needs the native wrapper from decision
14. Document that rather than planning a capability that does not exist.

**Failure behaviour, decided up front:**

| Situation | Behaviour |
| --------- | --------- |
| Offline | Queue, retry later. No UI change, no error. |
| Access revoked | One toast, backup marked stale, app otherwise unaffected. |
| Provider down | Same as offline. Backup is never load-bearing. |
| Two devices, both edited offline | Backup is a snapshot, not sync — newest wins, and the restore screen says so plainly. Real merge is round 3. |

---

## Round 2 — The iOS data-loss trap

**Exposure today is real, and v0.13.0 made it worse.** We actively nudge
installation, and installation is the exact moment the collection disappears: an
installed PWA gets storage partitioned away from Safari, so it starts empty, and
the only bridge is manual export → install → import.

**Round 1 closes half of it.** It removes the file handling and the "remember to
export" requirement, so a restore path exists that does not depend on user
discipline. It does **not** make the migration automatic — the installed PWA is a
different storage partition, so the user signs in to Drive again there. Net:
export→install→import becomes sign-in→install→sign-in→restore. Better, not
solved. Nothing in the web platform solves it; that is decision 14's App Store
bullet, honestly stated.

**One small high-value change regardless:** `InstallPrompt` should refuse to nudge
installation until a backup exists. Nudging install before backup *is* the trap.

---

## Round 3 — Paid-capable sync (built and shipped ungated)

**Auth + recovery.** Email magic-link or OAuth as the identity. The device token
becomes a *session*, not an identity; the profile id becomes a column on an
account row. **Do not inherit today's trust-on-first-use** — losing a device
token currently loses the profile id forever. Recovery is "sign in again," which
is the entire point of having accounts at all.

**Schema.** `binders`/`inbox` port as-is (finding 2 — that half of the doc's
claim holds). Collection sync is new: per-row natural key (reuse the
`snapshotKey` shape social.ts already uses for friend diffs — cardId + finish +
condition + set + number), `updatedAt`, tombstones, RLS as the trust boundary,
and a device-count limit.

**First-sync merge — the ManaBox footgun, designed away.** Their documented
failure is that enabling sync takes data from whichever device you enabled it on,
and support has to rescue users who got it wrong.

- **First sync is a union, never a replace**, with an explicit user-visible
  review when both sides hold the same key at different quantities.
- **Subsequent syncs are a 3-way merge** against a last-synced base — which is
  precisely what round 0e's `updatedAt` + tombstones exist to make possible.
- Deletions travel as tombstones. Absence never means delete.

**Unchanged:** everything the server returns goes through the `social.ts`
sanitizers. Settings → Erase must erase server-side too. Social stays serverless
by default — links and files are never second-class, and `syncOn` false still
means nothing in `sync.ts` runs.

---

## Round 4 — Grow the entitlement seam

`PaidFeature` gains `'cloud-sync'` and `'live-social'`, checked at the
sync-enable control and the live-social entry point, joining `'photo-upload'` and
`'page-scan'`.

**Every `GATED` row stays `false`.** Nothing is gated this round. The point is
that if we later choose to charge for any of the four, it is a row flip and not a
refactor. Still never on `detectCardRegions` (finding 3).

---

## Round 5 — Bundle size: not a real problem

621 KB raw is **200 KB gzip**, precached by the service worker as one build-keyed
unit and then served from cache. Splitting buys ~nothing on repeat visits and
actively costs: precache is all-or-nothing for critical assets, so more chunks
means more ways for a half-installed shell to become a permanently blank offline
launch (decision 8).

**Verdict: raise `chunkSizeWarningLimit` and silence the false alarm.** If a trim
is wanted anyway, the honest candidates are `gemini.ts`, `demo.ts` and
`importexport.ts` — none needed at first paint — but that is polish, not a fix.
The genuinely large payload is the ~11 MB OCR engine, already correctly excluded
from precache and runtime-cached only on devices that actually scan.

---

## Round 6 — The scan pipeline

Read the `scan-harness` skill first; it is the authority. Then:

1. Pull `harness-fixtures` (`git archive`, **never** `--work-tree`).
2. **Re-baseline on the current snapshot.** Absolute numbers only compare within
   one fixture snapshot.
3. Go after the **wrong-card rate on the live path** (finding 4), not the
   identify rate. Lever per lesson 48: frame selection, plus requiring agreement
   across two attempts before committing — weighted hardest in collect mode,
   where a hit is filed with no confirmation.
4. Full matrix before and after with `--baseline=`; a fix ships only if no game
   drops. Then `test:unit`, `build`, `smoke-app.mjs`.
5. **Reproduce every verdict twice.** Marginal cells flap ±1–2 between identical
   runs — but track the specific cell across runs rather than hiding behind that.

The open lead worth taking if the above lands: lesson 41's chroma projection for
`detectCardRegions`, which is the named fix for free single-card detection on
cluttered backgrounds and the reason the detector must stay ungated.

---

## Round 7 — Naming

**CardStash** is the product name — repo, live URL, README, CLAUDE.md, docs, UI.

**Freeze the storage and wire identifiers as `cardstock`.** This is not laziness:

| Identifier | Renaming it would… |
| ---------- | ------------------ |
| Dexie DB `cardstock` | **orphan every existing collection** — a data-loss bug, in the project whose current push is preventing data loss |
| localStorage `cardstock-settings` | reset every user's preferences and API keys |
| `app: 'cardstock-social'` | break **every share link in the wild, in both directions** — `sanitizePayload` throws `NOT_SOCIAL` on a mismatch |
| `app: 'cardstock-sync'` | break `checkSyncServer` against every running server |
| analytics `app: 'cardstock'` | split the event stream at the rename |

Leave a one-line comment at each explaining why the old spelling stays.

**Also in this pass — `README.md` is wrong about scanning.** It claims "live
camera identification (Gemini vision with your own API key, or on-device OCR
fallback)". That contradicts decision 2 and CLAUDE.md's hard rule that scanning
is fully on-device and Gemini is the deck builder only. It is the most
load-bearing privacy claim in the product, misstated in the public README. The
README also lists three games; there are nine.

---

## Things to verify before relying on them

- `drive.appdata`'s current scope tier and review requirement (round 1). The
  whole cost case for Drive backup rests on it being non-sensitive.
- Supabase's current free-project cap per organization (finding 6).
- Whether zustand `persist` has written `diagEndpoint` for installs that never
  changed a setting, or only for those that did. The `merge()` fix covers both,
  but the blast radius differs.

~~What `telemetry.corrupt.solutions` actually is~~ — **answered, see finding 5.**
It serves Family Hub and `/ingest/telemetry` 404s.
