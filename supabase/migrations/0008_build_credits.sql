-- 0008_build_credits.sql
--
-- Metering for the AI deck builder, now that it runs on OUR Gemini key.
--
-- WHY IT EXISTS. Users used to paste their own key into Settings, so the cost
-- of a build was theirs and no accounting was needed. The key is ours now and
-- the builder is part of what a subscription buys, which makes a build exactly
-- the same kind of thing as a cloud scan: a call that costs real money and must
-- be refused when it is not owed. This is `consume_scan_credit`'s sibling and
-- deliberately its twin — same shape, same failure codes, separate meter.
--
-- SEPARATE METER, NOT A SHARED ONE. A deck build is far dearer than a scan and
-- far rarer, so one pooled allowance would either starve scanning or make
-- builds effectively unlimited. Two counters keep each honest, and the feature
-- name is what an entitlement row grants.
--
-- The reuse of `scan_usage` for both would have been tempting and wrong for the
-- same reason: `(user_id, period)` is unique there, so a shared row cannot tell
-- the two apart.
--
-- ROLLBACK:
--   drop function if exists public.consume_build_credit(uuid, int);
--   drop table if exists public.build_usage;

create table if not exists public.build_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  /** UTC 'YYYY-MM'. Calendar months, so a subscriber's allowance resets when
      they expect it to rather than on a rolling window they cannot predict. */
  period text not null,
  calls int not null default 0,
  primary key (user_id, period)
);

comment on table public.build_usage is
  'AI deck builder calls per subscriber per calendar month. Written only by consume_build_credit().';

alter table public.build_usage enable row level security;

-- Read-own, write-nobody: the count is a fact the server asserts, not one a
-- user may edit. Same posture as scan_usage.
drop policy if exists build_usage_read_own on public.build_usage;
create policy build_usage_read_own on public.build_usage
  for select using (auth.uid() = user_id);

revoke insert, update, delete on public.build_usage from anon, authenticated;

/**
 * Spend one build, or explain why not.
 *
 *   -1  not entitled          0  allowance exhausted
 *   >0  how many remain after this one
 *
 * Entitlement and metering in ONE statement, for the same reason the scan
 * version is: read-then-write lets two concurrent builds read the same count
 * and both pass.
 */
create or replace function public.consume_build_credit(p_user uuid, p_limit int)
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
      and e.feature = 'ai-builder'
      and (e.expires_at is null or e.expires_at > now())
  ) then
    return -1;
  end if;

  insert into public.build_usage (user_id, period, calls)
  values (p_user, v_period, 1)
  on conflict (user_id, period)
    do update set calls = public.build_usage.calls + 1
  returning calls into v_calls;

  if v_calls > p_limit then
    -- Give the credit back: a refused call must not be billed to the allowance.
    update public.build_usage set calls = calls - 1
      where user_id = p_user and period = v_period;
    return 0;
  end if;

  return p_limit - v_calls;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default. Only the edge function's
-- service role may call this: a user calling it directly could burn their own
-- quota (harmless) but could also probe entitlement for arbitrary user ids
-- (not harmless).
revoke execute on function public.consume_build_credit(uuid, int) from public, anon, authenticated;
grant  execute on function public.consume_build_credit(uuid, int) to service_role;
