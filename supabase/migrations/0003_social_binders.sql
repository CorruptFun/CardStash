-- Hosted social, part 3 of 4: published binders, and who may read them.
--
-- WHAT THIS REPLACES. `PUT /v1/binders/:id` on the self-hosted box, which
-- published to a server whose entire trust model was "anyone who can reach the
-- port". Here the read audience is a policy, and it is derived from a control
-- the user already understands.
--
-- ============================ THE VISIBILITY RULE ============================
--
-- Scope drives visibility. The existing "For trade / Everything" toggle in
-- FriendsView is reused as the privacy control rather than adding a second one
-- next to it:
--
--   scope = 'trade'  -> readable by ANY signed-in user.
--                       You published a list of cards you want to swap. Being
--                       findable is the entire purpose; this is what makes the
--                       global want-matching below possible at all.
--
--   scope = 'all'    -> readable by ACCEPTED FRIENDS ONLY.
--                       A full collection inventory is a valuation target and
--                       a theft target. It is never world-readable, whatever
--                       else is switched on.
--
-- Two consequences that must survive any later edit:
--   * Only scope='trade' publishers enter the trade_offers index below. A
--     friends-only binder must not be globally matchable through a side door.
--   * Switching 'all' -> 'trade' WIDENS the audience of a document the user
--     already uploaded. publish_binder() therefore rebuilds the row and the
--     index together, and the client must say plainly which audience it is
--     about to publish to.
--
-- ENCRYPTION, AND WHY THIS TABLE IS NOT. `vaults` (0000) holds ciphertext this
-- database cannot read, and that is non-negotiable for a user's own
-- collection. It cannot be how social works: a friend's app has to READ your
-- binder, so the server has to serve something readable. This table is the
-- narrow, deliberate exception -- it holds ONLY what the user chose to publish,
-- which is the same document that already travels in a share link today. The
-- vault is untouched by anything here, and a user may run either feature
-- without the other.

create table if not exists public.binders (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  scope       text not null check (scope in ('trade', 'all')),
  -- The ProfilePayload wire shape, verbatim -- the same document encoded into
  -- `#/x?d=…` links, carrying app: 'cardstock-social'. Stored whole rather
  -- than normalised because the client re-sanitizes it on arrival regardless
  -- (decision 7), so a decomposed copy would add a second shape to validate
  -- without removing the need to validate the first.
  payload     jsonb not null,
  -- Denormalised so the friends list renders without downloading every
  -- friend's cards. Written by publish_binder(), never by the client.
  card_count  integer not null default 0,
  want_count  integer not null default 0,
  -- Cheap freshness check: a friend polls this and skips the payload entirely
  -- when it has not moved. Mirrors the `exportedAt` test sync.ts already uses.
  revision    bigint not null default 1,
  updated_at  timestamptz not null default now()
);

create index if not exists binders_scope_idx on public.binders (scope, updated_at desc);

alter table public.binders enable row level security;

-- Multiple permissive SELECT policies OR together, which is exactly the rule
-- above expressed as three cases. Keeping them separate rather than folding
-- them into one boolean keeps each audience independently reviewable.
drop policy if exists "read own binder" on public.binders;
create policy "read own binder" on public.binders
  for select using (auth.uid() = user_id);

drop policy if exists "read trade binders" on public.binders;
create policy "read trade binders" on public.binders
  for select using (scope = 'trade' and auth.uid() is not null);

drop policy if exists "read friends full binders" on public.binders;
create policy "read friends full binders" on public.binders
  for select using (scope = 'all' and public.are_friends(auth.uid(), user_id));

-- Writes go through publish_binder(), but the row still needs an owner write
-- policy: the RPC is `security invoker` (see below), so RLS applies inside it.
drop policy if exists "own binder write" on public.binders;
create policy "own binder write" on public.binders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.binders to authenticated;

-- ---------------------------------------------------------------- want index

-- One row per (publisher, card-level want key) for cards actually offered for
-- trade. This is what turns "matchmaking against friends whose binder I
-- imported" into "matchmaking against everyone", which is the one genuinely
-- new capability hosting buys and is impossible serverless.
--
-- Key shape is `${game}|${normalized name}`, identical to wantKeyFor() in
-- social.ts -- CARD-LEVEL, so any printing of a Charizard matches a want for
-- a Charizard. Matching on card ids instead would silently miss most hits.
create table if not exists public.trade_offers (
  user_id  uuid not null references auth.users(id) on delete cascade,
  want_key text not null check (length(want_key) between 3 and 240),
  game     text not null,
  name     text not null check (length(name) between 1 and 200),
  qty      integer not null default 1 check (qty between 1 and 9999),
  primary key (user_id, want_key)
);

create index if not exists trade_offers_key_idx on public.trade_offers (want_key);

alter table public.trade_offers enable row level security;

-- NO policy and NO grant to authenticated, deliberately. An index of who owns
-- what is the definition of a table that must not be enumerable: readable
-- means dumpable, and a dump of this is a shopping list for anyone deciding
-- who to rob. It is reachable ONLY through match_wants() below, which answers
-- one key at a time. That is a lookup oracle rather than a database -- a large
-- improvement over publishing the table, and honestly not perfection.

/**
 * Publish (or re-publish) my binder, and rebuild my entry in the want index to
 * match, atomically.
 *
 * One RPC rather than a table write plus an index write because the invariant
 * "only scope='trade' publishers are globally matchable" has to hold at every
 * instant. Two separate client calls would leave a window where a user who
 * just switched to friends-only is still in the global index.
 *
 * `security invoker` is deliberate: the function runs as the caller, so the
 * binder policies above still apply inside it and it cannot be used to write
 * someone else's row. It reaches trade_offers -- which grants nothing to
 * authenticated -- via the definer helper below.
 */
create or replace function public.publish_binder(
  p_scope      text,
  p_payload    jsonb,
  p_card_count integer,
  p_want_count integer,
  -- [{want_key, game, name, qty}] -- only the rows actually up for trade.
  p_offers     jsonb default '[]'::jsonb
)
returns public.binders
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  result public.binders;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if p_scope not in ('trade', 'all') then
    raise exception 'bad_scope' using errcode = 'P0001';
  end if;

  insert into public.binders (user_id, scope, payload, card_count, want_count)
    values (auth.uid(), p_scope, p_payload,
            greatest(0, coalesce(p_card_count, 0)),
            greatest(0, coalesce(p_want_count, 0)))
  on conflict (user_id) do update
    set scope      = excluded.scope,
        payload    = excluded.payload,
        card_count = excluded.card_count,
        want_count = excluded.want_count,
        revision   = public.binders.revision + 1,
        updated_at = now()
  returning * into result;

  -- Rebuild the index entry. A friends-only binder is removed from it
  -- entirely rather than merely hidden -- see the invariant at the top.
  perform public.replace_trade_offers(
    case when p_scope = 'trade' then p_offers else '[]'::jsonb end
  );

  return result;
end;
$$;

revoke execute on function public.publish_binder(text, jsonb, integer, integer, jsonb) from public, anon;
grant  execute on function public.publish_binder(text, jsonb, integer, integer, jsonb) to authenticated;

/**
 * Replace the caller's rows in the (ungranted) want index.
 *
 * Definer purely to reach trade_offers, and it hard-codes auth.uid() as the
 * only user_id it will ever touch -- so being definer buys access to the
 * table, never access to another user's rows.
 */
create or replace function public.replace_trade_offers(p_offers jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;

  delete from public.trade_offers where user_id = auth.uid();

  insert into public.trade_offers (user_id, want_key, game, name, qty)
  select auth.uid(),
         left(row_value->>'want_key', 240),
         left(coalesce(row_value->>'game', ''), 20),
         left(coalesce(row_value->>'name', ''), 200),
         least(9999, greatest(1, coalesce((row_value->>'qty')::integer, 1)))
    from jsonb_array_elements(coalesce(p_offers, '[]'::jsonb)) as row_value
   where coalesce(row_value->>'want_key', '') <> ''
     and coalesce(row_value->>'name', '') <> ''
   -- A binder with two printings of one card yields one index row; the client
   -- sends card-level keys, but never trust it to have deduped them.
   on conflict (user_id, want_key) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.replace_trade_offers(jsonb) from public, anon;
grant  execute on function public.replace_trade_offers(jsonb) to authenticated;

/**
 * "Who has the cards I am hunting?"
 *
 * Takes the caller's want keys and returns, per key, who is offering it. Only
 * ever surfaces users whose binder is scope='trade' -- they published a list
 * asking to be found. The caller is excluded from their own results.
 *
 * Capped at 200 keys per call and 20 holders per key: this is a lookup, and an
 * uncapped version is an export of the index one query at a time.
 */
create or replace function public.match_wants(p_keys text[])
returns table (want_key text, user_id uuid, handle text, display_name text, qty integer)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  with keys as (
    select distinct k from unnest(coalesce(p_keys, array[]::text[])) as k limit 200
  ), ranked as (
    select o.want_key, o.user_id, p.handle, p.display_name, o.qty,
           row_number() over (partition by o.want_key order by b.updated_at desc) as rn
      from public.trade_offers o
      join keys      k on k.k = o.want_key
      join public.binders  b on b.user_id = o.user_id and b.scope = 'trade'
      join public.profiles p on p.user_id = o.user_id
     where o.user_id <> auth.uid()
       and auth.uid() is not null
  )
  select want_key, user_id, handle, display_name, qty from ranked where rn <= 20;
$$;

revoke execute on function public.match_wants(text[]) from public, anon;
grant  execute on function public.match_wants(text[]) to authenticated;

/** Stop publishing: drops the binder row and every index entry with it. */
create or replace function public.unpublish_binder()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  delete from public.trade_offers where user_id = auth.uid();
  delete from public.binders where user_id = auth.uid();
end;
$$;

revoke execute on function public.unpublish_binder() from public, anon;
grant  execute on function public.unpublish_binder() to authenticated;

-- Rollback:
--   drop function if exists public.unpublish_binder();
--   drop function if exists public.match_wants(text[]);
--   drop function if exists public.replace_trade_offers(jsonb);
--   drop function if exists public.publish_binder(text, jsonb, integer, integer, jsonb);
--   drop table if exists public.trade_offers;
--   drop table if exists public.binders;
