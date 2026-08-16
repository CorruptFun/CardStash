# Pending migrations — apply from a machine with project access

> **Status: two migrations are written, deployed against, and NOT APPLIED.**
> Raised 2026-08-16. Delete this file the moment they are pushed and verified.

`0019_messaging.sql` and `0020_custom_binders.sql` shipped to `main` (and
therefore to `gh-pages`) ahead of the schema they need, because the session
that wrote them had no Supabase credentials. Everything is written, reviewed
and tested locally; nothing has touched the live project.

## Run this

```sh
supabase db push          # applies 0019 and 0020
SUPABASE_SECRET=sb_secret_… npm run test:messages
SUPABASE_SECRET=sb_secret_… npm run test:social
```

Both harnesses create and delete their own throwaway users, so a green run
leaves the project as it found it. Run them **in that order and both of them** —
`test:social` is the one that covers `0020`'s changes to the want index.

If the CLI answers `does not have the necessary privileges` on every
project-scoped call, that is the signed-in-as-the-wrong-account trap from
CLAUDE.md, not a scope problem: compare `GET /v1/profile` against
`GET /v1/projects` and check the project is even visible. `sb doctor` reporting
"linked" proves nothing — it reads a local file, not the API.

## Why this one deserves the harness rather than a schema read

`0020` is the highest-risk migration in the set. It does not merely add a
table: it **alters `trade_offers`' primary key** (to `(user_id, source,
want_key)`) and replaces six live functions —

| Replaced | Why |
| -------- | --- |
| `replace_trade_offers` | gains a `source` argument; the 1-arg version is **dropped**, because a defaulted parameter would make the old call ambiguous and fail at runtime |
| `publish_binder` | re-pointed at the 2-arg replacer, naming its source `''` |
| `unpublish_binder` | narrowed to `source = ''` so taking the collection binder down no longer empties published custom binders |
| `match_wants` | a per-source liveness check, so an offer is only surfaced while its publisher is still discoverable |
| `send_to_inbox` / `can_message` | reachability now also counts a public tradeable binder |
| `erase_social` | takes custom binders with it (0019 had already added conversations) |

None of that is visible in a schema read. `psql` as `postgres` bypasses RLS, so
it can only prove objects exist — the harnesses drive the real REST surface
with genuine user JWTs, which is the only thing that shows a refusal is a
refusal.

## What is broken until then

Nothing that was working before. Every new server call is individually caught:

- `publishCustomBinders` and `pullFriendBinders` are wrapped in `.catch()` inside the poller;
- `refreshUnread()` falls back to the cached badge count;
- the main binder still publishes through the **old** `publish_binder`, untouched.

What a signed-in user with a handle actually sees:

- **Messages** — the row on the Friends screen leads to "Could not load your
  messages". Sending fails with "The server refused that".
- **Binder publishing** — setting a binder to Friends or Public saves locally
  and silently does not upload. The copy promises it "goes up automatically",
  which is currently untrue for anyone with a handle.
- **Everything else is fine**, including the whole local half: building
  binders, filling them, and sharing any of them by link needs no server at
  all.

If these need to sit unapplied for longer than a few days, hide the two entry
points rather than leave the copy lying — the Messages row in `FriendsView` and
the visibility control in `BindersView`.

## Order note

`main` already carries `0017_referral_friendship` from a parallel round, which
also went out unapplied (`befriend_referrer()` 404s until pushed — see that
commit). It does not collide with these: it only adds two functions and touches
nothing 0019/0020 replace. `supabase db push` will apply all three.

## Rollback

Each migration carries its own rollback block in its header comment. Note that
reverting `0020` means re-applying `0003`'s `replace_trade_offers`,
`publish_binder`, `unpublish_binder` and `match_wants`, `0004`'s
`send_to_inbox`, and `0019`'s `can_message` and `erase_social` — the SQL says
so at the top of the file.
