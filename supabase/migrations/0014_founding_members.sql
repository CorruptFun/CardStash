-- 0014_founding_members.sql
--
-- Referrals, and the first hundred seats.
--
-- THE OFFER. Someone who arrives through a friend's link may buy lifetime
-- access once, for a one-off fee, and only while fewer than 100 such seats have
-- gone. Everyone else buys the yearly subscription. Two tables: who referred
-- whom, and who holds a seat.
--
-- WHY A SEAT IS RESERVED AND NOT SIMPLY COUNTED. The obvious design counts rows
-- at checkout and inserts on payment, and it is wrong in a way that costs money
-- and trust: two people can both pass the count while 99 seats are gone, both
-- pay, and the second one gets a charge for a seat that does not exist. There
-- is no good ending to that — a refund is a bad first impression and honouring
-- it makes 100 a lie. So checkout RESERVES with a short expiry, payment CLAIMS,
-- and an abandoned checkout releases the seat when the reservation lapses.
--
-- `seat` carries `check (seat between 1 and 100)` and a unique constraint, and
-- that check is the real backstop. Every count-then-write in this file could be
-- raced by a determined enough client; the constraint cannot. If the arithmetic
-- above is ever wrong, the database refuses rather than overselling.
--
-- SELF-REFERRAL IS THE OBVIOUS ABUSE and is refused in `claim_referral()`:
-- referrer and referred must differ, and a referral cannot be recorded twice or
-- changed later. It is not airtight — nothing stops someone making two accounts
-- with two email addresses — but the seat cap bounds the damage at 100 and the
-- prize is one cheap licence rather than anything recurring.
--
-- ROLLBACK:
--   drop function if exists public.claim_referral(text);
--   drop function if exists public.reserve_founding_seat();
--   drop function if exists public.claim_founding_seat(uuid);
--   drop function if exists public.founding_seats_left();
--   drop table if exists public.founding_members;
--   drop table if exists public.referrals;

-- ------------------------------------------------------------------ referrals

create table if not exists public.referrals (
  /** The person who ARRIVED. One referral per account, ever. */
  user_id     uuid primary key references auth.users (id) on delete cascade,
  /** The person whose link they came through. */
  referred_by uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint referrals_not_self check (user_id <> referred_by)
);

create index if not exists referrals_by_referrer_idx on public.referrals (referred_by);

comment on table public.referrals is
  'Who arrived through whose link. Written once per account by claim_referral(); never updated.';

alter table public.referrals enable row level security;

-- Read-own only: a user may see that they were referred (the app shows the
-- offer), but the graph as a whole is nobody's business. No write policy at
-- all — `claim_referral()` is the only way in.
drop policy if exists referrals_read_own on public.referrals;
create policy referrals_read_own on public.referrals
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on public.referrals from anon, authenticated;

-- ----------------------------------------------------------- founding members

create table if not exists public.founding_members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  /** 1-100. The unique constraint plus this check is what makes 100 mean 100. */
  seat       int not null unique check (seat between 1 and 100),
  /** Held but not yet paid for; NULL once actually claimed. */
  reserved_until timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.founding_members is
  'The first 100 lifetime seats. Reserved at checkout, claimed on payment, released if the reservation lapses.';

alter table public.founding_members enable row level security;

drop policy if exists founding_read_own on public.founding_members;
create policy founding_read_own on public.founding_members
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on public.founding_members from anon, authenticated;

-- ------------------------------------------------------------------ functions

/**
 * Record that the caller arrived through `p_handle`'s link.
 *
 * Once only, and never self. Silently does nothing if a referral already
 * exists — re-running must not overwrite who actually introduced them, and an
 * error here would surface during sign-up for no benefit.
 */
create or replace function public.claim_referral(p_handle text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_referrer uuid;
begin
  if v_user is null or p_handle is null then return false; end if;
  if exists (select 1 from public.referrals r where r.user_id = v_user) then return false; end if;

  select p.user_id into v_referrer
  from public.profiles p
  where lower(p.handle) = lower(trim(p_handle));

  if v_referrer is null or v_referrer = v_user then return false; end if;

  insert into public.referrals (user_id, referred_by) values (v_user, v_referrer)
  on conflict (user_id) do nothing;
  return true;
end;
$$;

/** How many of the hundred are still available, counting live reservations. */
create or replace function public.founding_seats_left()
returns int
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select 100 - count(*)::int
  from public.founding_members
  where claimed_at is not null
     or (reserved_until is not null and reserved_until > now());
$$;

/**
 * Take a seat for the caller, or return 0 if there is none to take.
 *
 * Requires a referral to exist — the offer is for people who arrived through a
 * friend, and that check lives here rather than in the edge function so it
 * cannot be skipped by calling the function directly.
 *
 * The exclusive lock is deliberate and cheap: this table has at most 100 rows
 * and is written a few times an hour at the very most, so serialising it is
 * free and removes the whole class of race the header describes.
 */
create or replace function public.reserve_founding_seat()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_seat int;
  v_have int;
begin
  if v_user is null then return 0; end if;
  if not exists (select 1 from public.referrals r where r.user_id = v_user) then return 0; end if;

  lock table public.founding_members in exclusive mode;

  -- Already hold one? Re-reserve it rather than consuming a second.
  select seat into v_have from public.founding_members where user_id = v_user;
  if v_have is not null then
    update public.founding_members
       set reserved_until = greatest(coalesce(reserved_until, now()), now() + interval '30 minutes')
     where user_id = v_user and claimed_at is null;
    return v_have;
  end if;

  -- Clear lapsed reservations FIRST, so their numbers are genuinely free and
  -- the unique constraint does not block reusing one below.
  delete from public.founding_members
   where claimed_at is null and reserved_until is not null and reserved_until <= now();

  -- The LOWEST unused number, not max+1. `max+1` cannot see a gap: once seat
  -- 100 is taken, an abandoned checkout at seat 2 frees a seat that can never
  -- be allocated again, and the offer quietly closes early with 99 sold. Caught
  -- by a test that expired one reservation and watched the next buyer refused
  -- while `founding_seats_left()` still said one was free.
  select g into v_seat
  from generate_series(1, 100) g
  where not exists (
    select 1 from public.founding_members f
    where f.seat = g
      and (f.claimed_at is not null or (f.reserved_until is not null and f.reserved_until > now()))
  )
  order by g
  limit 1;

  if v_seat is null then return 0; end if;

  insert into public.founding_members (user_id, seat, reserved_until)
  values (v_user, v_seat, now() + interval '30 minutes');

  return v_seat;
end;
$$;

/**
 * Turn a reservation into a claim. Called by the billing webhook with the
 * service role AFTER the money arrived — never by a user, which is why it takes
 * the id rather than reading `auth.uid()`.
 */
create or replace function public.claim_founding_seat(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seat int;
begin
  update public.founding_members
     set claimed_at = coalesce(claimed_at, now()), reserved_until = null
   where user_id = p_user
  returning seat into v_seat;
  return v_seat is not null;
end;
$$;

revoke execute on function public.claim_referral(text)        from public, anon;
revoke execute on function public.founding_seats_left()       from public;
revoke execute on function public.reserve_founding_seat()     from public, anon;
revoke execute on function public.claim_founding_seat(uuid)   from public, anon, authenticated;

grant execute on function public.claim_referral(text)     to authenticated;
-- Anyone may ask how many are left; it is a marketing number, not a secret.
grant execute on function public.founding_seats_left()    to anon, authenticated;
grant execute on function public.reserve_founding_seat()  to authenticated;
grant execute on function public.claim_founding_seat(uuid) to service_role;
