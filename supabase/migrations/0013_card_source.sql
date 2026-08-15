-- 0013_card_source.sql
--
-- The card index the catalogs do not have.
--
-- WHY THIS EXISTS. Every card in this app comes from somebody else's catalog,
-- and those catalogs have two holes that no amount of client work can close:
-- rows with no picture (TCGCSV ships them constantly, and a binder of grey
-- rectangles reads as a broken app), and cards that are in no catalog at all
-- (regional promos, prereleases, error prints, anything the APIs have not
-- caught up with). `cardpatch.ts` lets a user fix both on their own device.
-- This table is what turns thousands of those private fixes into an answer the
-- NEXT person gets for free — the app becoming a source of card data rather
-- than only a consumer of five.
--
-- THE TRUST MODEL, and the one asymmetry it turns on:
--
--   * READING IS ANONYMOUS. `lookup_card_data()` is granted to `anon`, called
--     with the publishable key and never the session JWT — the same rule
--     decision 20 pins for diagnostics, for the same reason: what card someone
--     is looking at must not become a row tied to their account. It also has
--     to work signed out, because the entire free path is signed out and a
--     picture that only appears once you have an account is a picture behind a
--     login.
--   * WRITING IS NOT. `submit_card_data()` requires `auth.uid()`. Contributing
--     is the only operation here that can hurt anyone — a wrong picture on a
--     card propagates to every device that asks — so it is attributable, rate
--     limited, and capped at one live row per person per card. An anonymous
--     write grant would make this table a defacement target with no recourse.
--
-- NOBODY TOUCHES THESE TABLES DIRECTLY. `revoke all` then grants back exactly
-- what the RPCs need (the 0009/0010/0011 convention). The functions are the
-- only door: they validate shape, cap sizes, enforce the rate limit, and — the
-- part a policy could not do — never return `submitted_by` to anyone.
--
-- IMAGES ARE BYTES IN A COLUMN, NOT OBJECTS IN A BUCKET. Storage would mean a
-- second auth model, a second client, a second thing to make public, and
-- signed URLs that expire inside an app built to work offline. The client
-- already bounds every image to ~220 KB of base64 (`cardimage.ts`) because the
-- same bytes ride the JSON backup and the vault; a text column with a hard cap
-- keeps one transport, one grant model, and one thing to reason about.
--
-- ROLLBACK:
--   drop function if exists public.flag_card_data(text);
--   drop function if exists public.lookup_card_data(text[]);
--   drop function if exists public.submit_card_data(text, text, jsonb, text, text, boolean);
--   drop table if exists public.card_data_flags;
--   drop table if exists public.card_data;

/* --------------------------------------------------------------- the table */

create table if not exists public.card_data (
  id uuid primary key default gen_random_uuid(),
  /** `${game}:${apiId}` — the same id space the app uses everywhere. */
  card_id text not null,
  /** One of GAMES in games.ts. Denormalized off card_id for cheap filtering. */
  game text not null,
  /** The patchable subset of Card: name, set, number, rarity, type line, text. */
  fields jsonb not null default '{}'::jsonb,
  /** `data:image/(webp|jpeg|png);base64,…`, bounded by the check below. */
  image text,
  /** Client-side fingerprint of `image` — dedupes the same photo re-sent. */
  image_hash text,
  /** This card exists in no catalog; the submission IS the card. */
  custom boolean not null default false,
  /**
   * Who contributed it. Never returned by any function here — it exists so a
   * bad actor can be found and their rows dropped, which is the only reason
   * writes are authenticated at all. `on delete set null`: a deleted account
   * does not take the card data other people now depend on with it.
   */
  submitted_by uuid references auth.users(id) on delete set null,
  /** Times someone said this is wrong. Three hides the row from lookups. */
  flags integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ~220 KB of base64 is the client's own ceiling (MAX_IMAGE_BYTES); the extra
  -- headroom covers a client that encodes marginally differently. A row past
  -- this is not something cardimage.ts produced.
  constraint card_data_image_len check (image is null or length(image) <= 300000),
  constraint card_data_fields_len check (length(fields::text) <= 4000)
);

comment on table public.card_data is
  'Community-contributed card images and metadata. Readable anonymously through lookup_card_data(); writable only through submit_card_data(). No role holds direct DML.';

/**
 * One live row per person per card.
 *
 * This is the anti-spam shape, and it is deliberately not "one row per card":
 * a single global row would make the index first-write-wins, where the first
 * blurry photo of a card could never be improved on. Per-submitter rows let a
 * better contribution exist beside a worse one and let `lookup_card_data()`
 * choose, while still stopping one account from burying a card under fifty
 * submissions.
 */
create unique index if not exists card_data_card_submitter_idx
  on public.card_data (card_id, submitted_by);

-- The lookup path: by card, best row first.
create index if not exists card_data_card_idx
  on public.card_data (card_id, flags, updated_at desc);

-- The rate limiter counts one account's recent rows.
create index if not exists card_data_submitter_recent_idx
  on public.card_data (submitted_by, created_at desc);

alter table public.card_data enable row level security;
-- No policies, deliberately: RLS with none denies every role that does not
-- bypass it, so the security-definer functions below are the only route in.
revoke all on public.card_data from public, anon, authenticated;

/**
 * Who has already flagged what, so "this is wrong" is one vote per person
 * rather than a loop. Nothing reads this back over HTTP — it exists to make
 * `flag_card_data()` idempotent per account.
 */
create table if not exists public.card_data_flags (
  submission_id uuid not null references public.card_data(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  primary key (submission_id, user_id)
);

alter table public.card_data_flags enable row level security;
revoke all on public.card_data_flags from public, anon, authenticated;

/* ------------------------------------------------------------ contributing */

/**
 * Contribute a card image and/or its details.
 *
 * Upserts the caller's own row for that card, so re-submitting is how you fix
 * your own mistake rather than a way to make two. Returns the row id.
 *
 * Validation is here rather than in a check constraint because the honest
 * answer to a malformed submission is to store the good parts and drop the
 * rest — a user who typed one over-long field should not lose the photo they
 * took. The exceptions raised below are the cases where there is nothing left
 * worth storing.
 */
create or replace function public.submit_card_data(
  p_card_id text,
  p_game text,
  p_fields jsonb default '{}'::jsonb,
  p_image text default null,
  p_image_hash text default null,
  p_custom boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_id     uuid;
  v_recent integer;
  v_image  text;
  v_fields jsonb;
begin
  if v_user is null then
    raise exception 'not_signed_in';
  end if;

  p_card_id := nullif(trim(p_card_id), '');
  p_game    := nullif(trim(p_game), '');
  if p_card_id is null or p_game is null or length(p_card_id) > 120 then
    raise exception 'bad_card_id';
  end if;
  -- The id carries the game. A row claiming otherwise would file the card
  -- under the wrong game on every device that fetched it.
  if p_card_id not like p_game || ':%' then
    raise exception 'bad_card_id';
  end if;

  /**
   * RATE LIMIT. A person cataloguing their own collection might legitimately
   * fix a few dozen cards in a sitting; nobody fixes two hundred. Past this
   * the honest answer is to refuse loudly — unlike diagnostics, the client has
   * a user in front of it who can be told.
   */
  select count(*) into v_recent
  from public.card_data
  where submitted_by = v_user
    and created_at > now() - interval '24 hours';

  if v_recent >= 200 then
    raise exception 'rate_limited';
  end if;

  -- Only a bounded inline raster. Anything else -- a remote URL, an SVG, a
  -- javascript: scheme -- is dropped rather than stored, because every client
  -- that fetches this row will render it in an <img src>.
  v_image := case
    when p_image ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'
     and length(p_image) <= 300000
    then p_image
    else null
  end;

  v_fields := case
    when p_fields is null or jsonb_typeof(p_fields) <> 'object' then '{}'::jsonb
    when length(p_fields::text) > 4000 then '{}'::jsonb
    else p_fields
  end;

  -- Nothing to say about the card is not a submission.
  if v_image is null and v_fields = '{}'::jsonb then
    raise exception 'empty_submission';
  end if;

  insert into public.card_data (card_id, game, fields, image, image_hash, custom, submitted_by)
  values (p_card_id, p_game, v_fields, v_image, nullif(left(p_image_hash, 64), ''), coalesce(p_custom, false), v_user)
  on conflict (card_id, submitted_by) do update
    set fields     = excluded.fields,
        image      = coalesce(excluded.image, public.card_data.image),
        image_hash = coalesce(excluded.image_hash, public.card_data.image_hash),
        custom     = excluded.custom,
        updated_at = now(),
        -- A correction clears the flags against the old version. Otherwise a
        -- contributor whose first attempt was wrong could never be un-hidden,
        -- and the index would have no path from bad data to good.
        flags      = 0
  returning id into v_id;

  return v_id;
end;
$$;

/* ---------------------------------------------------------------- reading */

/**
 * The best contribution for each of up to 200 cards.
 *
 * ANONYMOUS ON PURPOSE (see the header). It takes ids and returns card facts;
 * it never sees or returns who asked, and it never returns who contributed.
 *
 * "Best" is: not hidden, then fewest flags, then most recently updated. A row
 * with an image outranks one without, because a card with a name and no
 * picture is the exact problem this table exists to solve.
 */
create or replace function public.lookup_card_data(p_ids text[])
returns table (
  card_id text,
  game text,
  fields jsonb,
  image text,
  image_hash text,
  custom boolean,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct on (d.card_id)
    d.card_id, d.game, d.fields, d.image, d.image_hash, d.custom, d.updated_at
  from public.card_data d
  where d.card_id = any (coalesce(p_ids, '{}')::text[])
    and d.flags < 3
  order by
    d.card_id,
    (d.image is null),
    d.flags,
    d.updated_at desc
  limit 200;
$$;

/**
 * Search the index by name for cards no catalog lists.
 *
 * Only `custom` rows: everything else is already searchable through its own
 * catalog, and returning those would put a stranger's edit of a Scryfall card
 * into search results beside the real one.
 */
create or replace function public.search_card_data(p_game text, p_query text)
returns table (
  card_id text,
  game text,
  fields jsonb,
  image text,
  image_hash text,
  custom boolean,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct on (d.card_id)
    d.card_id, d.game, d.fields, d.image, d.image_hash, d.custom, d.updated_at
  from public.card_data d
  where d.custom
    and d.flags < 3
    and (p_game is null or d.game = p_game)
    and length(coalesce(p_query, '')) between 2 and 80
    and d.fields->>'name' ilike '%' || p_query || '%'
  order by d.card_id, (d.image is null), d.flags, d.updated_at desc
  limit 40;
$$;

/* --------------------------------------------------------------- moderation */

/**
 * Say a contribution is wrong. One vote per account; three hides the row.
 *
 * Takes the card id rather than a submission id, because the client was handed
 * card facts and never learns which row they came from — flagging is "this
 * picture is not this card", which is the only judgement a user is in a
 * position to make.
 */
create or replace function public.flag_card_data(p_card_id text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'not_signed_in';
  end if;

  -- The row this caller would have been served, by the same ranking.
  select d.id into v_id
  from public.card_data d
  where d.card_id = p_card_id and d.flags < 3
  order by (d.image is null), d.flags, d.updated_at desc
  limit 1;

  if v_id is null then
    return false;
  end if;

  insert into public.card_data_flags (submission_id, user_id)
  values (v_id, v_user)
  on conflict do nothing;

  if not found then
    -- Already flagged by this account: idempotent, not an error.
    return true;
  end if;

  update public.card_data
    set flags = (select count(*) from public.card_data_flags f where f.submission_id = v_id)
  where id = v_id;

  return true;
end;
$$;

/* ------------------------------------------------------------------ grants */

-- Reading is the anonymous half, writing is not. See the header.
revoke all on function public.lookup_card_data(text[])                                from public;
revoke all on function public.search_card_data(text, text)                            from public;
revoke all on function public.submit_card_data(text, text, jsonb, text, text, boolean) from public;
revoke all on function public.flag_card_data(text)                                    from public;

grant execute on function public.lookup_card_data(text[])     to anon, authenticated;
grant execute on function public.search_card_data(text, text) to anon, authenticated;
grant execute on function public.submit_card_data(text, text, jsonb, text, text, boolean) to authenticated;
grant execute on function public.flag_card_data(text)         to authenticated;

-- service_role keeps direct access for moderation: dropping a bad
-- contributor's rows is a support action, not an app feature.
grant select, update, delete on public.card_data       to service_role;
grant select, delete         on public.card_data_flags to service_role;

/* ------------------------------------------- the diagnostics whitelist, again */

-- `ingest_events()` (0007) matches event names against a literal list and
-- buckets anything else as 'other'. That is the right behaviour -- a cached PWA
-- client predating a rename is permanent rather than exceptional -- but it
-- means a NEW event name silently lands in the 'other' pile until this list
-- learns it, and 'other' is where counters go to become unanswerable.
--
-- The four below are this feature's counters, all content-free like every
-- other one: how many cards the index answered for, how many contributions
-- went out, how many were flagged wrong, and how often someone edits a card by
-- hand. No card name, no query, no image ever reaches this function.
--
-- Only the CASE list changes; the body is otherwise 0007's verbatim.
--
-- ROLLBACK: re-run 0007's definition of ingest_events(jsonb).

create or replace function public.ingest_events(p_batch jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_device   text;
  v_version  text;
  v_events   jsonb;
  v_recent   integer;
  v_stored   integer;
begin
  if p_batch is null or jsonb_typeof(p_batch) <> 'object' then
    return 0;
  end if;

  if coalesce(p_batch->>'app', '') <> 'cardstock' then
    return 0;
  end if;

  v_device  := nullif(left(trim(p_batch->>'device'), 64), '');
  v_version := coalesce(nullif(left(trim(p_batch->>'v'), 24), ''), 'unknown');
  v_events  := p_batch->'events';

  if v_device is null or jsonb_typeof(v_events) <> 'array' then
    return 0;
  end if;

  select count(*) into v_recent
  from public.analytics_events
  where device = v_device
    and received_at > now() - interval '1 hour';

  if v_recent > 5000 then
    return 0;
  end if;

  with incoming as (
    select e.value as ev
    from jsonb_array_elements(v_events) with ordinality as e(value, ord)
    where e.ord <= 500 and jsonb_typeof(e.value) = 'object'
  ), shaped as (
    select
      case
        when (ev->>'at') ~ '^[0-9]{10,16}$'
          and (ev->>'at')::numeric between 1000000000000 and 4102444800000
        then to_timestamp((ev->>'at')::numeric / 1000.0)
        else now()
      end as at,
      case
        when ev->>'t' in (
          'app_open','session_end','screen_view','scan_attempt','scan_failure',
          'card_added','variant_selected','import_completed','backup_run',
          'backup_restore','search','deck_created','ai_builder_run',
          'price_refresh','friend_added','social_share','trade_update',
          'want_update','sync_run','card_patch','card_source',
          'card_source_submit','card_source_flag','error'
        ) then ev->>'t'
        else 'other'
      end as event,
      nullif(left(ev->>'sid', 32), '') as session,
      case
        when length(ev::text) <= 4000 then (ev - 't' - 'at' - 'sid')
        else '{"oversize":true}'::jsonb
      end as data
    from incoming
  )
  insert into public.analytics_events (at, device, app_version, event, session, data)
  select at, v_device, v_version, event, session, data from shaped;

  get diagnostics v_stored = row_count;
  return v_stored;
end;
$$;

revoke all on function public.ingest_events(jsonb) from public;
grant execute on function public.ingest_events(jsonb) to anon, authenticated;
