-- 0022_catalog_index.sql
--
-- The catalog mirror: our own copy of the big three card catalogs.
--
-- WHY THIS EXISTS. The app's card data comes live from Scryfall, TCGdex /
-- pokemontcg.io and YGOPRODeck, and that stays true — the mirror is a
-- FALLBACK, never the first answer (the client consults it only when a
-- game's own API failed or answered empty; see src/lib/catalog.ts). It earns
-- its keep twice over:
--
--   * AVAILABILITY. pokemontcg.io is dying by degrees and the others have bad
--     days. A search or a scan that would have ended in an error can end in a
--     card, served from a table we control, with the SAME api ids the live
--     APIs use — so a card answered from the mirror dedupes with, and later
--     refreshes through, the real source (`${game}:${apiId}` is the contract,
--     as everywhere).
--   * VARIANTS. The printings-of lookup backs the variants picker when a
--     game's own printings API failed or answered empty — same posture, the
--     mirror behind the live source, never beside it.
--
-- The `art_hash` column below is RESERVED and unpopulated this round: an
-- artwork-fingerprint slot whose format (what is hashed, how, what distances
-- mean) is deliberately not yet a contract. The sync worker does not write
-- it and nothing client-side reads it; the column and its shape constraint
-- exist so the reservation is explicit rather than re-litigated by the next
-- schema change.
--
-- ONE TABLE, deliberately. A `catalog_cards` / `catalog_printings` split was
-- considered and rejected: every source ships the name ON the printing, every
-- read here wants the name WITH the printing, and the join would exist only
-- to be re-flattened in the one RPC that used it. The name is denormalized
-- per row and `slug` (lowercased name) is the grouping key — the same shape
-- the app itself uses for want keys and variant caches.
--
-- THE TRUST MODEL, same asymmetry as 0013, one notch stricter:
--
--   * READING IS ANONYMOUS. The three lookup functions are granted to `anon`,
--     called with the publishable key and never the session JWT (decision 20):
--     what card someone searches or scans must not become a row tied to an
--     account, and the free path is signed out.
--   * NOBODY ELSE WRITES AT ALL. Unlike card_data there is no user-facing
--     write: rows come from the operator-run sync worker with the service
--     key. `authenticated` has no door here, not even an RPC — catalog facts
--     are not community contributions, and a defaced mirror would poison
--     scans for everyone. Community fixes stay in card_data where they are
--     attributed and moderated.
--
-- NOBODY TOUCHES THE TABLE DIRECTLY over PostgREST: RLS on with no policies,
-- `revoke all`, grants back only what the RPCs and service_role need (the
-- 0011/0012 convention — audit pg_class.relacl, not information_schema).
--
-- ROLLBACK:
--   drop function if exists public.catalog_printings_of(text, text);
--   drop function if exists public.catalog_by_name(text, text);
--   drop function if exists public.catalog_by_code(text, text, text);
--   drop table if exists public.catalog_printings;
--   -- and re-run 0013's definition of ingest_events(jsonb).

create extension if not exists pg_trgm with schema extensions;

/* --------------------------------------------------------------- the table */

create table if not exists public.catalog_printings (
  id uuid primary key default gen_random_uuid(),
  /** One of the mirrored games — the three with healthy bulk sources. */
  game text not null check (game in ('mtg', 'pokemon', 'yugioh')),
  /**
   * The app's apiId namespace for that game, verbatim: Scryfall uuid for mtg,
   * `dex-…` TCGdex ids for pokemon (dexApiId in pokemon.ts), YGOPRODeck
   * passcode for yugioh. `${game}:${api_id}` must equal the id the live API
   * path would mint, or nothing answered from here ever dedupes.
   */
  api_id text not null,
  name text not null,
  /** lower(name) — the grouping key for "printings of this card". */
  slug text not null,
  /**
   * '' rather than null so it can join the uniqueness key: one Yu-Gi-Oh
   * passcode covers every reprint, so (game, api_id) alone cannot hold a row
   * per printing. Readers treat '' as absent.
   */
  set_code text not null default '',
  collector_number text,
  rarity text,
  language text not null default 'en',
  /** https only — every client renders this in an <img src>. */
  image_url text,
  /**
   * Operator-facing today: the client deliberately synthesizes mirror cards
   * WITHOUT prices (a day-stale price presented as live is wrong in the one
   * place people check value; refreshCard fills real ones because api_id is
   * real). Stored anyway because the sync gets it for free and a future
   * "price when everything else failed" needs history to have started.
   */
  price_usd numeric(10, 2),
  /**
   * RESERVED, unpopulated. 64 lowercase hex chars when it is ever written —
   * the fingerprint format is not yet a contract, so no writer exists and no
   * client reads it (see the header). The shape constraint stands guard over
   * the reservation, not over live data.
   */
  art_hash text,
  updated_at timestamptz not null default now(),
  constraint catalog_api_id_len check (length(api_id) between 1 and 120),
  constraint catalog_name_len check (length(name) between 1 and 200),
  constraint catalog_slug_len check (length(slug) between 1 and 200),
  constraint catalog_set_len check (length(set_code) <= 24),
  constraint catalog_number_len check (collector_number is null or length(collector_number) <= 24),
  constraint catalog_rarity_len check (rarity is null or length(rarity) <= 40),
  constraint catalog_language_len check (length(language) <= 8),
  constraint catalog_image_shape check (image_url is null or (image_url like 'https://%' and length(image_url) <= 500)),
  constraint catalog_price_sane check (price_usd is null or (price_usd >= 0 and price_usd < 1000000)),
  constraint catalog_hash_shape check (art_hash is null or art_hash ~ '^[0-9a-f]{64}$'),
  unique (game, api_id, set_code)
);

comment on table public.catalog_printings is
  'Mirror of the big-three card catalogs, written only by the operator sync worker (service key). Read anonymously through catalog_by_code/catalog_by_name/catalog_printings_of; no role holds direct DML.';

-- The code lookup: printed set code, case-folded.
create index if not exists catalog_code_idx
  on public.catalog_printings (game, upper(set_code));

-- The printings-of / grouping lookup.
create index if not exists catalog_slug_idx
  on public.catalog_printings (game, slug);

-- The name search: trigram gin serves the ilike in catalog_by_name.
create index if not exists catalog_name_trgm_idx
  on public.catalog_printings using gin (name extensions.gin_trgm_ops);

alter table public.catalog_printings enable row level security;
-- No policies, deliberately: with RLS on and none, every role that does not
-- bypass RLS is denied, and the security-definer functions below are the only
-- door in. The revoke closes the half RLS does not cover.
revoke all on public.catalog_printings from public, anon, authenticated;

-- The sync worker's door, and support's. Explicit rather than inherited so
-- 0012's default-privilege reasoning keeps holding: what service_role can do
-- here is written here.
grant select, insert, update, delete on public.catalog_printings to service_role;

/* ---------------------------------------------------------------- reading */

/**
 * Exact printing(s) by printed code. Case-insensitive on the set code;
 * collector numbers match case-insensitively AND leading-zero-insensitively
 * ("0321" finds "321"), or digits-only as a last resort ("085" finds
 * "EN085") — the shapes cardcode.ts actually produces from what people type.
 * p_number null returns the set's rows for that code, capped.
 */
create or replace function public.catalog_by_code(p_game text, p_set text, p_number text default null)
returns table (
  game text,
  api_id text,
  name text,
  set_code text,
  collector_number text,
  rarity text,
  image_url text,
  art_hash text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.game, d.api_id, d.name, d.set_code, d.collector_number, d.rarity, d.image_url, d.art_hash
  from public.catalog_printings d
  where d.game in ('mtg', 'pokemon', 'yugioh')
    and d.game = p_game
    and length(coalesce(trim(p_set), '')) between 1 and 24
    and upper(d.set_code) = upper(trim(p_set))
    and (
      p_number is null
      or nullif(ltrim(lower(d.collector_number), '0'), '') = nullif(ltrim(lower(trim(p_number)), '0'), '')
      or (
        nullif(regexp_replace(coalesce(d.collector_number, ''), '\D', '', 'g'), '') is not null
        and ltrim(regexp_replace(coalesce(d.collector_number, ''), '\D', '', 'g'), '0')
          = ltrim(regexp_replace(coalesce(p_number, ''), '\D', '', 'g'), '0')
      )
    )
  order by (d.art_hash is null), d.updated_at desc
  limit 20;
$$;

/**
 * Name search, the fallback behind a game's own search API. Prefix and
 * substring on the printed name; exact slug first, then prefix, then the
 * rest. The trigram index serves the ilike; ranking stays plain SQL rather
 * than similarity() so the function needs nothing outside its search_path.
 */
create or replace function public.catalog_by_name(p_game text, p_query text)
returns table (
  game text,
  api_id text,
  name text,
  set_code text,
  collector_number text,
  rarity text,
  image_url text,
  art_hash text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.game, d.api_id, d.name, d.set_code, d.collector_number, d.rarity, d.image_url, d.art_hash
  from public.catalog_printings d
  where d.game in ('mtg', 'pokemon', 'yugioh')
    and d.game = p_game
    and length(coalesce(trim(p_query), '')) between 2 and 80
    and d.name ilike '%' || trim(p_query) || '%'
  order by
    (d.slug <> lower(trim(p_query))),
    (d.slug not like lower(trim(p_query)) || '%'),
    d.name,
    (d.art_hash is null),
    d.updated_at desc
  limit 40;
$$;

/**
 * Every mirrored printing of one card — the fallback behind the variants
 * picker when a game's own printings API fails or has nothing. Grouped by
 * slug — the same "same card" key the app's variant cache uses.
 */
create or replace function public.catalog_printings_of(p_game text, p_name text)
returns table (
  game text,
  api_id text,
  name text,
  set_code text,
  collector_number text,
  rarity text,
  image_url text,
  art_hash text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.game, d.api_id, d.name, d.set_code, d.collector_number, d.rarity, d.image_url, d.art_hash
  from public.catalog_printings d
  where d.game in ('mtg', 'pokemon', 'yugioh')
    and d.game = p_game
    and length(coalesce(trim(p_name), '')) between 1 and 200
    and d.slug = lower(trim(p_name))
  order by (d.art_hash is null), d.updated_at desc
  limit 60;
$$;

/* ------------------------------------------------------------------ grants */

-- Reading is the anonymous half; there is no other half over PostgREST.
revoke all on function public.catalog_by_code(text, text, text)    from public;
revoke all on function public.catalog_by_name(text, text)          from public;
revoke all on function public.catalog_printings_of(text, text)     from public;

grant execute on function public.catalog_by_code(text, text, text) to anon, authenticated;
grant execute on function public.catalog_by_name(text, text)       to anon, authenticated;
grant execute on function public.catalog_printings_of(text, text)  to anon, authenticated;

/* ------------------------------------------- the diagnostics whitelist, again */

-- Same drill as 0013: ingest_events() buckets unknown names as 'other', so
-- each feature teaches the CASE list its counters. One new here, content-free
-- — how often the mirror answered where an API could not. No card name and no
-- query ever reaches this function.
--
-- Also repairs an omission: `message_sent` shipped with messaging (0019,
-- lib/messaging.ts tracks it) but no migration taught the list, so it has
-- been counting as 'other' since. It joins here.
--
-- Only the CASE list changes; the body is otherwise 0013's verbatim.
--
-- ROLLBACK: re-run 0013's definition of ingest_events(jsonb).

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
          'want_update','sync_run','message_sent','card_patch','card_source',
          'card_source_submit','card_source_flag','catalog_fallback','error'
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
