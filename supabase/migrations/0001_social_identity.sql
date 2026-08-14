-- Hosted social, part 1 of 4: identity.
--
-- WHAT THIS REPLACES. Today a collector's social identity is `profileId` in
-- localStorage (src/lib/settings.ts) plus a `syncToken` claimed trust-on-first-
-- use by the self-hosted box. Clearing browser storage destroys both: the id is
-- unrecoverable, every friend who followed that binder is now following a dead
-- id, and nothing can be republished under it ever again. That is the single
-- worst property of the current design and it is why accounts exist at all.
--
-- After this, identity is the Supabase user. Sign in on any device and you are
-- you. The handle is the human-facing name for that row.
--
-- TRUST MODEL. This table is readable by ANY authenticated user, on purpose:
-- resolving "@rae" to a user id is the whole point of a handle, and a directory
-- nobody can read is not a directory. So it carries identity ONLY.
--
-- Note what is deliberately NOT here: the contact blurb ("DM @rae on Discord").
-- That is real contact information, it lives on the binder row (0003), and it
-- therefore inherits the binder's scope-driven visibility instead of being
-- published to every signed-in stranger. Moving it here later would silently
-- widen its audience -- don't.

create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  -- Stored already-lowercased so the unique index IS the case-insensitive
  -- check. Doing it this way rather than with citext keeps the extension list
  -- empty; set_profile() below is the only writer and it lowercases.
  handle       text not null unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (length(display_name) between 1 and 60),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Anyone signed in may READ the directory; only you may write your own row.
-- Split rather than one for-all policy because the read audience and the write
-- audience genuinely differ here -- unlike vaults, where they are the same.
drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles
  for select using (auth.uid() is not null);

drop policy if exists "own profile write" on public.profiles;
create policy "own profile write" on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Explicit, because Supabase projects from ~2026 grant NO DML on new tables.
-- RLS above would look correct and every request would still fail 42501, before
-- any policy is consulted. This bit an earlier round of this project.
grant select, insert, update, delete on public.profiles to authenticated;

-- Handles that must never be claimed by a user: they would let someone
-- impersonate the product or a support channel in a trade proposal.
create table if not exists public.reserved_handles (handle text primary key);
insert into public.reserved_handles (handle) values
  ('admin'), ('support'), ('help'), ('root'), ('system'), ('staff'), ('mod'),
  ('cardstock'), ('cardstash'), ('official'), ('security'), ('billing')
on conflict do nothing;

alter table public.reserved_handles enable row level security;
-- No policy and no grant: nothing but a definer function may read this.

/**
 * Claim or update your handle and display name.
 *
 * An RPC rather than a bare upsert so normalisation, the reserved list and the
 * uniqueness error all have one implementation. Returns the stored row.
 *
 * `security definer` is needed only to consult reserved_handles, which is
 * deliberately unreadable; the write still targets auth.uid() and nothing else,
 * so a caller cannot touch another user's row through it.
 */
create or replace function public.set_profile(p_handle text, p_display_name text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_handle text := lower(trim(p_handle));
  v_name   text := trim(p_display_name);
  result   public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if v_handle !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'bad_handle' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.reserved_handles where handle = v_handle) then
    raise exception 'handle_reserved' using errcode = 'P0001';
  end if;
  if v_name = '' or length(v_name) > 60 then
    raise exception 'bad_display_name' using errcode = 'P0001';
  end if;

  insert into public.profiles (user_id, handle, display_name)
    values (auth.uid(), v_handle, v_name)
  on conflict (user_id) do update
    set handle = excluded.handle,
        display_name = excluded.display_name,
        updated_at = now()
  returning * into result;

  return result;
exception
  -- A taken handle is an ordinary, expected outcome -- the UI needs to tell
  -- the user to pick another one, not show a Postgres constraint name.
  when unique_violation then
    raise exception 'handle_taken' using errcode = 'P0001';
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC, which would expose a
-- definer function to anonymous callers. Revoke, then grant narrowly.
revoke execute on function public.set_profile(text, text) from public, anon;
grant  execute on function public.set_profile(text, text) to authenticated;

-- Rollback:
--   drop function if exists public.set_profile(text, text);
--   drop table if exists public.reserved_handles;
--   drop table if exists public.profiles;
