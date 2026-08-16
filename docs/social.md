# Friends, trades and sync

## The stance: serverless by default, hosted by choice

Everything social works with **no server at all**, and that path must keep
working. A share *is* the data: a profile snapshot compressed into a URL
fragment, or the same JSON as a file. Nothing is published anywhere unless the
user sends it to someone.

**Hosted social** (Supabase — see the second half of this document) is an
opt-in overlay on top of that, not a replacement. Signed out, or signed in
without publishing, nothing about the link path changes. Never make links or
files a second-class citizen, and never route them through a server.

Everything decoded from a link, a file, a backup or a server response is
**untrusted** and goes through the sanitizers in `social.ts`. There is one
validation implementation, and this is it — hosting does not earn the server
any trust it would not extend to a pasted string.

> **The self-hosted box is being retired.** `server/sync-server.mjs` and
> `lib/sync.ts` were the LAN answer to live updates. Hosted social supersedes
> them, and the migration note at the end of this document records what that
> costs and who it affects.

## Identity

Two identities exist, and which one you have decides what social can do.

**Serverless — `profileId`.** `ensureProfileId()` mints a `uid()` on first share
and keeps it forever; `myProfile()` returns `{ id, name, note, scope }` from
settings. There are no accounts and no recovery: clearing browser storage loses
the id, every friend who followed that binder is now following a dead id, and
nothing can ever be republished under it. That is the worst property of the
serverless design, and it is why accounts exist at all.

**Hosted — the Supabase user.** Signed in, the account *is* the identity. Sign
in anywhere and you are you; a lost device costs nothing. The `handle`
(`@rae`) is the human-facing name for that row and the thing friends type
instead of pasting a link.

**They coexist deliberately.** A `ProfilePayload.id` is an opaque string that
`sanitizeParty` caps at 64 characters, so a legacy `uid()` and a Supabase uuid
both validate. Friends imported before hosting keep working, and a signed-in
user's shares carry their uuid so the two halves of their social graph converge
on one id rather than forking.

## Payloads

Three kinds, all carrying `app: 'cardstock-social', v: 1`:

| Kind | Built by | Contents |
| ---- | -------- | -------- |
| `profile` | `buildProfilePayload(items, me, wants)` | `id`, `name`, `note`, `scope`, `at`, `cards: SharedCard[]`, `wants?: SharedWant[]`, `links?: SocialLink[]` |
| `trade` | `buildTradePayload(trade, me)` | `id`, `at`, `from`, `to?`, `note?`, `offer` (what the sender hands over), `want` (what they want back) |
| `reply` | `buildReplyPayload(trade, me, status, note)` | `id`, `at`, `from`, `status: accepted \| declined`, `note?` |

**Perspective flips at the wire.** A `TradeRecord` stores `give`/`get` from the
local user's point of view. `buildTradePayload` sends `give` as `offer`;
`tradeFromPayload` turns a received `offer` into the receiver's `get` and the
`want` into their `give`. Get this backwards and both sides see the trade
inverted.

### Share scope

`shareableItems(items, scope)` filters what travels: rows with `qty > 0` and
never an **opened** sealed product.

- `scope: 'trade'` (default) — only rows with `forTrade > 0`, and the shared
  `qty` is set to the for-trade count. Your binder shows what you'll actually
  trade, not what you own.
- `scope: 'all'` — every row at full quantity.

`SharedCard.price` is the finish's market unit **without** the condition factor
applied; `sharedRowValue()` multiplies it in on the viewer's side. Both sides
therefore agree on the maths even if their app versions differ.

## Social profile links

A collector can show where else to find them — Instagram, Discord, a Whatnot
store — as tappable icons under their name on their binder. `lib/profilelinks.ts`
is the whole pure half; `settings.profileLinks` is where mine live;
`components/ProfileLinks.tsx` is the editor and the icon row.

**They ride the binder, not the directory profile,** and that is the decision
rather than an implementation detail. `profiles` (migration 0001) is readable by
every signed-in user and its own header says it carries identity ONLY — the
contact blurb lives on the binder row precisely so it inherits scope-driven
visibility. Links are the same class of fact, so they go the same way. Three
things follow:

- their audience is the **binder's** audience: anyone you send a link to, plus
  every signed-in collector under `scope: 'trade'`, or accepted friends only
  under `scope: 'all'`;
- they work with **no account at all** — they travel in a `#/x?d=…` link and a
  `.json` file like the note beside them;
- moving them to `profiles` later would silently widen them to every stranger
  in the directory. Don't.

**The vocabulary is closed and the URL is built, never stored.** A handle-kind
link stores the *handle*; `socialLinkUrl()` builds the href from a table. That
makes "the icon matches the destination" a property of the code rather than a
promise about data that arrived over the wire — an `<a href>` rendered from a
stranger's payload is otherwise a stored redirect wearing an Instagram glyph.
`website` is the one kind that holds a URL, is `https:`-only, and renders as a
neutral globe. Discord has no profile page, so it is copy-to-clipboard rather
than a link to a 404. Capped at 8 per profile, one per platform, sanitized on
the way in *and* on the way out of localStorage.

## Wire format

```
link:  <origin><path>[?via=<handle>]#/x?d=<blob>
blob:  'D' + base64url(deflate-raw(JSON))     ← normal
       'J' + base64url(JSON)                   ← fallback where CompressionStream is missing
file:  pretty-printed JSON, the same envelope
```

`?via=` is the referral code (see *Referrals and the founding offer* below) and
appears only for a sharer who has claimed a handle. It sits in the **search**
string, never the fragment: `parseRoute` reads the fragment and
`decodeShareText` scans it for `[?&]d=`, so the two can never be confused in
either direction, and a chat app that truncates a 20k link eats the end of it
rather than the code. A sharer with no handle gets the old URL byte for byte.

`decodeShareText()` accepts any of: a full link, a bare blob, file JSON, or a
sync-server binder response (`{updatedAt, payload}` — it unwraps `payload` so a
server endpoint can be pasted in like any other link).

`LONG_LINK_CHARS = 20_000` is the point past which a link stops pasting cleanly
into chat apps; the UI offers the file route beyond it.

Hosted refresh: `fetchSharedProfile(url)` fetches a raw URL (a GitHub Gist raw
link is the documented example — the host must allow cross-site reads) and
decodes it as a profile. A friend imported that way keeps its `sourceUrl`, which
is what makes one-tap refresh possible.

## Wants and matchmaking

Wants are **card-level**: `wantKeyFor(game, name)` → `` `${game}|${normalized
name}` ``. Any printing matches. Matchmaking compares want *keys* on both sides
— never card ids — so "I want a Charizard" matches their Charizard from any set.

Wants travel inside a profile share, so both sides can see matches: cards of
theirs you're hunting, and cards of yours they're hunting.

**Two tiers, same key.** Serverless matchmaking can only compare against
friends whose binder you already imported — which means you only ever find
cards held by people you already know. Hosted adds a global tier: the
`match_wants` RPC answers "who is offering this key?" across every publisher
with a discoverable binder. It is the one genuinely new capability hosting
buys, and it is impossible without a server. The key shape is identical, so a
match is a match whichever tier found it.

## Friends

`upsertFriendFromProfile(payload, sourceUrl?)` imports or refreshes a friend.
`friendFromProfile` computes the row-level diff against the previous snapshot
(`snapshotKey` = cardId + finish + condition + set + number) and stores it as
`lastDelta` — the "+3 / −1 since last refresh" line. `addedAt` and `sourceUrl`
survive refreshes; `exportedAt` (their own stamp) is the freshness test used by
the sync poller so a re-publish of identical content doesn't churn local rows.

Removing a friend leaves trades intact — a trade carries its own copy of the
name and cards.

## Trades

Flow with **no server**:

1. Propose — `TradeView`/`TradeComposer` builds a `TradeRecord` (direction
   `out`, status `proposed`), then `ShareActions` hands over the link/file.
2. The other side opens `#/x?d=…` → `IngestView` previews it → saving calls
   `recordIncomingTrade` (direction `in`). A proposal they have already answered
   is kept, not overwritten.
3. They accept or decline; that produces a **reply** link.
4. The proposer opens the reply link. `IngestView` applies it immediately —
   the link *is* the answer — via `applyTradeReply`, which refuses to reopen a
   trade that is already `completed` or `canceled`.
5. When the physical cards actually change hands, `applyTradeToCollection`
   books it: given copies leave (exact printing first, then for-trade rows),
   received copies arrive as normal rows, the trade flips to `completed` with
   `appliedAt`. Copies the collection no longer holds are reported as `short`
   rather than blocking the booking.

## Sanitization contract

`sanitizePayload(raw)` is the only door. Rules:

- an `app` field, if present, must equal `cardstock-social`;
- `kind` must be one of the three; anything else throws `NOT_SOCIAL`;
- a trade with neither an offer nor a want is rejected;
- strings are trimmed and length-capped (name 60, note 400, cardId 160, card
  name 200, setName 120, number 32, rarity 40, image URL 500);
- `finish` and `condition` are validated against the enums, defaulting to
  `nonfoil` / `NM`; the game is derived from the card id's prefix and must be a
  known game;
- quantities clamp to `[1, 9999]`, `forTrade` clamps to `[0, qty]`;
- prices must be finite, `> 0` and `< 1_000_000`, rounded to cents;
- timestamps outside 2001…now+1y are replaced with "now";
- images must be `https://` — anything else is dropped;
- collection caps: 8,000 profile cards, 400 cards per trade side, 2,000 wants.

`sanitizeFriendRecord`, `sanitizeTradeRecord` and `sanitizeWantRecord` are the
stored-row equivalents, reused by backup import so a backup file gets exactly
the same treatment as a pasted link.

---

# Hosted social (Supabase)

Accounts, mutual friends, a trade inbox and global want-matching, on the same
project that already holds the cloud vault. Schema in `supabase/migrations/`
(`0001`–`0004`, plus `0017` for messages); the first four were applied and
verified against the live project 2026-08-14.

**It is dormant until the user opts in.** Signed out, none of this runs and the
link path behaves exactly as it always has.

## Why hosting was worth it here

Every one of these is a property the serverless design cannot have, not a
polish item:

| Serverless today | Hosted |
| ---------------- | ------ |
| `profileId` in localStorage; clearing storage destroys your identity permanently and orphans every follower | The account is the identity — recoverable on any device |
| Add a friend by pasting a link up to 20,000 chars, then a file beyond that | Add by `@handle` |
| A trade is four hops of links, either of which can be lost in a chat app | A proposal is a row addressed to a user; their app finds it |
| Friends' binders refresh manually, or you host a JSON file somewhere with CORS | They refresh themselves |
| Matchmaking only against friends whose binder you already imported | Global — "who has the card I'm hunting?" |

## THE VISIBILITY RULE

The one thing to understand before touching `0003_social_binders.sql`. Scope
drives visibility, reusing the **For trade / Everything** toggle already in
`FriendsView` rather than adding a second privacy control beside it:

| `scope` | Who can read the binder | Why |
| ------- | ----------------------- | --- |
| `trade` | **any signed-in user** | You published cards you want to swap. Being findable is the entire purpose, and it is what makes global matching possible. |
| `all` | **accepted friends only** | A full collection inventory is a valuation and theft target. Never world-readable, whatever else is on. |

Expressed as three permissive `SELECT` policies that OR together — owner,
`scope='trade'` + signed in, `scope='all'` + `are_friends()`. They are kept
separate rather than folded into one boolean so each audience is independently
reviewable.

Two consequences that must survive any later edit:

- **Only `scope='trade'` publishers enter the `trade_offers` index.** A
  friends-only binder must never be globally matchable through a side door.
  `publish_binder()` enforces this by rebuilding the row and the index in one
  call, so there is no instant where a user who just switched to friends-only
  is still globally listed. This is tested.
- **Switching `all` → `trade` widens the audience of a document already
  uploaded.** The client must say plainly which audience it is about to
  publish to. Silently re-scoping someone's collection is the failure this
  whole rule exists to prevent.

## What the server can and cannot read

This is where hosted social and the cloud vault deliberately diverge, and
conflating them would undo decision 15.

| | `vaults` | `binders` |
| --- | --- | --- |
| Contents | your whole collection | only what you chose to publish |
| At rest | ciphertext the server cannot read | plaintext JSON |
| Key | your passphrase, never uploaded | none |
| Audience | you | per the visibility rule above |

Social **cannot** be end-to-end encrypted the way the vault is: a friend's app
has to read your binder, so the server has to serve something readable.
Rather than weaken the vault to reach it, `binders` is a separate, narrow,
plaintext table holding the same document that already travels in a share
link. The vault is untouched, and either feature runs without the other.

`erase_social()` reflects this: it drops your profile, binder, index entries,
inbox and friendships, and deliberately **leaves `vaults` alone**. Erasing your
social presence must not delete the encrypted backup of your cards.

## The tables

**`profiles`** — `user_id`, `handle`, `display_name`. Readable by any signed-in
user, because resolving `@rae` to a user id is what a directory is for. Carries
identity *only*; the contact blurb ("DM @rae on Discord") lives on the binder
row so it inherits the visibility rule instead of being published to every
stranger. `set_profile()` normalises, validates `^[a-z0-9_]{3,24}$`, and
refuses the `reserved_handles` list (`support`, `admin`, `cardstock`, …) so
nobody can impersonate the product inside a trade proposal.

**`handle_claims`** — every handle ever claimed, never deleted from. Since
0010 this, not `profiles`, is the uniqueness authority, and **a handle is
permanent**: `set_profile()` writes it once and refuses every later change with
`handle_locked`, so from then on it only ever updates `display_name` (or use
`set_display_name()`, which needs no handle at all). `authenticated` has lost
INSERT/UPDATE/DELETE on `profiles` — the RPCs are the only door — and a trigger
refuses a handle update even from the owner. Read decision 21 before touching
any of it; the short version is that `request_friend()` resolves a handle at the
moment it is called, so a handle that can come to mean a second person is an
impersonation primitive.

Two consequences that surprise people:

- **Erasing your social data does not free your handle.** `erase_social()`
  drops the profile row; the ledger keeps the claim, so nobody else can take
  the name and *you* get it back if you return.
- **A deleted account retires its handle forever.** The ledger's FK is
  `on delete set null`, so the row outlives the user with a null owner that
  nothing can match. That is deliberate — see decision 21 — and it is why
  `tests/harness/social-rls.mjs` sweeps its own throwaway handles rather than
  letting each run burn five names on the real project.

`handle_available()` answers `ok | mine | taken | reserved | bad` so the UI can
say "@rae is taken" while someone types. It consults the ledger, so an erased
handle reads as taken — which `lookupHandle` (a `profiles` read) would not
know. Current handles are already enumerable through the directory by design;
the only thing this adds is that a retired name reads as used.

**`friendships`** — one row per *pair*, `requester`/`addressee`/`status`
(`pending | accepted | blocked`). Directional columns because the UI needs
"waiting on them" vs "needs your answer"; friendship itself is undirected, so
`are_friends()` checks both column orders and there is no half-accepted state.
Only the addressee may accept — the requester flipping their own row would be
the whole consent gate, and it is explicitly tested that they cannot.
`request_friend(handle)` auto-accepts when the other person already asked, so
two people who both send a request end up friends rather than deadlocked.

**`binders`** — `payload` is the `ProfilePayload` wire shape verbatim, stored
whole rather than normalised: the client re-sanitizes it on arrival regardless
(decision 7), so a decomposed copy would add a second shape to validate without
removing the need to validate the first. `card_count`/`want_count` are
denormalised so a friends list renders without downloading everyone's cards.

**`trade_offers`** — `(user_id, want_key)` for cards actually offered. **No RLS
policy and no grant to `authenticated`, deliberately.** An index of who owns
what is the definition of a table that must not be enumerable — readable means
dumpable, and a dump of this is a shopping list for deciding who to rob. It is
reachable only through `match_wants()`, which answers ≤200 keys per call and
≤20 holders per key. That is a lookup oracle rather than a database: a large
improvement over publishing the table, and honestly not perfection.

**`inbox`** — trade proposals and replies, the direct port of the self-hosted
box's `POST/GET /v1/inbox/:id`. `sender` is stamped server-side from
`auth.uid()` and is what the app should trust when it disagrees with the
payload's client-authored `from` block. Recipient-only read (a sender cannot
confirm delivery, or probe whether an account exists); no INSERT policy at all,
so `send_to_inbox()` is the only door.

You may send to an accepted friend, or to anyone publishing a `trade` binder —
they advertised cards for swap, so being reachable about them is the point, and
it mirrors today's rule that anyone holding your link can propose a trade. A
user who publishes nothing and has no friends is unreachable, which is the
correct default. Capped at 20 undrained items per sender-recipient pair, so one
spammer can fill neither an inbox nor the table.

## The client (v0.15.0)

`lib/authsession.ts` owns sign-in — extracted from `cloud.ts` so one login
serves the vault and social both, and neither module owns the other's state.
`lib/socialcloud.ts` is the hosted-social transport.

| Function | What it does |
| -------- | ------------ |
| `claimHandle` | `set_profile`, then adopts the account as this device's identity (below). Claims once — never call it to *change* a handle |
| `checkHandle` | `handle_available`, asked while the user types, because a permanent choice must not be rejected after the tap |
| `updateDisplayName` | `set_display_name` — the one part of a hosted identity that stays editable |
| `hydrateIdentity` | pulls the handle onto a device that has never seen it. `socialHandle` is a localStorage cache, so without this a second device is indistinguishable from a new user |
| `publishBinder` | `buildProfilePayload()` unchanged → `publish_binder` RPC, with a payload-hash skip so an unchanged binder is not rewritten |
| `pullFriends` | revisions first, payloads only for what moved |
| `drainInbox` | `id > cursor`, sanitize, record, advance, delete |
| `matchWants` | `match_wants` over the local want keys |
| `sendToInbox` / `requestFriend` / `answerRequest` / `eraseSocial` | thin RPC wrappers |

### Two switches, not one

`socialConfigured()` (signed in + handle) and `socialPublishing()`
(+ `socialOn`) are deliberately different questions:

- **Claiming a handle publishes no cards.** It makes you findable and
  reachable — friends can add you, trades can arrive. That is the whole cost
  of joining.
- **Publishing your binder is the separate, privacy-bearing act**, and the
  audience banner in `SocialPanel` states which audience before you tap it.

Bundling them would mean joining costs you a decision about who can see your
collection, which is the one decision this design most wants to be deliberate.
The poller reflects it: friends and the inbox are pulled whenever you have a
handle, and only the outbound publish is gated on `socialOn`.

### First run and the three-day nudge (v0.16.0)

`components/Welcome.tsx` takes over the screen on a first launch and asks for
an account: sign in, then pick a handle (pre-filled from the email, so the
common case is one tap). `lib/onboarding.ts` owns the state machine;
`components/ConnectNudge.tsx` is the recurring reminder.

**It is presented as the way in, but it is not a hard lock**, and that is a
considered call rather than a softening. A true gate would mean no first launch
without a network, the whole app dark whenever Supabase or the mail provider
has a bad day, and the core promise — point a camera at a card, see what it is
worth, offline, with nothing signed in — broken for exactly the case it was
built for. The emailed code rides on a third-party mail provider with an hourly
cap; making that a prerequisite for opening the app puts every new user behind
someone else's uptime. `ALLOW_SKIP` in `Welcome.tsx` is the whole change if a
real lock is ever wanted — and `?welcome=0` has to go with it.

Two escapes exist: `?welcome=0` (the browser harnesses are first-time visitors
by definition) and `?demo=1` (asking a demo visitor for an account defeats the
flag). Neither is a security boundary — the screen is skippable anyway. The
welcome also never covers the `#/x?d=…` ingest route: a share link is how most
people meet this app, and answering someone's trade offer with a signup wall
loses both the trade and the user.

**The copy has to be true, and the obvious copy is not.** "Your data isn't
saved" is wrong — cards are in IndexedDB and survive a reload. Worse, *signing
in does not back anything up either*: the vault needs a passphrase, a second
deliberate act with no reset. So `nextConnectStep()` names what is actually
missing:

| Step | Missing | What doing it buys |
| ---- | ------- | ------------------ |
| `signin` | no account | an identity that survives losing the device |
| `handle` | account, no handle | being findable, and receiving trades |
| `backup` | neither vault nor Drive | cards that outlive the device |

The `backup` case is the one that most wants care: someone who signed in
*because we told them to* would otherwise be left believing their cards were
safe. Its copy says so in as many words.

The nudge returns every three days (`NUDGE_INTERVAL_MS`) and has **no permanent
dismissal, by request** — the escape is to finish the step, after which
`nextConnectStep()` returns null and it never renders again. It shares the
banner slot with `InstallPrompt` and yields to it: on iOS that warning is about
storage being deleted *this week*, which outranks anything here, and two
stacked banners is how both get ignored.

### One identity

`claimHandle`/`loadMyProfile` point `settings.profileId` at the Supabase user
id. `profileId` is what link shares travel under, so this makes a link-added
friend and a handle-added friend **the same person** rather than two rows for
one collector — and the identity now survives clearing storage, which the
minted `uid()` never did.

### `remoteRev`

`Friend.remoteRev` records the binder revision a snapshot came from, so the
25-second poll asks "did anything move?" in a few bytes per friend instead of
downloading every binder to find out. Absent for link-imported friends.

**The server's friend list drives `pullFriends`, not the local one.** A
friendship accepted on the *other* person's device exists only server-side
until something fetches it, so keying off `db.friends` alone means a newly
accepted friend never appears. An unknown id has no stored revision, reads as
stale, and is fetched — which is exactly how they arrive.

**Settings** gained `socialOn`, `socialHandle`, `socialCursor`, `socialAt`;
`syncUrl`/`syncOn`/`syncToken`/`syncCursor` were deleted outright rather than
deprecated, because the app had no users when this landed.

**Realtime is the obvious follow-up** and is deliberately not day one: polling
works, is simpler to reason about, and a subscription that silently dies is
worse than a poll that visibly lags.

**What does not change:** every payload still goes through `social.ts`'s
sanitizers, the wire marker stays `cardstock-social` (roadmap round 7 — a
rename breaks every link in the wild, in both directions), links and files stay
first-class, and analytics stay content-free — handles and card names are
never event props.

## What is verified, and how

`psql` as `postgres` bypasses RLS, so it can only prove objects exist. The
probe drives the real REST surface with genuine user JWTs: four signed-in users
and one anonymous caller, **43 assertions, run green locally and against the
live project**, including —

- a stranger reading a `trade` binder and **failing** to read an `all` binder;
- a pending request not unlocking anything, and the requester **failing** to
  accept their own request;
- an accepted friend then reading it, while a third party still cannot;
- `trade_offers` refusing a direct dump to a signed-in user;
- `match_wants` excluding the friends-only publisher, and eviction from the
  global index on an `all` → `trade` flip;
- inbox sender stamped server-side, sender unable to read it back, direct
  INSERT refused, unreachable recipients refused, the 20-item cap holding;
- `erase_social()` clearing social while **the vault survives**;
- control tests, so a refusal is provably a refusal and not a missing object.

Throwaway users were deleted afterwards; every social table is back to zero
rows on the live project.

## The self-hosted server, removed (v0.15.0)

`server/sync-server.mjs`, `lib/sync.ts`, `components/SyncPanel.tsx` and
`npm run sync` are **deleted**, not deprecated — the app had no users when this
landed, so carrying a compatibility path would have been carrying it for
nobody. What it cost, stated plainly rather than discovered later:

- **A LAN playgroup with no accounts loses its live path.** That was a real
  property — no sign-up, no internet, everyone on one wi-fi. Hosted social
  needs an account and a connection. Links still work with no account at all,
  so the floor is unchanged, but the no-account *live* tier is gone.
- **Trust-on-first-use went with it.** The device token that proved you owned
  a profile id is replaced by a JWT, which is the entire reason identity is now
  recoverable.
- **The route shape ported as predicted.** `binders` (whole-document write) and
  `inbox` (append + cursor drain) became tables with policies almost
  one-for-one — the claim in the old version of this document, and roadmap
  finding 2, both held.

---

## The cloud vault (v0.14.0)

Distinct from everything above. Serverless sharing and the self-hosted
`server/` box are about handing *other people* a snapshot; the vault is about
one person keeping their own collection across their own devices — which
decision 14 established is otherwise impossible on iOS, where a Home Screen
web app cannot see the Safari tab's IndexedDB.

**Shape.** Supabase holds one row per user (`supabase/migrations/0000_vaults.sql`). The row is
ciphertext: `crypto.ts` derives an AES-GCM key from a passphrase with
PBKDF2-SHA256 at 600k iterations and encrypts the same `Backup` object the
export button writes. Sign-in decides *which row you may touch*; the
passphrase decides *whether it means anything*. Keeping them separate is the
entire point — if the key could be derived from the login, whoever runs the
project could read every collection.

**Sign-in.** Emailed six-digit codes and Google, in that order of prominence.
The code path involves no redirect, so it behaves identically in Safari and in
a Home Screen app; Google uses a top-level navigation and never a popup,
because `window.open` from a standalone iOS app opens Safari and lands the
session in a different storage container than the app. GoTrue returns OAuth
tokens in the URL *fragment* and this app routes on the fragment, so
`adoptOAuthRedirect()` runs in `boot()` before the router — get that order
wrong and every Google sign-in lands on a garbage route.

**Sync is pull-merge-push**, never push-if-newer: the reason two devices
disagree is that each holds cards the other lacks. `put_vault()` rejects a
write whose base revision is stale and returns the current one, and `cloud.ts`
answers by going round again rather than clobbering.

**Merging** is pure and lives in `cloudmerge.ts` — union by primary key,
per-row recency, and quantities are never summed (two devices each holding
qty 3 describe the same three cards). Two things to know before touching it:
`history` has no `id` at all, its Dexie key is the compound `[cardId+date]`;
and positions are tracked in a `Map` because the first cut used `findIndex`
inside the remote loop and went quadratic on large collections.

**Known gap — deletions.** A union cannot distinguish "deleted here" from
"never existed here", so removing a card on one device can be undone by
another that has not synced yet. Tombstones are the real fix and are a schema
change. The bias is deliberate: an unwanted card takes seconds to remove
again, an evening of scanning does not.

**What the sanitizers still do.** Decrypting proves the passphrase, not the
shape, so a decoded vault goes through `sanitizeBackup()` exactly like a
pasted link (decision 7).

**What is verified, and how.** The transport now runs against the live project.
`npm run test:cloud` (`tests/harness/cloud-live.mjs`) drives the real
`cloud.ts` with only `./db` and `./settings` stubbed, creating and deleting its
own throwaway users, and covers: first push, ciphertext-at-rest, a second
device adopting the vault, a wrong passphrase refused before download, the
union merge, the `put_vault` stale-base rejection, the pull-merge-retry under
genuine concurrency, and RLS isolation both signed-in and anonymous. It needs
`SUPABASE_SECRET` and is therefore not in CI. The two-device case was also
walked by hand in two browser origins against real IndexedDB: 11 cards pushed,
adopted by an empty second device, then a card added on each — both survived,
no quantity doubled, no duplicate rows.

**The grant trap, which cost the whole feature.** `create table` in a Supabase
project no longer grants DML to `anon`/`authenticated`. Projects made before
roughly 2026 inherited `grant all on tables` from `ALTER DEFAULT PRIVILEGES`;
newer ones land with only REFERENCES/TRIGGER/TRUNCATE. RLS was enabled and the
policy was correct, and every single request still failed — PostgREST answers
`42501 permission denied for table vaults` *before* it consults a policy, so
the failure looks like a broken table rather than a missing grant. The grants
are now written out explicitly in every migration. Do not delete them on
the grounds that Supabase "does that automatically"; it does not.

**Emailed codes need custom SMTP, and that is not a preference.** On Supabase's
own email provider the six-digit code cannot work at all: template edits are
refused on the free tier, and the stock template emits only
`{{ .ConfirmationURL }}` — so no code is ever in the message no matter what the
client asks for. That sender is also capped at 2 emails per hour, which is
unusable regardless. The failure is worth recognising because it does not look
like this: the app reports something that reads like a rejected address.

The project now sends through **Resend on `corrupt.solutions`** — SMTP
`smtp.resend.com:465`, user `resend`, from `Cardstock
<cardstock@corrupt.solutions>`; the password is a Resend API key kept at
`~/.secrets/cardstash/resend` and never in the repo. That unlocked the
templates, so both the confirmation and magic-link bodies now carry
`{{ .Token }}`, and `mailer_otp_length` is 6 to match the UI's "six-digit"
copy. The per-hour send cap was raised from 2 to 100 at the same time; 2 was
low enough that a single user retrying would have locked themselves out.

Verified with a real emailed code, not a synthesised one: the app sent from
the sign-in screen, Resend reported it delivered, and typing the six digits it
contained produced a session with both tokens. A rejected code toasts "Token
has expired or is invalid" and leaves the user on the code screen to retry.

If sign-in ever starts failing with what looks like an address error, check the
sender before touching `cloud.ts`.

**Google needs its redirect URI registered**, and it now is:
`https://<project>.supabase.co/auth/v1/callback`. Supabase's provider shares the
OAuth client with Drive backup, and that client deliberately carried no redirect
URIs (the GIS token flow uses postMessage), so every Google sign-in used to die
at Google with `redirect_uri_mismatch` — on every platform, not just iOS.
Adding that URI does **not** disturb the Drive token flow, which never uses one;
the "no redirect URIs, deliberately" note attached to the Drive client is about
diagnosing Drive, and is not a reason to leave this off. Redirect URLs on the
Supabase side must also match the deploy path exactly, capitals included —
`/CardStash/`, not `/cardstash/`, which 404s.

**Google is not offered in an iOS Home Screen app at all.** `GOOGLE_IS_A_TRAP`
in `CloudSync.tsx` hides it when `IS_IOS && IS_STANDALONE`: the OAuth round
trip has a long history of surfacing in Safari rather than returning to the
app, and a session that lands in Safari lands in the storage container this
feature exists to escape. Better absent than present and quietly broken.

**An OAuth session has no identity in it.** GoTrue returns tokens in the
fragment and nothing else, so a Google sign-in produces a valid session whose
email is empty. `signedInAs()` therefore is not the signed-in test —
`isSignedIn()` is — and `adoptOAuthRedirect()` fills the email in with one
call to `/auth/v1/user`. Gating the UI on the email alone stranded the user on
the sign-in screen while holding a working session.

**Why the Drive backup stays.** It overlaps the vault and is deliberately kept
(decision 14). They answer different questions: Drive is an automatic daily
*snapshot* into storage the user already owns, with no passphrase and so no way
to lock yourself out; the vault is deliberate two-way *sync* whose passphrase
has no reset by design. Retiring Drive would make an unrecoverable passphrase
the only route back to a lost collection, and would put a per-user cloud cost
on free users the tiering explicitly keeps free.

---

## Messages (v0.19.0)

Two collectors talking about a card: `supabase/migrations/0017`,
`lib/messaging.ts`, `views/MessagesView.tsx`. Read decision 24 before touching
any of it.

**It is not the trade inbox, and it must not become it.** `inbox` (0004) is
recipient-read-only, sender-stamped, drained-and-deleted, 30-day TTL, capped at
20 undrained per pair. Every one of those is right for handing someone a trade
payload and wrong for a conversation — a sender who cannot read the thread back
cannot see what they said. This document said the inbox was not the channel for
this. It still is not.

| | `inbox` | `messages` |
| --- | --- | --- |
| Read by | recipient only | both participants |
| Lifetime | deleted on drain, 30-day TTL | kept, 365-day prune |
| Carries | a whole `TradePayload` | text, plus one optional `SharedCard` |
| Cap | 20 undrained per pair | 15 unanswered per pair, 120/hour globally |

**Who may open one** is the `send_to_inbox()` rule plus one clause: accepted
friends, anyone publishing a `scope='trade'` binder, **or anyone who has already
spoken to you**. That last one is not politeness — without it, answering someone
who unpublished between their message and your reply fails, and the person who
started the conversation is the one who gets ignored. Publish nothing and accept
nobody and you are unreachable, which stays the correct default.

**Routed by the person, not the thread.** `#/messages/<their account id>` opens
the conversation whether or not one exists yet, so "message this collector" is
the same link from a binder, a card sheet and a want match, and there is no
separate new-thread state to fall out of step. The thread id is a server detail.

**Nothing is stored locally.** No Dexie table, for `marketplace.ts`'s reason and
one more: Dexie rows ride `exportBackup`, the CSV export and the daily Drive
backup, and a private conversation with somebody else does not belong in a file
the user hands around. Threads are fetched; the screens say so when they cannot.

**Plaintext, and the copy says so.** `binders` is plaintext because a friend's
app has to read it; this is plaintext for exactly the same reason, and the
vault's encryption (15b — a key we hold) does not extend here. What it is
instead is *bounded*: text and one card reference. No attachments, no images,
no addresses — there is nowhere to put one.

**Blocking is one-sided and silent.** `set_thread_block` sets my side only. The
thread leaves my list; their messages are still accepted and stored; they are
never told. That mirrors `request_friend()` returning `pending` to someone who
has been blocked, and for the same reason: being told is an instruction to make
a second account. Messaging them again lifts my own block and never touches
theirs.

**Nothing may write these tables directly.** No INSERT/UPDATE/DELETE policy and
no grant beyond `select` — the denormalized preview, the read watermarks and the
block flags are all things a client could otherwise forge about the *other*
person's row. `send_message` / `mark_thread_read` / `set_thread_block` /
`list_threads` are the only doors.

**`erase_social()` takes conversations with it** — 0017 replaces 0004's version
rather than adding a second RPC, because a "delete everything" button that
needs two calls is one forgotten call away from being a lie. It still leaves
`vaults` alone, and still leaves `orders` alone.

Two client rules worth keeping: the unread badge is a **cache** (`messageUnread`
in settings) so it is right on the first frame after a cold launch, corrected by
every poll and cleared on sign-out; and the `about` block goes through
`sanitizeSharedCard` — the same door a `#/x?d=…` link uses — so a message cannot
smuggle in a card shape a share link could not.

Verification is `npm run test:messages` (`tests/harness/messages-rls.mjs`), the
sibling of `test:social`: five signed-in users and one anonymous caller over
reachability, third-party reads, forged writes, the caps, the block, erasure and
the same control tests, so a refusal is provably a refusal. Run it after any
migration touching `messages` or `message_threads`.

---

## Paid trades (v0.18.0, in progress)

Everything above is barter: cards for cards, no money anywhere in the model.
Buying a card from a friend is a **separate subsystem**, not a widened trade —
`TradeRecord` has no price, no currency and no shipping state, and
`sanitizeTradeRecord` and `applyTradeToCollection` both assume an even swap.
Orders live in `orders` on the hosted project, never in a payload and never in a
share link. See [decisions.md](decisions.md) §19 for why Stripe and why the
money is never ours to hold.

Three things that interact with what this document already describes:

- **Scope does not govern orders.** The visibility rule (`trade` readable by any
  signed-in user, `all` by accepted friends) decides who can read a *binder*. An
  order is readable by exactly two people, its buyer and its seller, regardless
  of any scope. Publishing nothing at all does not stop someone selling to a
  friend, and publishing to everyone does not let a stranger buy.
- **`forTrade` is not "for sale."** It sets the shared quantity under
  `scope: 'trade'` and populates `trade_offers`, the global want index. Reusing
  it as a listing count would make every listing a barter offer *and* globally
  enumerable through `match_wants()`. A sale carries its own count and price.
- **`erase_social()` does not touch `orders`.** Erasing your social presence
  removes your profile, binder, offers, inbox and friendships; it leaves the
  vault alone (as documented above) and now leaves completed sales alone too.
  A sale backs a 1099-K and a chargeback response. `buyer`/`seller` are
  `on delete set null`, so a closed account leaves a row with no name, no handle
  and no address — and RLS hides it from everyone, because a null never equals
  an `auth.uid()`.

**The inbox is not the channel for this.** It is recipient-read-only,
sender-stamped, 30-day TTL, capped at 20 undrained per pair — built for handing
someone a trade payload, not for a shipping conversation. An order deliberately
carries no free-text field either: the moment one exists it is an unmoderated
message channel between two people who are, by construction, in a dispute.
`messages` (above) does not change that: it is a channel between two people
*before* anyone has agreed anything, it is not attached to an order, and an
order still has no free-text field.

**Verification** is `npm run test:escrow` (`tests/harness/escrow-rls.mjs`), the
sibling of `test:social` — 45 assertions over buyer, seller, stranger and anon,
ending in the same control tests so a refusal is provably a refusal.

---

## Referrals and the founding offer (v0.18.0)

The first 100 people who arrive through a friend's link may buy lifetime access
once, for a one-off fee; everyone else buys the yearly subscription. The rules
all live in `supabase/migrations/0014` — `claim_referral()`, `founding_seats_left()`,
`reserve_founding_seat()`, `claim_founding_seat()` — and `stripe-billing` reserves
a seat and offers the one-off price on its own. `src/lib/referral.ts` is the whole
client half, and it decides nothing.

**Capture, then redeem — because sign-in destroys the URL.** A referral arrives
on a device with no account, and `claim_referral()` needs an `auth.uid()`.
Between the two sits sign-in, and `startGoogleSignIn()` returns the browser to
`origin + pathname`: query string and fragment both gone, with
`adoptOAuthRedirect()` rewriting whatever survives before the router reads it. So
`captureReferral()` runs as the first statement of `boot()` in `main.tsx`, ahead
of everything that touches the URL, and `redeemReferral()` runs later — after
sign-in and after a handle claim (`Welcome.tsx`, `SocialPanel.tsx`), plus once at
boot for someone who was already signed in when they opened the link. Anything
that read the URL at the moment of claiming would work for an emailed code and
silently never fire for Google.

**The first link wins.** `settings.referralFrom` is written once and never
overwritten: `claim_referral()` records one referrer per account for ever, so a
later link would leave the app crediting someone the database does not.
`referralAt` records that the server gave a *final* answer — recorded or refused,
both final — which is what stops the RPC being re-sent on every launch; it is
cleared on sign-out, because the next account on the device has its own referral.

**Eligibility is read from the server, never from settings.** `foundingOffer()`
asks `referrals` (read-own under RLS) and then `founding_seats_left()`, which are
the same two facts `reserve_founding_seat()` checks at checkout. An account
referred on another phone still sees the offer; a hand-edited settings key buys
nothing but different words on a screen. Failures return `null` — offline is not
"you were never referred", and withdrawing a real offer is the worse mistake.

**Nothing about a referral is tracked.** A handle is identity; `redact()` drops
the key already, and hashing one into an event instead would be the same leak
wearing a hat.

Verification is `tests/unit/referral.test.mjs`, which pins the two easiest things
to break: a sharer without a handle gets a byte-identical link, and a payload and
a referral in one URL never eat each other.
