-- 0005_scan_entitlements.sql
--
-- WHAT: `entitlements` (who may use a paid feature) and `scan_usage` (how much
-- they have used this month). Both exist to serve ONE consumer: the `scan-card`
-- edge function, which holds the Gemini API key server-side and will not call
-- Google without checking these first.
--
-- WHY IT EXISTS AT ALL: the app deploys as a static gh-pages bundle. A key in
-- that bundle is public — `VITE_` values are inlined at build time and readable
-- in devtools — so a shipped Gemini key gets scraped and drained. There is no
-- client-side way to hold a shared credential, which is the same reason
-- `src/lib/entitlement.ts` says entitlement "has no authority in this
-- architecture yet". This migration is that authority.
--
-- TRUST MODEL — the whole point, so read it before changing a policy:
--   * A signed-in user may READ their own entitlement row and their own usage
--     row. That is all. It lets the UI say "you're subscribed" and "43 scans
--     left" without a second round trip.
--   * NOBODY may write either table through PostgREST. Not the owner, not
--     anyone. Writes happen only from the edge function using the service role,
--     which bypasses RLS. A user who could write `entitlements` would grant
--     themselves the paid tier; a user who could write `scan_usage` would reset
--     their own meter. Both are the same bug.
--   * `anon` gets nothing at all. The RLS policy is the second lock, not the
--     first — see the grants below.
--
-- GRANTS ARE NOT OPTIONAL: Supabase projects created from ~2026 no longer grant
-- DML on new public tables. PostgREST returns `42501 permission denied` BEFORE
-- it consults any policy, so a table with flawless RLS still fails every
-- request, including authenticated ones. This project (created 2026-08-14) is
-- one of those. Grant explicitly, always.
--
-- ORDERING: safe to apply before the client ships. It only ADDS access, so
-- there is no two-phase concern here — no deployed client reads these tables
-- yet, and nothing existing loses access.
--
-- ROLLBACK:
--   drop table if exists public.scan_usage;
--   drop table if exists public.entitlements;

-- ---------------------------------------------------------------- entitlements

create table if not exists public.entitlements (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  -- Matches PaidFeature in src/lib/entitlement.ts ('cloud-scan' today).
  -- Deliberately text rather than an enum: adding a feature should not need a
  -- migration, and the edge function is the thing that validates the value.
  feature    text        not null,
  -- NULL = no expiry (a manual/comped grant). A subscription sets this and the
  -- billing webhook keeps pushing it forward; letting it lapse is the whole
  -- cancellation mechanism, so nothing has to handle a "cancelled" state.
  expires_at timestamptz,
  -- Where it came from: 'manual', 'square', later maybe 'promo'. Billing is
  -- deliberately a STRING here and not a foreign key — the entitlements table
  -- is the interface, so swapping payment providers touches this column's
  -- values and nothing else in the app.
  source     text        not null default 'manual',
  updated_at timestamptz not null default now(),
  primary key (user_id, feature)
);

alter table public.entitlements enable row level security;

drop policy if exists entitlements_read_own on public.entitlements;
create policy entitlements_read_own
  on public.entitlements for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert/update/delete policy exists on purpose. Absent a policy, RLS denies.
grant select on public.entitlements to authenticated;
grant select, insert, update, delete on public.entitlements to service_role;

-- ------------------------------------------------------------------ scan_usage

create table if not exists public.scan_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'YYYY-MM'. A text period beats a rolling window here: it is trivially
  -- readable in the dashboard when someone asks why they ran out, and the
  -- primary key does the monthly reset for free by simply having no row yet.
  period  text not null,
  calls   int  not null default 0,
  primary key (user_id, period)
);

alter table public.scan_usage enable row level security;

drop policy if exists scan_usage_read_own on public.scan_usage;
create policy scan_usage_read_own
  on public.scan_usage for select
  to authenticated
  using (auth.uid() = user_id);

grant select on public.scan_usage to authenticated;
grant select, insert, update, delete on public.scan_usage to service_role;

-- ------------------------------------------------------- the metered check
--
-- One round trip that answers "may this user scan, and if so count it" without
-- the edge function doing read-then-write (two statements racing each other
-- across concurrent scans of a binder page would both read the old count).
-- SECURITY DEFINER so it can write a table nobody may write directly, and
-- `search_path` is PINNED — an unpinned definer function is hijackable by
-- anything that can create a schema.
--
-- Returns the number of calls REMAINING after consuming one, or -1 when the
-- caller is not entitled. Callers must treat -1 and 0 differently: -1 is "not
-- a subscriber", 0 is "subscriber who has used their allowance".

create or replace function public.consume_scan_credit(p_user uuid, p_limit int)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_calls  int;
begin
  if not exists (
    select 1 from public.entitlements e
    where e.user_id = p_user
      and e.feature = 'cloud-scan'
      and (e.expires_at is null or e.expires_at > now())
  ) then
    return -1;
  end if;

  insert into public.scan_usage (user_id, period, calls)
  values (p_user, v_period, 1)
  on conflict (user_id, period)
    do update set calls = public.scan_usage.calls + 1
  returning calls into v_calls;

  if v_calls > p_limit then
    -- Over the line: give the credit back so a refused call is not billed to
    -- the user's allowance, and report exhaustion.
    update public.scan_usage set calls = calls - 1
      where user_id = p_user and period = v_period;
    return 0;
  end if;

  return p_limit - v_calls;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default. Only the edge function's
-- service role may call this — a user who could call it directly could burn
-- their own quota, which is harmless, but could also probe entitlement for
-- arbitrary user ids, which is not.
revoke execute on function public.consume_scan_credit(uuid, int) from public, anon, authenticated;
grant  execute on function public.consume_scan_credit(uuid, int) to service_role;
