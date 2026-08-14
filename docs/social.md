# Friends, trades and sync

## The stance: serverless by default

Everything social works with **no server at all**, and that path must keep
working. A share *is* the data: a profile snapshot compressed into a URL
fragment, or the same JSON as a file. Nothing is published anywhere unless the
user sends it to someone.

Live sync (`lib/sync.ts` + `server/`) is an **opt-in overlay** on top of that,
not a replacement. With `syncOn` false, nothing in `sync.ts` runs. Never make
links or files a second-class citizen, and never route them through a server.

Everything decoded from a link, a file, a backup or a server response is
**untrusted** and goes through the sanitizers in `social.ts`. There is one
validation implementation, and this is it.

## Identity

`ensureProfileId()` mints a `uid()` on first share and keeps it forever.
`myProfile()` returns `{ id, name, note, scope }` from settings. There are no
accounts and no recovery: clearing browser storage loses the id (and, with live
sync, the ability to republish under it).

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

# Live sync (optional)

## Client (`lib/sync.ts`)

Off unless `syncOn` **and** `syncUrl` are set. `checkSyncServer(url)` verifies
`GET /v1/health` returns `app: 'cardstock-sync'` before the address sticks.

The loop (`startSyncLoop`) polls every 20 s, only while the document is visible,
plus once on becoming visible and 2 s after boot. Each `syncNow()`:

1. **publish** — `buildProfilePayload` from the live collection + wants, hashed
   minus its timestamp; skipped when nothing changed since the last publish;
2. **pull friends** — re-read every followed binder, apply only when their
   `at` is newer than the stored `exportedAt`; a friend who hasn't published
   there yet is normal, not an error;
3. **drain inbox** — `GET /v1/inbox/:id?since=<cursor>`; trades become records,
   replies update existing ones; junk items are skipped, never fatal; the
   cursor advances to the newest item seen.

`deviceToken()` mints and stores a `syncToken` on first use — it is what proves
this device owns its profile id. `resetSyncState()` clears the publish hash and
cursor when switching servers or identities.

**Every response is re-sanitized.** A hostile or buggy server can only ever hand
the app a well-formed profile/trade/reply.

## Server (`server/sync-server.mjs`)

Zero dependencies, plain `node`, state in a single JSON file at
`server/data/state.json` (gitignored; delete to reset). Run with `npm run sync`
(`-- --port 9000` to change the port); it prints the localhost and LAN addresses
to hand out.

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET | `/v1/health` | — | Identify the server (`app`, `v`, binder count). |
| GET | `/v1/directory` | — | Who has published a binder here (id, name, updatedAt, card/want counts). |
| PUT | `/v1/binders/:id` | owner token | Publish my binder. Payload must be a `profile` whose `id` matches the path. |
| GET | `/v1/binders/:id` | — | Read a published binder. |
| POST | `/v1/inbox/:id` | — | Drop a trade proposal or reply for someone. |
| GET | `/v1/inbox/:id?since=` | owner token | Drain my inbox. |

**Ownership is trust-on-first-use.** The first device to `PUT` a profile id
claims it with a SHA-256 hash of its device token; only that token can publish
again or read that inbox. Anyone who knows an id can *send* a trade to it —
exactly as anyone can send you a link. An unclaimed id's inbox is readable by
whoever asks, because nothing has been published under it yet and there is no
owner to protect.

Limits: 4 MB bodies, 500 profiles, 200 inbox items per id, 30-day inbox TTL,
debounced atomic writes (temp file + rename). Profile ids must match
`[A-Za-z0-9_-]{6,64}`. CORS is wide open (`*`) by design — it is a LAN tool.

### Deliberate scope

This is a LAN/dev convenience server, not a hosted service:

- **No transport security.** Plain HTTP, tokens in headers. Fine on your own
  network; don't port-forward it.
- **No accounts or recovery.** Losing the device token means losing the ability
  to republish under that profile id.
- **It trusts the network it's on.** Anyone who can reach the port can read
  published binders and the directory.

The route/table shape (`binders`, `inbox`) deliberately matches the eventual
hosted backend, so moving to Postgres/Supabase with real auth is a storage swap
rather than a client rewrite.


---

## The cloud vault (v0.14.0)

Distinct from everything above. Serverless sharing and the self-hosted
`server/` box are about handing *other people* a snapshot; the vault is about
one person keeping their own collection across their own devices — which
decision 14 established is otherwise impossible on iOS, where a Home Screen
web app cannot see the Safari tab's IndexedDB.

**Shape.** Supabase holds one row per user (`supabase/schema.sql`). The row is
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
are now written out explicitly in `supabase/schema.sql`. Do not delete them on
the grounds that Supabase "does that automatically"; it does not.

**Emailed codes need custom SMTP, and that is not a preference.** On Supabase's
own email provider the six-digit code cannot work at all: template edits are
refused on the free tier, and the stock template emits only
`{{ .ConfirmationURL }}` — so no code is ever in the message no matter what the
client asks for. That sender is also capped at 2 emails per hour, which is
unusable regardless. The failure is worth recognising because it does not look
like this: the app reports something that reads like a rejected address.

The project now sends through **Resend on `corrupt.solutions`** (SMTP
`smtp.resend.com:465`, user `resend`, password is a Resend API key — kept at
`~/.secrets/cardstash/resend`, never in the repo). That unlocked the templates,
so both the confirmation and magic-link bodies now carry `{{ .Token }}`, and
`mailer_otp_length` is 6 to match the UI's "six-digit" copy. Verified
end to end: `/auth/v1/otp` → Resend → delivered.

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
