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
| `profile` | `buildProfilePayload(items, me, wants)` | `id`, `name`, `note`, `scope`, `at`, `cards: SharedCard[]`, `wants?: SharedWant[]` |
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

## Wire format

```
link:  <origin><path>#/x?d=<blob>
blob:  'D' + base64url(deflate-raw(JSON))     ← normal
       'J' + base64url(JSON)                   ← fallback where CompressionStream is missing
file:  pretty-printed JSON, the same envelope
```

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
(`0001`–`0004`); applied and verified against the live project 2026-08-14.

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

## Client plan (not yet built)

`lib/socialcloud.ts`, dynamically imported exactly like `cloud.ts`, reusing its
session handling — one login serves the vault and social both.

1. **Session** — reuse `cloud.ts`'s `loadSession`/`freshToken`. Do not mint a
   second auth path.
2. **`publishBinder()`** — `buildProfilePayload()` unchanged, then derive the
   offers array with `wantKeyFor()` and call the `publish_binder` RPC. Keep
   `sync.ts`'s payload-hash skip; it is a good idea that survives the rewrite.
3. **`pullFriends()`** — select `binders` for followed user ids, compare
   `revision`, and feed changed rows through `sanitizePayload()` →
   `upsertFriendFromProfile()`. Unchanged from `sync.ts` apart from the
   transport.
4. **`drainInbox()`** — select `inbox` where `id > cursor` ordered by `id`,
   sanitize each, `recordIncomingTrade` / `applyTradeReply`, advance the
   cursor, then delete the drained rows.
5. **`matchWants()`** — call `match_wants` with the local want keys; render
   holders on the wants list.
6. **Realtime is the obvious follow-up** and is deliberately not day one:
   polling works, is simpler to reason about, and a subscription that silently
   dies is worse than a poll that visibly lags.

**Settings** gains `socialOn`, `socialHandle`, `socialCursor`, `socialAt`. The
`syncUrl`/`syncOn`/`syncToken`/`syncCursor` keys are retired — leave them in
the `merge()` sanitizer long enough to ignore stored values rather than
crashing on them.

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

## Retiring the self-hosted server

`server/sync-server.mjs` and `lib/sync.ts` are superseded. What that costs,
stated plainly rather than discovered later:

- **A LAN playgroup with no accounts loses its live path.** That was a real
  property — no sign-up, no internet, everyone on one wi-fi. Hosted social
  needs an account and a connection. Links still work offline-ish (they are
  just text), so the floor is unchanged, but the no-account *live* tier is
  gone.
- **`npm run sync`, `checkSyncServer`, the directory and `followFromServer`
  disappear**, along with the trust-on-first-use device token. Nothing
  migrates: a self-hosted binder is republished by signing in and publishing.
- **The route shape ported as predicted.** `binders` (whole-document write) and
  `inbox` (append + cursor drain) became tables with policies almost
  one-for-one — the claim in the old version of this document, and roadmap
  finding 2, both held.

Until `socialcloud.ts` lands, `sync.ts` still works and should be left alone;
removing it before its replacement exists would take the live tier away with
nothing in its place.

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
