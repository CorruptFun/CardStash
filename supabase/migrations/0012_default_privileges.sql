-- Finish what 0011 started: `revoke all` rather than a list, and stop the
-- defaults coming back on the next `create table`.
--
-- 0011 REVOKED A LIST AND THE LIST WAS INCOMPLETE. It named `truncate,
-- references, trigger`, and its own header said the pattern that does not rot
-- is `revoke all` + grant back, "because a revoke that names privileges can
-- only ever take back the ones someone thought of." It then did the thing it
-- warned about. This database is PostgreSQL 17, which added a fifth default
-- privilege -- MAINTAIN (VACUUM/ANALYZE/CLUSTER/REINDEX/REFRESH MATVIEW) --
-- and MAINTAIN was not in the list, so every table kept it for `anon` and
-- `authenticated`.
--
-- IT VERIFIED CLEAN ANYWAY, which is the part worth remembering.
-- `information_schema.role_table_grants` is defined by the SQL standard and
-- MAINTAIN is not in the standard, so the audit query -- the one in the task,
-- the one in 0011 -- CANNOT SEE IT. The after-check came back empty while
-- `reserved_handles` and `trade_offers` still read `anon=m/postgres,
-- authenticated=m/postgres`. Audit `pg_class.relacl` (or `aclexplode`) when
-- the question is "does this table grant anything at all"; information_schema
-- answers a narrower question than it appears to.
--
-- The three tables that used `revoke all` -- `analytics_events` (0007),
-- `vault_keys` (0009), `handle_claims` (0010) -- have no `anon`/`authenticated`
-- entry in their ACL at all. They shed MAINTAIN without anyone knowing it
-- existed. That is the entire argument for the form, demonstrated.
--
-- SO: every table gets `revoke all`, then exactly the grants its own migration
-- intended, restated here so one file holds the whole answer. Verified against
-- the live ACLs before this was written; `service_role` is deliberately
-- untouched, since it bypasses RLS and holds these by design.
--
-- STILL LATENT, STILL NOT A BREACH. MAINTAIN is no more reachable over HTTP
-- than TRUNCATE was: PostgREST issues SELECT/INSERT/UPDATE/DELETE and RPC,
-- and nothing else. This remains hygiene, and the reason to care remains that
-- `reserved_handles` and `trade_offers` are documented as granting nothing.

/* ------------------------------------------------------ every table, exactly */

-- 0000. The client reads and PATCHes its own ciphertext row.
revoke all on public.vaults from public, anon, authenticated;
grant select, insert, update, delete on public.vaults to authenticated;

-- 0001 + 0010. SELECT only; set_profile()/set_display_name() are the writers.
revoke all on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;

-- 0001. Nothing, and now literally nothing: read only by definer functions.
revoke all on public.reserved_handles from public, anon, authenticated;

-- 0002. Both sides write the edge under RLS.
revoke all on public.friendships from public, anon, authenticated;
grant select, insert, update, delete on public.friendships to authenticated;

-- 0003. Own row write, plus the three scope-driven read policies.
revoke all on public.binders from public, anon, authenticated;
grant select, insert, update, delete on public.binders to authenticated;

-- 0003. Nothing. The want index answers only through match_wants(), one key at
-- a time -- the table this whole sweep exists for.
revoke all on public.trade_offers from public, anon, authenticated;

-- 0004. Read your own inbox and clear it; only send_to_inbox() inserts.
revoke all on public.inbox from public, anon, authenticated;
grant select, delete on public.inbox to authenticated;

-- 0005. Read-own; service_role writes.
revoke all on public.entitlements from public, anon, authenticated;
grant select on public.entitlements to authenticated;
revoke all on public.scan_usage from public, anon, authenticated;
grant select on public.scan_usage to authenticated;

-- 0006. Read-own. Money transitions are service_role only (decision 19), and
-- `seller_accounts.stripe_account_id` is written by the webhook alone.
revoke all on public.seller_accounts from public, anon, authenticated;
grant select on public.seller_accounts to authenticated;
revoke all on public.orders from public, anon, authenticated;
grant select on public.orders to authenticated;

-- 0008, AND THIS ONE IS A REAL FIX, not a tidy-up. `build_usage_read_own` is a
-- SELECT policy on a table that was never granted SELECT, so it was inert: a
-- signed-in read got `42501 permission denied` before RLS was consulted -- the
-- exact trap 0000's header describes, where the policy reads as correct and
-- every request fails. 0008 says "Same posture as scan_usage" and scan_usage
-- has the grant; this finishes the sentence. Nothing reads the table today, so
-- this is not fixing a live break -- it is making sure the person who first
-- shows "3 builds left" debugs nothing.
--
-- `service_role` still gets no DML here, deliberately: consume_build_credit()
-- is SECURITY DEFINER and runs as the owner, and build-deck/index.ts calls that
-- RPC rather than touching the table. Nothing needs the wider grant.
revoke all on public.build_usage from public, anon, authenticated;
grant select on public.build_usage to authenticated;

/* --------------------------------------------------- and stop it recurring */

-- The recurrence 0011 declined to fix, now that the shape of it is known.
-- `pg_default_acl` holds TWO entries for schema `public`:
--
--   granted by `postgres`        -> anon/authenticated get Dxtm
--                                   (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN)
--   granted by `supabase_admin`  -> anon/authenticated get arwdDxtm
--                                   (all of the above AND FULL DML)
--
-- Only the first is ours, and it is the one that has been reappearing: every
-- table in `public` shows `/postgres` as its grantor, so `postgres` is the role
-- this project actually creates tables with (migrations arrive through the
-- Management API, which connects as `postgres`). Clearing its default is
-- therefore the whole recurrence for every path we use.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

-- The `supabase_admin` entry is NOT touched, because it cannot be: this role is
-- not a superuser and not a member of `supabase_admin`, and the ALTER fails
-- with `42501 permission denied to change default privileges`. Worth writing
-- down rather than leaving as a silent omission, because that default grants
-- FULL DML to `anon` -- a table created by that role would land world-writable
-- before any policy is considered. Nothing in `public` has ever been created
-- that way, and the platform, not us, decides whether anything ever is.
--
-- Which is why the convention outlives this migration: a new table still
-- states its own grants, `revoke all` first. The default is now a safety net
-- rather than the thing being relied on -- 0000's header said not to rely on
-- it, and this makes that true instead of aspirational.

-- Rollback:
--   alter default privileges for role postgres in schema public
--     grant references, trigger, truncate, maintain on tables
--     to anon, authenticated;
--   revoke select on public.build_usage from authenticated;
--   -- the per-table grants above already match 0000-0010; nothing to undo.
