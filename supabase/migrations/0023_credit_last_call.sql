-- 0023_credit_last_call.sql
--
-- The month's LAST credit was consumed and then refused. 0015's
-- consume_scan_credit and consume_build_credit return 0 both for "that was
-- your final credit, spend it" (v_calls == v_cap -- consumed, nothing
-- refunded) and for "over the cap" (refunded) -- and the edge functions,
-- unable to tell the two apart, 429 them both. So the 50th free rescue and
-- the 12th build were eaten and denied. Surfaced by the usage-meter round
-- noticing a 200 response could never carry remaining = 0.
--
-- The return vocabulary gains one word. The full contract:
--   >= 0  allowed; the value is what remains AFTER this call
--   -1    not entitled (no subscription and no free tier configured)
--   -2    over the cap; nothing consumed (the increment was refunded)
--
-- Deploy order, for the seconds it takes: SQL first, then the edge
-- functions. Old edge + new SQL maps -2 to a 403 briefly (wrong word, no
-- harm); new edge + old SQL would have waved over-cap calls through free.
--
-- Rollback: re-apply 0015's two definitions.

create or replace function public.consume_scan_credit(p_user uuid, p_limit int, p_free_limit int default 0)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_calls  int;
  v_cap    int;
begin
  if exists (
    select 1 from public.entitlements e
    where e.user_id = p_user
      and e.feature = 'cloud-scan'
      and (e.expires_at is null or e.expires_at > now())
  ) then
    v_cap := p_limit;
  else
    v_cap := coalesce(p_free_limit, 0);
    if v_cap <= 0 then return -1; end if;
  end if;

  insert into public.scan_usage (user_id, period, calls)
  values (p_user, v_period, 1)
  on conflict (user_id, period)
    do update set calls = public.scan_usage.calls + 1
  returning calls into v_calls;

  if v_calls > v_cap then
    -- Give the credit back: a refused call must not be billed to the allowance.
    update public.scan_usage set calls = calls - 1
      where user_id = p_user and period = v_period;
    return -2;
  end if;

  return v_cap - v_calls;
end;
$$;

create or replace function public.consume_build_credit(p_user uuid, p_limit int, p_free_limit int default 0)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_calls  int;
  v_cap    int;
begin
  if exists (
    select 1 from public.entitlements e
    where e.user_id = p_user
      and e.feature = 'ai-builder'
      and (e.expires_at is null or e.expires_at > now())
  ) then
    v_cap := p_limit;
  else
    v_cap := coalesce(p_free_limit, 0);
    if v_cap <= 0 then return -1; end if;
  end if;

  insert into public.build_usage (user_id, period, calls)
  values (p_user, v_period, 1)
  on conflict (user_id, period)
    do update set calls = public.build_usage.calls + 1
  returning calls into v_calls;

  if v_calls > v_cap then
    update public.build_usage set calls = calls - 1
      where user_id = p_user and period = v_period;
    return -2;
  end if;

  return v_cap - v_calls;
end;
$$;
