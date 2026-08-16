-- 0020_custom_binders.sql
--
-- Binders the user builds by hand, each with its own audience.
--
-- WHY A SIBLING TABLE AND NOT A WIDER `binders`. `binders` (0003) is keyed
-- `primary key (user_id)` — one row, the whole-collection binder — and four
-- things read that shape today: `pullFriends`, `match_wants`, the
-- `send_to_inbox` reachability check, and `can_message` (0019). Re-keying it
-- to (user_id, binder_id) would touch every one of them and re-do the RLS
-- harness for a feature that only ADDS a case. So the main binder is left
-- exactly as it is and custom binders are a sibling that expresses the same
-- visibility rule the same way.
--
-- THE VISIBILITY RULE, one level down. 0003's rule is scope-drives-visibility;
-- here the control is explicit rather than inferred from what is being shared:
--
--   visibility = 'public'  -> readable by ANY SIGNED-IN USER. Never anon.
--   visibility = 'friends' -> readable by ACCEPTED FRIENDS only.
--   (private never reaches this table at all — the client does not upload it.)
--
-- `public` deliberately stops at signed-in. A binder readable by `anon` is a
-- binder anyone holding the publishable key can enumerate, which is a list of
-- valuable cards attached to a handle — the exact thing `trade_offers` refuses
-- to be. Decision 26 records that, and it is a decision to revisit
-- deliberately rather than by loosening a policy here.
--
-- AND `tradeable` IS A SECOND SWITCH, not a synonym. Only a binder that is
-- BOTH public and tradeable enters the global want index. Friends-only never
-- does — that is 0003's invariant ("a friends-only binder must not be globally
-- matchable through a side door") holding for these too — and a public binder
-- that is merely on display is a display case, not an offer.
--
-- WHAT CHANGES OUTSIDE THIS TABLE, and why each is unavoidable:
--   * `trade_offers` gains `source`, because two publishers per user now feed
--     it and `replace_trade_offers` deletes wholesale. Without it, publishing
--     a binder would evict the main binder's offers and vice versa.
--   * `match_wants` must accept an offer from either publisher, and must still
--     refuse one whose publisher has gone friends-only.
--   * reachability (`send_to_inbox`, `can_message`) must count a public
--     tradeable binder, or "make this binder public and tradeable" produces
--     offers nobody is allowed to ask you about.
--   * `erase_social()` must take these with it.
--
-- ROLLBACK:
--   drop function if exists public.unpublish_custom_binder(text);
--   drop function if exists public.publish_custom_binder(text, text, text, text, boolean, jsonb, integer, jsonb);
--   drop table if exists public.custom_binders;
--   alter table public.trade_offers drop column source, drop column updated_at;
--   (and re-apply 0003's replace_trade_offers/match_wants, 0004's
--    send_to_inbox, 0019's can_message and erase_social, which this replaces)

/* --------------------------------------------------------------- the table */

create table if not exists public.custom_binders (
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- The client's own binder id, so the row is stable across devices and
  -- re-publishes. Text rather than uuid because it is minted by `uid()` on the
  -- device, the same id space `profileId` and trade ids already use.
  binder_id  text not null check (length(binder_id) between 1 and 64),
  name       text not null check (length(name) between 1 and 60),
  note       text check (length(note) <= 400),
  visibility text not null check (visibility in ('friends', 'public')),
  tradeable  boolean not null default false,
  -- The BinderPayload wire shape, verbatim — the same document a `#/x?d=…`
  -- link carries. Stored whole for 0003's reason: the client re-sanitizes it
  -- on arrival regardless (decision 7), so a decomposed copy would add a
  -- second shape to validate without removing the need to validate the first.
  payload    jsonb not null,
  card_count integer not null default 0,
  revision   bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, binder_id)
);

-- "Every binder these friends publish", which is how the poller reads them.
create index if not exists custom_binders_user_idx on public.custom_binders (user_id, updated_at desc);

alter table public.custom_binders enable row level security;

-- Three permissive SELECT policies that OR together, kept separate rather than
-- folded into one boolean so each audience is independently reviewable — the
-- same shape 0003 uses, for the same reason.
drop policy if exists "read own custom binders" on public.custom_binders;
create policy "read own custom binders" on public.custom_binders
  for select using (auth.uid() = user_id);

drop policy if exists "read public custom binders" on public.custom_binders;
create policy "read public custom binders" on public.custom_binders
  for select using (visibility = 'public' and auth.uid() is not null);

drop policy if exists "read friends custom binders" on public.custom_binders;
create policy "read friends custom binders" on public.custom_binders
  for select using (visibility = 'friends' and public.are_friends(auth.uid(), user_id));

-- No write policy and no write grant: `publish_custom_binder` is the only door,
-- because the row and its want-index entry have to move together (below).
revoke all on public.custom_binders from public, anon, authenticated;
grant  select on public.custom_binders to authenticated;

/* ------------------------------------------------ the want index, per source */

-- Which publisher an offer came from: '' is the main binder (0003), anything
-- else is a custom binder's id. Without this, `replace_trade_offers` — which
-- deletes every row the caller owns — would make publishing one thing evict
-- the other.
alter table public.trade_offers add column if not exists source text not null default '';
-- Ranking used to come from `binders.updated_at`; with two publishers the
-- offer row carries its own freshness instead.
alter table public.trade_offers add column if not exists updated_at timestamptz not null default now();

alter table public.trade_offers drop constraint if exists trade_offers_pkey;
alter table public.trade_offers add primary key (user_id, source, want_key);

/**
 * Replace the caller's rows FOR ONE PUBLISHER in the (ungranted) want index.
 *
 * Was one-argument; the old signature is dropped rather than kept alongside,
 * because a defaulted second parameter would make the one-argument call
 * ambiguous and every publish would fail at runtime with a resolution error.
 *
 * Definer purely to reach `trade_offers`, and it still hard-codes auth.uid()
 * as the only user_id it will ever touch — so being definer buys access to the
 * table, never access to another user's rows.
 */
drop function if exists public.replace_trade_offers(jsonb);

create or replace function public.replace_trade_offers(p_offers jsonb, p_source text default '')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source text := left(coalesce(p_source, ''), 64);
  v_count  integer;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;

  delete from public.trade_offers where user_id = auth.uid() and source = v_source;

  insert into public.trade_offers (user_id, source, want_key, game, name, qty, updated_at)
  select auth.uid(),
         v_source,
         left(row_value->>'want_key', 240),
         left(coalesce(row_value->>'game', ''), 20),
         left(coalesce(row_value->>'name', ''), 200),
         least(9999, greatest(1, coalesce((row_value->>'qty')::integer, 1))),
         now()
    from jsonb_array_elements(coalesce(p_offers, '[]'::jsonb)) as row_value
   where coalesce(row_value->>'want_key', '') <> ''
     and coalesce(row_value->>'name', '') <> ''
   on conflict (user_id, source, want_key) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.replace_trade_offers(jsonb, text) from public, anon;
grant  execute on function public.replace_trade_offers(jsonb, text) to authenticated;

/**
 * 0003's `publish_binder`, re-pointed at the two-argument replacer.
 *
 * Identical otherwise, and it still rebuilds row and index in ONE call so the
 * invariant "only a discoverable publisher is globally matchable" holds at
 * every instant. It names its own source explicitly ('') rather than leaning
 * on a default, so the day a third publisher appears this reads as a choice.
 */
create or replace function public.publish_binder(
  p_scope      text,
  p_payload    jsonb,
  p_card_count integer,
  p_want_count integer,
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

  perform public.replace_trade_offers(
    case when p_scope = 'trade' then p_offers else '[]'::jsonb end,
    ''
  );

  return result;
end;
$$;

revoke all on function public.publish_binder(text, jsonb, integer, integer, jsonb) from public, anon;
grant  execute on function public.publish_binder(text, jsonb, integer, integer, jsonb) to authenticated;

/**
 * 0003's `unpublish_binder`, narrowed to the main binder's own offers.
 *
 * It used to delete every offer row the caller had, which was the same thing
 * when there was one publisher and is now a bug: taking your collection binder
 * down must not silently empty the binders you deliberately published.
 */
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
  delete from public.trade_offers where user_id = auth.uid() and source = '';
  delete from public.binders where user_id = auth.uid();
end;
$$;

revoke all on function public.unpublish_binder() from public, anon;
grant  execute on function public.unpublish_binder() to authenticated;

/* --------------------------------------------------------------- publishing */

/**
 * Publish (or re-publish) one custom binder, and rebuild its slice of the want
 * index to match, atomically.
 *
 * `security definer` — unlike `publish_binder`, which is invoker — because
 * `custom_binders` grants `authenticated` no write at all. It hard-codes
 * auth.uid() as the only user_id it writes, so definer buys access to the
 * table and never access to another user's row.
 *
 * The index slice follows `visibility = 'public' AND tradeable`, computed
 * HERE rather than trusted from the caller, so a client cannot publish a
 * friends-only binder into the global index by sending offers with it.
 */
create or replace function public.publish_custom_binder(
  p_binder_id  text,
  p_name       text,
  p_note       text,
  p_visibility text,
  p_tradeable  boolean,
  p_payload    jsonb,
  p_card_count integer,
  p_offers     jsonb default '[]'::jsonb
)
returns public.custom_binders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id     text := left(trim(coalesce(p_binder_id, '')), 64);
  v_name   text := left(trim(coalesce(p_name, '')), 60);
  v_pub    boolean;
  result   public.custom_binders;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if v_id = '' then
    raise exception 'bad_binder' using errcode = 'P0001';
  end if;
  if v_name = '' then
    raise exception 'bad_binder_name' using errcode = 'P0001';
  end if;
  -- 'private' is not a value this table holds: a private binder is one that
  -- was never uploaded, and accepting it here would mean the server storing a
  -- copy of something the user said to keep on their device.
  if p_visibility not in ('friends', 'public') then
    raise exception 'bad_visibility' using errcode = 'P0001';
  end if;
  if pg_column_size(p_payload) > 1048576 then
    raise exception 'payload_too_large' using errcode = 'P0001';
  end if;
  -- A binder is a selection. Somebody publishing forty of them is organising;
  -- somebody publishing four hundred is using this as a second collection
  -- table, which is what `binders` already is.
  if (select count(*) from public.custom_binders
       where user_id = auth.uid() and binder_id <> v_id) >= 40 then
    raise exception 'too_many_binders' using errcode = 'P0001';
  end if;

  insert into public.custom_binders
      (user_id, binder_id, name, note, visibility, tradeable, payload, card_count)
    values (auth.uid(), v_id, v_name, left(nullif(trim(coalesce(p_note, '')), ''), 400),
            p_visibility, coalesce(p_tradeable, false), p_payload,
            greatest(0, coalesce(p_card_count, 0)))
  on conflict (user_id, binder_id) do update
    set name       = excluded.name,
        note       = excluded.note,
        visibility = excluded.visibility,
        tradeable  = excluded.tradeable,
        payload    = excluded.payload,
        card_count = excluded.card_count,
        revision   = public.custom_binders.revision + 1,
        updated_at = now()
  returning * into result;

  v_pub := result.visibility = 'public' and result.tradeable;
  perform public.replace_trade_offers(
    case when v_pub then coalesce(p_offers, '[]'::jsonb) else '[]'::jsonb end,
    v_id
  );

  return result;
end;
$$;

revoke all on function public.publish_custom_binder(text, text, text, text, boolean, jsonb, integer, jsonb) from public, anon;
grant  execute on function public.publish_custom_binder(text, text, text, text, boolean, jsonb, integer, jsonb) to authenticated;

/** Take one binder down: the row and its index slice, together. */
create or replace function public.unpublish_custom_binder(p_binder_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text := left(trim(coalesce(p_binder_id, '')), 64);
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  delete from public.trade_offers where user_id = auth.uid() and source = v_id;
  delete from public.custom_binders where user_id = auth.uid() and binder_id = v_id;
end;
$$;

revoke all on function public.unpublish_custom_binder(text) from public, anon;
grant  execute on function public.unpublish_custom_binder(text) to authenticated;

/* ----------------------------------------------------------- global matching */

/**
 * 0003's `match_wants`, taught about the second publisher.
 *
 * The join to `binders` was what guaranteed eviction when someone flipped to
 * friends-only; with two publishers that becomes a per-source check, and the
 * guarantee is the same: an offer is only ever surfaced while the publisher it
 * came from is still discoverable. A friends-only custom binder is no more
 * globally matchable than a friends-only collection binder.
 *
 * Still capped at 200 keys and 20 holders per key, and one row per holder per
 * key — two of my binders offering the same card is one answer to "who has
 * this", not two.
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
  ), live as (
    select o.want_key, o.user_id, o.qty, o.updated_at
      from public.trade_offers o
      join keys k on k.k = o.want_key
     where o.user_id <> auth.uid()
       and auth.uid() is not null
       and (
         (o.source = '' and exists (
            select 1 from public.binders b
             where b.user_id = o.user_id and b.scope = 'trade'))
         or (o.source <> '' and exists (
            select 1 from public.custom_binders c
             where c.user_id = o.user_id and c.binder_id = o.source
               and c.visibility = 'public' and c.tradeable))
       )
  ), per_holder as (
    -- One row per (key, holder): the freshest publisher wins the qty it
    -- reports, rather than the same collector appearing once per binder.
    select distinct on (l.want_key, l.user_id)
           l.want_key, l.user_id, l.qty, l.updated_at
      from live l
     order by l.want_key, l.user_id, l.updated_at desc
  ), ranked as (
    select h.want_key, h.user_id, p.handle, p.display_name, h.qty,
           row_number() over (partition by h.want_key order by h.updated_at desc) as rn
      from per_holder h
      join public.profiles p on p.user_id = h.user_id
  )
  select want_key, user_id, handle, display_name, qty from ranked where rn <= 20;
$$;

revoke all on function public.match_wants(text[]) from public, anon;
grant  execute on function public.match_wants(text[]) to authenticated;

/* -------------------------------------------------------------- reachability */

/**
 * 0019's `can_message`, taught the same lesson.
 *
 * Publishing a public tradeable binder is advertising cards for swap, so being
 * reachable about them is the point — the identical argument `send_to_inbox`
 * makes about a `scope='trade'` binder. Without this clause, "make this binder
 * public and tradeable" produces offers in the global index that nobody is
 * permitted to ask you about, which is the feature failing quietly.
 */
create or replace function public.can_message(p_to uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null and p_to is not null and p_to <> auth.uid() and (
    public.are_friends(auth.uid(), p_to)
    or exists (select 1 from public.binders b where b.user_id = p_to and b.scope = 'trade')
    or exists (select 1 from public.custom_binders c
                where c.user_id = p_to and c.visibility = 'public' and c.tradeable)
    or exists (
      select 1
        from public.messages m
        join public.message_threads t on t.id = m.thread_id
       where m.sender = p_to
         and auth.uid() in (t.user_lo, t.user_hi)
         and p_to      in (t.user_lo, t.user_hi)
    )
  );
$$;

revoke all on function public.can_message(uuid) from public, anon;
grant  execute on function public.can_message(uuid) to authenticated;

/** 0004's `send_to_inbox`, with the same clause added to its reachability. */
create or replace function public.send_to_inbox(p_recipient uuid, p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allowed boolean;
  v_pending integer;
  v_id      bigint;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if p_recipient is null or p_recipient = auth.uid() then
    raise exception 'bad_recipient' using errcode = 'P0001';
  end if;
  if pg_column_size(p_payload) > 1048576 then
    raise exception 'payload_too_large' using errcode = 'P0001';
  end if;

  select public.are_friends(auth.uid(), p_recipient)
      or exists (select 1 from public.binders b
                  where b.user_id = p_recipient and b.scope = 'trade')
      or exists (select 1 from public.custom_binders c
                  where c.user_id = p_recipient and c.visibility = 'public' and c.tradeable)
    into v_allowed;
  if not v_allowed then
    raise exception 'not_reachable' using errcode = 'P0001';
  end if;

  select count(*) into v_pending
    from public.inbox
   where recipient = p_recipient and sender = auth.uid();
  if v_pending >= 20 then
    raise exception 'inbox_full' using errcode = 'P0001';
  end if;

  insert into public.inbox (recipient, sender, payload)
    values (p_recipient, auth.uid(), p_payload)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.send_to_inbox(uuid, jsonb) from public, anon;
grant  execute on function public.send_to_inbox(uuid, jsonb) to authenticated;

/* --------------------------------------------------------------- erasure */

/**
 * 0019's `erase_social()`, extended to take custom binders with it.
 *
 * Replaced in full rather than supplemented for the reason 0019 gave: Settings
 * → Erase must be ONE call that leaves nothing behind, and a second RPC the
 * client could forget to make is how a "delete everything" button becomes a
 * lie. Still leaves `vaults` and `orders` alone.
 */
create or replace function public.erase_social()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  delete from public.message_threads where auth.uid() in (user_lo, user_hi);
  delete from public.trade_offers   where user_id = auth.uid();
  delete from public.custom_binders where user_id = auth.uid();
  delete from public.binders        where user_id = auth.uid();
  delete from public.inbox          where recipient = auth.uid() or sender = auth.uid();
  delete from public.friendships    where auth.uid() in (requester, addressee);
  delete from public.profiles       where user_id = auth.uid();
end;
$$;

revoke all on function public.erase_social() from public, anon;
grant  execute on function public.erase_social() to authenticated;
