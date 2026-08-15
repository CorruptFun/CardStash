-- The sweep 0010 said was separate: take back the default privileges Supabase
-- hands every new table in `public`.
--
-- WHAT IS WRONG. A fresh table in this project lands with REFERENCES, TRIGGER
-- and TRUNCATE already granted to `anon` and `authenticated`, from ALTER
-- DEFAULT PRIVILEGES on the schema. 0000's header records the other half of
-- that behaviour -- no DML arrives with it, which is the loud failure -- but
-- these three arrive silently and nothing since has taken them back. A
-- targeted `revoke insert, update, delete` does not touch them, because they
-- are not in the list: that is why 0008's revoke on `build_usage` left the
-- table holding TRUNCATE, and why 0010's `revoke insert, update, delete,
-- truncate` on `profiles` removed TRUNCATE but left REFERENCES and TRIGGER
-- standing, and never covered `anon` at all.
--
-- HOW BAD IT IS: not very, and the accurate word is hygiene. Two independent
-- reasons this is latent rather than live, both verified against the project
-- before this migration was written:
--   1. PostgREST only ever issues SELECT/INSERT/UPDATE/DELETE and RPC calls.
--      It has no way to express TRUNCATE, so no HTTP request reaches it.
--   2. Neither role has CREATE on schema `public`
--      (`has_schema_privilege('authenticated','public','CREATE')` is false),
--      and REFERENCES and TRIGGER are only usable from something you create --
--      a foreign key on your own table, a trigger with your own function.
--      There is nowhere to put either one.
-- Nobody could have used these. Do not write this up as a vulnerability that
-- was closed; it is a set of grants that should never have been there.
--
-- WHY BOTHER, THEN. Because two migrations state flatly that a table is
-- unreachable, and the statement is what the next person will trust instead of
-- re-deriving it. 0001 on `reserved_handles`: "No policy and no grant: nothing
-- but a definer function may read this." 0003 on `trade_offers`: "NO policy and
-- NO grant to authenticated, deliberately" -- guarding a table whose own
-- comment calls a dump of it "a shopping list for anyone deciding who to rob."
-- Both tables were carrying a grant that could empty them. A comment that is
-- nearly true is worse than no comment, because it stops the next audit early.
--
-- THE PATTERN THAT DOES NOT ROT is `revoke all` and then grant back exactly
-- what is wanted, which is what 0007 (`analytics_events`), 0009 (`vault_keys`)
-- and 0010 (`handle_claims`) already do -- those three are clean, hold nothing
-- for `anon` or `authenticated`, and are deliberately absent below. A revoke
-- that names privileges can only ever take back the ones someone thought of.
-- New tables should follow those three.
--
-- WHAT THIS DOES NOT DO: change the default privileges themselves, so the next
-- `create table` in `public` inherits this again. ALTER DEFAULT PRIVILEGES is
-- per-granting-role, and tables here arrive from more than one path (migrations
-- through the Management API, anything created in the dashboard), so a single
-- ALTER would silently cover some and miss others -- a fix that looks total and
-- is not, which is the failure mode this migration exists to correct. The
-- durable version is the `revoke all` convention above, applied per table.
--
-- NO ORDERING CONSTRAINT, and no two-phase concern: nothing removed here is
-- reachable over HTTP, so no cached PWA client can be relying on it. This is
-- the rare migration that is safe to apply at any time.

/* ------------------------------------------------- the sweep, table by table */

-- Each line takes back only the three default privileges and names nothing
-- else, so the DML sitting beside it survives untouched. This is deliberately
-- NOT `revoke all` + re-grant: `binders`, `friendships`, `vaults` and `inbox`
-- carry live DML that the app depends on, and re-granting it from memory is a
-- chance to get it wrong for no benefit. The kept grants are noted per line,
-- checked against each table's own migration.

-- 0000. Full DML: the client reads and PATCHes its own ciphertext row.
revoke truncate, references, trigger on public.vaults
  from public, anon, authenticated;

-- 0001, tightened by 0010 to SELECT only -- the RPCs are the only writer.
-- 0010 already took TRUNCATE from `authenticated`; this covers what its
-- privilege list missed, and `anon`, which it did not mention.
revoke truncate, references, trigger on public.profiles
  from public, anon, authenticated;

-- 0001. Nothing at all: read only by the definer functions that check a handle.
revoke truncate, references, trigger on public.reserved_handles
  from public, anon, authenticated;

-- 0002. Full DML: the friendship edge is written by both sides under RLS.
revoke truncate, references, trigger on public.friendships
  from public, anon, authenticated;

-- 0003. Full DML: your own binder row, plus the three scope-driven read
-- policies that let a friend -- or any signed-in user, for `trade` -- see it.
revoke truncate, references, trigger on public.binders
  from public, anon, authenticated;

-- 0003. Nothing at all: the want index is reachable only through
-- match_wants(), one key at a time. This is the table the whole sweep is for.
revoke truncate, references, trigger on public.trade_offers
  from public, anon, authenticated;

-- 0004. SELECT and DELETE: you read your own inbox and clear it; only
-- send_to_inbox() writes, so INSERT was never granted.
revoke truncate, references, trigger on public.inbox
  from public, anon, authenticated;

-- 0005. SELECT only for the owner; service_role does the writing.
revoke truncate, references, trigger on public.entitlements
  from public, anon, authenticated;
revoke truncate, references, trigger on public.scan_usage
  from public, anon, authenticated;

-- 0006. SELECT only. `seller_accounts.stripe_account_id` is where money goes:
-- nothing but the webhook may write it, which is why service_role holds the
-- DML alone. Money transitions on `orders` are service_role for the same
-- reason -- see decision 19.
revoke truncate, references, trigger on public.seller_accounts
  from public, anon, authenticated;
revoke truncate, references, trigger on public.orders
  from public, anon, authenticated;

-- 0008. No grant to either role -- consume_build_credit() is definer and
-- service_role-only. NOTE, unchanged here: `build_usage_read_own` is a SELECT
-- policy on a table with no SELECT grant, so it is inert and a signed-in read
-- would get 42501 before RLS is consulted (0000's header describes exactly
-- this trap). Nothing in `src/` reads the table, so it is latent. Widening a
-- grant does not belong in a migration whose job is to narrow them -- if the
-- remaining-builds count is ever shown in the UI, add the SELECT grant then.
revoke truncate, references, trigger on public.build_usage
  from public, anon, authenticated;

-- Rollback -- restores the default-privilege state this migration removes.
-- There is no reason to want this; it is here so the undo is not reconstructed
-- from scratch under pressure:
--   grant truncate, references, trigger on public.vaults, public.profiles,
--     public.reserved_handles, public.friendships, public.binders,
--     public.trade_offers, public.inbox, public.entitlements,
--     public.scan_usage, public.seller_accounts, public.orders,
--     public.build_usage to anon, authenticated;
