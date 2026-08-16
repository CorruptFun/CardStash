-- 0016_referral_rewards.sql
--
-- Three prices, and what a referrer earns.
--
-- THE TIERS, and the reason each exists:
--   founding  $6.99 once, lifetime   first 100, must have been referred
--   referred  $9.99 / year           referred, but the seats are gone
--   standard  $11.99 / year          everyone else
--
-- The middle tier is the one that makes a revenue share possible at all. A
-- one-off lifetime fee has no recurring profit to share — paying a bounty out
-- of it means paying from a pot that must last decades — so the founding 100
-- earn their referrer nothing, and every RECURRING subscription they bring in
-- does. That is the honest version.
--
-- A FIXED BOUNTY, NOT A PERCENTAGE. "A portion of the profit" sounds generous
-- and is unanswerable: profit per user varies with how much they scan and is
-- not known until long after the payout. A flat amount per confirmed paying
-- referral is a number both sides can check, and it is bounded.
--
-- SINGLE LEVEL, AND CAPPED. Nobody earns on their referrals' referrals. Pay
-- people to recruit people who are paid to recruit and you have described a
-- pyramid scheme, whatever the intent; one level is the difference. The cap is
-- both an abuse limit and a tax one — US payouts past $600 a year to one person
-- mean a 1099, and 25 x $2 stays comfortably clear of it.
--
-- NOTHING HERE MOVES MONEY. This records what is OWED. Paying it out goes
-- through Stripe Connect and `seller_accounts` (0006) — the same rails that pay
-- someone for a card — and is deliberately a separate, later step, because a
-- ledger that is wrong is embarrassing while a transfer that is wrong is theft.
--
-- ROLLBACK:
--   drop function if exists public.referral_earnings(uuid);
--   drop function if exists public.record_referral_reward(uuid, text);
--   drop function if exists public.referral_tier();
--   drop table if exists public.referral_rewards;

/** Bounty per confirmed paying referral, in cents. */
create or replace function public.referral_bounty_cents()
returns int language sql immutable set search_path = public, pg_temp as $$ select 200 $$;

/** Most a single referrer can earn. See the 1099 note above. */
create or replace function public.referral_reward_cap()
returns int language sql immutable set search_path = public, pg_temp as $$ select 25 $$;

create table if not exists public.referral_rewards (
  /** Who earns it. */
  referrer_id uuid not null references auth.users (id) on delete cascade,
  /** Who paid. One reward per referred person, ever — hence the primary key. */
  referred_id uuid primary key references auth.users (id) on delete cascade,
  amount_cents int not null check (amount_cents >= 0),
  /** 'referred' or 'standard' — which subscription earned it. */
  tier text not null,
  /** Set when the money actually reaches them. Null = owed. */
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists referral_rewards_by_referrer_idx on public.referral_rewards (referrer_id);

comment on table public.referral_rewards is
  'What each referrer has earned. Written only by record_referral_reward() after a payment; paying it out is a separate step through Stripe Connect.';

alter table public.referral_rewards enable row level security;

-- Read-own: someone may see what they have earned. Nobody writes through
-- PostgREST — a user who could would pay themselves.
drop policy if exists referral_rewards_read_own on public.referral_rewards;
create policy referral_rewards_read_own on public.referral_rewards
  for select to authenticated using (auth.uid() = referrer_id);

revoke insert, update, delete on public.referral_rewards from anon, authenticated;

/**
 * Which price the CALLER should be offered.
 *
 * 'founding' | 'referred' | 'standard'. Reads `auth.uid()` so it cannot be
 * asked on somebody else's behalf. Does NOT reserve anything — checkout does
 * that separately, because a price quote must not consume a seat.
 */
create or replace function public.referral_tier()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then return 'standard'; end if;
  if not exists (select 1 from public.referrals r where r.user_id = v_user) then
    return 'standard';
  end if;
  -- Referred. A seat only if one is genuinely free, or they already hold one.
  if exists (select 1 from public.founding_members f where f.user_id = v_user)
     or public.founding_seats_left() > 0 then
    return 'founding';
  end if;
  return 'referred';
end;
$$;

/**
 * Credit the person who introduced `p_referred`, once.
 *
 * Called by the billing webhook with the service role AFTER money arrived —
 * never by a user, which is why it takes an id rather than reading `auth.uid()`.
 *
 * Founding purchases earn nothing and that is deliberate: a lifetime fee has no
 * recurring revenue behind it to share. Passing 'founding' here is a no-op
 * rather than an error, so the webhook can call it unconditionally.
 */
create or replace function public.record_referral_reward(p_referred uuid, p_tier text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_referrer uuid;
  v_earned   int;
begin
  if p_tier not in ('referred', 'standard') then return false; end if;

  select r.referred_by into v_referrer from public.referrals r where r.user_id = p_referred;
  if v_referrer is null or v_referrer = p_referred then return false; end if;

  -- The cap counts rewards already earned, not payouts made.
  select count(*) into v_earned from public.referral_rewards where referrer_id = v_referrer;
  if v_earned >= public.referral_reward_cap() then return false; end if;

  insert into public.referral_rewards (referrer_id, referred_id, amount_cents, tier)
  values (v_referrer, p_referred, public.referral_bounty_cents(), p_tier)
  on conflict (referred_id) do nothing;

  -- Report whether a row was ACTUALLY written. Returning true unconditionally
  -- made the function claim it had recorded a reward that the conflict clause
  -- had just dropped — the ledger was right but the answer was a lie, and a
  -- caller that ever branches on it (a receipt, a notification, a retry) would
  -- have believed it.
  get diagnostics v_earned = row_count;
  return v_earned > 0;
end;
$$;

/** What one person has earned and what is still owed, for the UI. */
create or replace function public.referral_earnings()
returns table (referrals int, earned_cents int, owed_cents int, cap int)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    count(*)::int,
    coalesce(sum(amount_cents), 0)::int,
    coalesce(sum(amount_cents) filter (where paid_at is null), 0)::int,
    public.referral_reward_cap()
  from public.referral_rewards
  where referrer_id = auth.uid();
$$;

revoke execute on function public.referral_tier()                       from public, anon;
revoke execute on function public.record_referral_reward(uuid, text)    from public, anon, authenticated;
revoke execute on function public.referral_earnings()                   from public, anon;

grant execute on function public.referral_tier()                    to authenticated;
grant execute on function public.record_referral_reward(uuid, text) to service_role;
grant execute on function public.referral_earnings()                to authenticated;
