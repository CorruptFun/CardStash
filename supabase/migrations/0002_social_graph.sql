-- Hosted social, part 2 of 4: the friend graph.
--
-- WHAT THIS REPLACES. Today a "friend" is a one-way snapshot you imported from
-- a link: they have no idea you follow them, there is no reciprocity, and the
-- only way they see your binder is if you separately send them yours. This
-- makes the edge mutual and consented, which is also what 0003 needs in order
-- to answer "may this person read my full collection?".
--
-- SHAPE. One row per PAIR, not per direction. `requester`/`addressee` record
-- who asked, which is what the UI needs to show "waiting on them" vs "needs
-- your answer" -- exactly the distinction tradeStatusLabel() already draws for
-- trades. Friendship itself is undirected: are_friends(a,b) checks both column
-- orders, so there is never a half-accepted state to reconcile.

create table if not exists public.friendships (
  requester  uuid not null references auth.users(id) on delete cascade,
  addressee  uuid not null references auth.users(id) on delete cascade,
  -- pending  -> requester asked, addressee has not answered
  -- accepted -> mutual; unlocks scope='all' binder reads in 0003
  -- blocked  -> addressee refused; kept as a row so the requester cannot
  --             simply re-ask in a loop. Never decays back to pending.
  status     text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (requester, addressee),
  constraint no_self_friendship check (requester <> addressee)
);

-- "Who are my friends" is asked from both sides on every binder read, so both
-- column orders need an index; the primary key only covers (requester, ...).
create index if not exists friendships_addressee_idx
  on public.friendships (addressee, status);

alter table public.friendships enable row level security;

-- You may see any edge you are an endpoint of, and nothing else. Note these
-- policies compare auth.uid() DIRECTLY and never call are_friends() -- a
-- policy on friendships that consulted a function reading friendships would
-- recurse, and the failure mode is an infinite loop inside the planner rather
-- than a clean error.
drop policy if exists "see own edges" on public.friendships;
create policy "see own edges" on public.friendships
  for select using (auth.uid() in (requester, addressee));

-- Only the requester may create the edge, and only as themselves. Status is
-- forced to 'pending' by the RPC below; a client that INSERTs directly could
-- otherwise write status='accepted' and befriend itself into someone's full
-- collection.
drop policy if exists "request as self" on public.friendships;
create policy "request as self" on public.friendships
  for insert with check (auth.uid() = requester and status = 'pending');

-- Answering is the addressee's privilege alone. The requester must NOT be able
-- to flip their own pending row to accepted -- that is the whole consent gate.
drop policy if exists "answer as addressee" on public.friendships;
create policy "answer as addressee" on public.friendships
  for update using (auth.uid() = addressee) with check (auth.uid() = addressee);

-- Either side may walk away.
drop policy if exists "unfriend either side" on public.friendships;
create policy "unfriend either side" on public.friendships
  for delete using (auth.uid() in (requester, addressee));

grant select, insert, update, delete on public.friendships to authenticated;

/**
 * Are these two accepted friends?
 *
 * `security definer` because 0003's binder read policy calls this while
 * evaluating a SELECT for a user who, by construction, cannot see the
 * friendship row from the other side. An invoker function would be filtered by
 * the caller's own RLS and quietly return false, making every friends-only
 * binder unreadable -- a failure that looks like a broken policy.
 *
 * `set search_path` is mandatory on any definer function: without it the
 * function resolves `friendships` against the caller's search_path and can be
 * pointed at an attacker-created table of the same name.
 */
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester = a and f.addressee = b)
        or (f.requester = b and f.addressee = a))
  );
$$;

revoke execute on function public.are_friends(uuid, uuid) from public, anon;
grant  execute on function public.are_friends(uuid, uuid) to authenticated;

/**
 * Send a friend request by handle -- the thing that replaces pasting a
 * 20,000-character link.
 *
 * Definer so it can resolve a handle to a user id and detect an existing
 * reverse-direction edge, neither of which the caller can necessarily see.
 * Auto-accepts when the other person already asked you: two people who each
 * send a request should end up friends, not deadlocked in mutual pending.
 */
create or replace function public.request_friend(p_handle text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target uuid;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;

  select user_id into v_target from public.profiles where handle = lower(trim(p_handle));
  if v_target is null then
    raise exception 'no_such_handle' using errcode = 'P0001';
  end if;
  if v_target = auth.uid() then
    raise exception 'cannot_friend_self' using errcode = 'P0001';
  end if;

  -- They asked first: accept instead of creating a mirrored pending row.
  select status into v_status from public.friendships
    where requester = v_target and addressee = auth.uid();
  if v_status = 'blocked' then
    -- Deliberately indistinguishable from success to the caller: telling
    -- someone they have been blocked invites them to make a new account.
    return 'pending';
  end if;
  if v_status is not null then
    update public.friendships set status = 'accepted', updated_at = now()
      where requester = v_target and addressee = auth.uid();
    return 'accepted';
  end if;

  insert into public.friendships (requester, addressee, status)
    values (auth.uid(), v_target, 'pending')
  on conflict (requester, addressee) do nothing;

  return 'pending';
end;
$$;

revoke execute on function public.request_friend(text) from public, anon;
grant  execute on function public.request_friend(text) to authenticated;

-- Rollback:
--   drop function if exists public.request_friend(text);
--   drop function if exists public.are_friends(uuid, uuid);
--   drop table if exists public.friendships;
