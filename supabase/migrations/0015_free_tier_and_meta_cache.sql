-- 0015_free_tier_and_meta_cache.sql
--
-- A free allowance for both paid features, and a daily cache for the one thing
-- that actually costs money.
--
-- WHY A FREE TIER AT ALL. Cloud rescue costs ~$0.00015 a call — fifteen pence a
-- year for a thousand a month — so refusing it outright bought nothing and made
-- the scanner look worse to exactly the people deciding whether to pay. Deck
-- builds are 250x dearer and stay mostly behind the subscription. The split is
-- by COST, not by generosity: give away the cheap thing, charge for the dear one.
--
-- ORDINARY SCANNING IS NOT METERED AND NEVER WILL BE. It runs on the device,
-- costs us nothing, works offline and with no account. Only the RESCUE — the
-- fallback for a card the local pipeline failed to read — reaches a server and
-- is counted here. Anyone reading this file who is tempted to meter scanning
-- itself should read the first paragraph of CLAUDE.md first.
--
-- THE RETURN TYPE DOES NOT CHANGE, and that is a safety decision rather than a
-- stylistic one. The deployed edge functions do `Number(await res.json())` and
-- compare against 0 and -1. Returning jsonb instead would make that `NaN`,
-- which is neither `< 0` nor `=== 0`, so every check would pass and the
-- function would FAIL OPEN — handing out paid API calls to anyone, for as long
-- as it took to notice. An int it stays.
--
-- The new parameter carries a DEFAULT so a not-yet-redeployed function calling
-- with two arguments keeps the exact behaviour it has today: no free tier,
-- refuse the unentitled. The old two-argument versions are dropped in the same
-- transaction, so there is never a moment with an ambiguous overload.
--
-- ROLLBACK:
--   drop function if exists public.consume_scan_credit(uuid, int, int);
--   drop function if exists public.consume_build_credit(uuid, int, int);
--   -- then re-create the two-argument versions from 0005 and 0008
--   drop function if exists public.take_meta_snapshot(text, text);
--   drop function if exists public.read_meta_snapshot(text);
--   drop table if exists public.meta_snapshots;

-- ------------------------------------------------------------- free tiers

drop function if exists public.consume_scan_credit(uuid, int);
drop function if exists public.consume_build_credit(uuid, int);

/**
 * Spend one cloud rescue.
 *
 *   -1  no access at all (unentitled AND no free tier configured)
 *    0  allowance exhausted — for a free user this is the moment to subscribe
 *   >0  how many remain after this one
 *
 * Entitlement and metering in ONE statement: read-then-write would let the nine
 * concurrent identifications of a binder page each read the same count.
 */
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
    -- No free tier configured: behave exactly as before this migration.
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
    return 0;
  end if;

  return v_cap - v_calls;
end;
$$;

/** The same, for deck builds. Dearer per call, so a much smaller free tier. */
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
    return 0;
  end if;

  return v_cap - v_calls;
end;
$$;

revoke execute on function public.consume_scan_credit(uuid, int, int)  from public, anon, authenticated;
revoke execute on function public.consume_build_credit(uuid, int, int) from public, anon, authenticated;
grant  execute on function public.consume_scan_credit(uuid, int, int)  to service_role;
grant  execute on function public.consume_build_credit(uuid, int, int) to service_role;

-- --------------------------------------------------------- the meta cache

/**
 * One grounded metagame lookup per game per day, shared by everybody.
 *
 * THE ECONOMICS OF THE WHOLE PRODUCT LIVE HERE. A deck build costs ~$0.004 in
 * tokens and ~$0.035 in Google Search grounding — ninety percent of the bill is
 * a question whose answer is IDENTICAL for every user on a given day. "What is
 * the current Modern metagame" does not vary by who asks. Caching it turns a
 * four-cent build into a fraction of a cent and is worth more than any price
 * we could have chosen.
 *
 * Deliberately keyed by DAY and not given a TTL: a metagame does not move
 * hourly, a date is legible to a human reading the table, and an entry that
 * simply stops being today's needs no sweeper.
 */
create table if not exists public.meta_snapshots (
  game     text not null,
  /** UTC date. Today's row is the live one; older rows are history. */
  day      date not null,
  markdown text not null,
  created_at timestamptz not null default now(),
  primary key (game, day)
);

comment on table public.meta_snapshots is
  'Daily per-game metagame summary, grounded once and reused by every deck build that day.';

alter table public.meta_snapshots enable row level security;
-- No policies: only the edge function, with the service role, ever touches this.
revoke all on public.meta_snapshots from anon, authenticated;

/** Today's snapshot for a game, or null if nobody has grounded one yet. */
create or replace function public.read_meta_snapshot(p_game text)
returns text
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select m.markdown from public.meta_snapshots m
  where m.game = p_game and m.day = (now() at time zone 'utc')::date;
$$;

/**
 * Store today's snapshot. `do nothing` on conflict because two builds can miss
 * the cache at the same moment and both ground — one wasted lookup is fine, and
 * far better than locking every build behind a writer.
 */
create or replace function public.take_meta_snapshot(p_game text, p_markdown text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.meta_snapshots (game, day, markdown)
  values (p_game, (now() at time zone 'utc')::date, p_markdown)
  on conflict (game, day) do nothing;
$$;

revoke execute on function public.read_meta_snapshot(text)        from public, anon, authenticated;
revoke execute on function public.take_meta_snapshot(text, text)  from public, anon, authenticated;
grant  execute on function public.read_meta_snapshot(text)        to service_role;
grant  execute on function public.take_meta_snapshot(text, text)  to service_role;
