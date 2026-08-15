-- Hosted social, follow-up to 0001: a handle belongs to one account, once.
--
-- WHAT WAS WRONG. `set_profile()` upserted on `user_id` and overwrote `handle`,
-- so a rename released the old name for anyone to claim, and `erase_social()`
-- (0004) deletes the profile row, which released it the same way. The client
-- turned that from a possibility into a routine event: the welcome screen asked
-- for a handle after every sign-in, prefilled from the email address, without
-- ever checking whether this account already had one. Signing in on a second
-- phone therefore RENAMED you and freed the name your friends had saved.
--
-- The account itself was never at risk — identity is `auth.uid()`, and GoTrue
-- keeps one user per email address. What was at risk is the only part of that
-- identity another collector ever sees. A handle that can come to mean a second
-- person is an impersonation primitive: `request_friend()` resolves a handle at
-- the moment it is called, `match_wants()` answers with handles, and a trade
-- proposal names its sender by one. Rae's friends would keep typing @rae.
--
-- THE LEDGER. `handle_claims` records every handle ever claimed and never
-- deletes a row. It — not `profiles` — is the uniqueness authority;
-- `profiles.handle` is now a cache of the row that is currently live. A handle
-- whose profile was erased is still spoken for, and its owner can reclaim it.
--
-- A DELETED ACCOUNT RETIRES ITS HANDLE FOREVER. `on delete set null` rather
-- than `on delete cascade`: when the auth user goes, the ledger row stays with
-- a null owner, which no one can match. That is deliberate and it is the whole
-- point — "nobody" is the only safe answer to who gets @rae after Rae leaves.
-- Handle exhaustion is not a real cost at this scale; a stranger inheriting a
-- name mid-trade is.
--
-- PERMANENCE IS ENFORCED IN THREE PLACES, on purpose:
--   1. `set_profile()` refuses a handle change outright (`handle_locked`).
--   2. `authenticated` loses INSERT/UPDATE/DELETE on `profiles`, so the RPC is
--      the only door. It had them, and the RLS policy allowed a straight PATCH
--      of your own row — the rule in the function was not a rule at all.
--   3. A trigger refuses the update even from the table owner, so a future
--      edit to the definer function cannot quietly undo this.
-- A maintainer who genuinely must repair a handle by hand has to disable the
-- trigger to do it. That friction is a feature.

/* ------------------------------------------------------------------ ledger */

create table if not exists public.handle_claims (
  handle     text primary key check (handle ~ '^[a-z0-9_]{3,24}$'),
  -- Null means retired: claimed once, the account is gone, nobody gets it.
  user_id    uuid references auth.users(id) on delete set null,
  claimed_at timestamptz not null default now()
);

alter table public.handle_claims enable row level security;
-- No policy and no grant to `authenticated`, exactly like `reserved_handles`:
-- this table answers questions only through the definer functions below.
-- Direct read would turn "which handles are retired" into a dump, and direct
-- write would be the hole this migration exists to close.
--
-- `service_role` is the exception, and only because the RLS harness creates
-- throwaway accounts on the REAL project: deleting those users retires their
-- handles forever (`on delete set null`), so every run would burn a few names
-- permanently unless the harness can sweep them. The secret key can already do
-- anything; this only makes the cleanup expressible through PostgREST.
revoke all on public.handle_claims from public, anon, authenticated;
grant select, delete on public.handle_claims to service_role;
-- The revoke above is not ceremonial. Supabase's default privileges hand
-- `authenticated` REFERENCES/TRIGGER/TRUNCATE on every new table in `public`,
-- which survives a `revoke insert, update, delete` and leaves a table that is
-- documented as unreachable holding a grant that could empty it. PostgREST
-- never issues TRUNCATE, so this is latent rather than live — but "no grant"
-- should be true rather than nearly true. Every other table in this project
-- still carries the default; that is a separate sweep.

-- Every handle already in use is claimed by whoever is holding it now.
insert into public.handle_claims (handle, user_id, claimed_at)
  select handle, user_id, created_at from public.profiles
on conflict (handle) do nothing;

/* ------------------------------------------------------------- the writers */

/**
 * Claim your handle, or update your display name.
 *
 * Same name and signature as 0001's version, because a cached PWA client is
 * still calling it — see the two-phase rule. The behaviour change is what an
 * old client gets when it re-sends a handle for an account that already has a
 * different one: `handle_locked` instead of a silent rename. That is a visible
 * error on a screen the user can leave, rather than a destroyed identity.
 *
 * Once you have a handle, this only ever writes `display_name`.
 */
create or replace function public.set_profile(p_handle text, p_display_name text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_handle  text := lower(trim(p_handle));
  v_name    text := trim(p_display_name);
  v_current text;
  v_owner   uuid;
  v_held    boolean;
  result    public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if v_handle !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'bad_handle' using errcode = 'P0001';
  end if;
  if v_name = '' or length(v_name) > 60 then
    raise exception 'bad_display_name' using errcode = 'P0001';
  end if;

  select handle into v_current from public.profiles where user_id = auth.uid();

  -- Already have one. The name is yours to change; the handle is not.
  if v_current is not null then
    if v_current <> v_handle then
      raise exception 'handle_locked' using errcode = 'P0001';
    end if;
    update public.profiles
       set display_name = v_name, updated_at = now()
     where user_id = auth.uid()
    returning * into result;
    return result;
  end if;

  if exists (select 1 from public.reserved_handles where handle = v_handle) then
    raise exception 'handle_reserved' using errcode = 'P0001';
  end if;

  -- The ledger decides, not `profiles`: an erased account still holds its name.
  select user_id into v_owner from public.handle_claims where handle = v_handle;
  v_held := found;
  if v_held and v_owner is distinct from auth.uid() then
    raise exception 'handle_taken' using errcode = 'P0001';
  end if;

  -- Race-safe: two callers reaching here at once both try the insert, the
  -- primary key picks one, and the loser fails the ownership test below
  -- rather than the unique violation deciding it later.
  insert into public.handle_claims (handle, user_id)
    values (v_handle, auth.uid())
  on conflict (handle) do nothing;
  if not exists (
    select 1 from public.handle_claims where handle = v_handle and user_id = auth.uid()
  ) then
    raise exception 'handle_taken' using errcode = 'P0001';
  end if;

  -- `do nothing` rather than a plain insert so a double-tapped Claim returns
  -- the row it already made instead of a primary-key error dressed up as
  -- "that handle is taken".
  insert into public.profiles (user_id, handle, display_name)
    values (auth.uid(), v_handle, v_name)
  on conflict (user_id) do nothing;

  select * into result from public.profiles where user_id = auth.uid();
  if result.handle is distinct from v_handle then
    raise exception 'handle_locked' using errcode = 'P0001';
  end if;
  return result;
exception
  when unique_violation then
    raise exception 'handle_taken' using errcode = 'P0001';
end;
$$;

/**
 * Change the name friends see. Separate from `set_profile` so the client never
 * has to send a handle to edit something that is not the handle — the copy
 * promises the display name stays editable, and this is what keeps that true.
 */
create or replace function public.set_display_name(p_display_name text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := trim(p_display_name);
  result public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if v_name = '' or length(v_name) > 60 then
    raise exception 'bad_display_name' using errcode = 'P0001';
  end if;
  update public.profiles
     set display_name = v_name, updated_at = now()
   where user_id = auth.uid()
  returning * into result;
  if result.user_id is null then
    raise exception 'no_profile' using errcode = 'P0001';
  end if;
  return result;
end;
$$;

/**
 * Is this handle claimable by me? `ok | mine | taken | reserved | bad`.
 *
 * So the UI can say "@rae is taken" while someone is typing rather than after
 * they commit to it — a handle is permanent, so the moment to find out is
 * before the tap, not after.
 *
 * Exposure: current handles are ALREADY enumerable (`profiles` is readable by
 * every signed-in user, deliberately — a directory nobody can read is not a
 * directory). The only thing new here is that a retired handle reads as taken,
 * which discloses that a name was once used and nothing about by whom.
 */
create or replace function public.handle_available(p_handle text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_handle text := lower(trim(coalesce(p_handle, '')));
  v_owner  uuid;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if v_handle !~ '^[a-z0-9_]{3,24}$' then
    return 'bad';
  end if;
  if exists (select 1 from public.reserved_handles where handle = v_handle) then
    return 'reserved';
  end if;
  select user_id into v_owner from public.handle_claims where handle = v_handle;
  if not found then
    return 'ok';
  end if;
  -- A null owner is a retired handle, and `null = uid` is null, so it falls
  -- through to 'taken'. That is the intended answer.
  if v_owner = auth.uid() then
    return 'mine';
  end if;
  return 'taken';
end;
$$;

/* ------------------------------------------------------------- the backstop */

create or replace function public.profiles_handle_is_permanent()
returns trigger
language plpgsql
as $$
begin
  if new.handle is distinct from old.handle then
    raise exception 'handle_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_handle_permanent on public.profiles;
create trigger profiles_handle_permanent
  before update on public.profiles
  for each row execute function public.profiles_handle_is_permanent();

/* ----------------------------------------------------------------- the door */

-- The RPCs are now the only way to write a profile. Nothing shipped ever
-- PATCHed this table — `socialcloud.ts` reads it and calls `set_profile` to
-- write — so removing the grant breaks no cached client. `erase_social()` is
-- `security definer` and runs as the owner, so its delete is unaffected.
revoke insert, update, delete, truncate on public.profiles from authenticated;
grant  select on public.profiles to authenticated;

revoke execute on function public.set_profile(text, text)      from public, anon;
revoke execute on function public.set_display_name(text)       from public, anon;
revoke execute on function public.handle_available(text)       from public, anon;
grant  execute on function public.set_profile(text, text)      to authenticated;
grant  execute on function public.set_display_name(text)       to authenticated;
grant  execute on function public.handle_available(text)       to authenticated;

-- Rollback:
--   drop trigger if exists profiles_handle_permanent on public.profiles;
--   drop function if exists public.profiles_handle_is_permanent();
--   drop function if exists public.handle_available(text);
--   drop function if exists public.set_display_name(text);
--   drop table if exists public.handle_claims;
--   grant insert, update, delete on public.profiles to authenticated;
--   -- and restore set_profile() from 0001.
