-- 0007_analytics.sql
--
-- The diagnostics receiver. One append-only table and one function that is the
-- only way into it.
--
-- WHY IT LIVES HERE. This is Cardstock's own project, which already carries the
-- vault, hosted social and orders. `docs/roadmap.md` argues against putting
-- analytics in *the shared* project (`deskabqqxqqibxjffwmb`, where three other
-- apps' migration numbers already collide); that argument does not apply to a
-- project this app owns outright and whose history is baselined. What it does
-- leave behind is the blast-radius half of the concern -- an anonymous firehose
-- sitting beside users' encrypted vaults and their orders -- and the answer to
-- that is the trust model below rather than a separate database.
--
-- TRUST MODEL -- read before touching a grant:
--   * WRITES ARE ANONYMOUS AND MUST BE. The app collects diagnostics before
--     anyone signs in, and most users never will. `anon` may therefore call
--     `ingest_events()`. That is a deliberate, and the only, hole in this
--     schema.
--   * NOBODY MAY READ. Not `anon`, not `authenticated`, not the author of the
--     rows. RLS is on with no policy, which denies everything; `service_role`
--     bypasses RLS and is how a maintainer queries it. There is no lookup here
--     to protect, so unlike the pattern in the skill there is no read function
--     either -- the absence is the feature.
--   * NOBODY MAY INSERT DIRECTLY. `ingest_events()` is `security definer` and
--     the table grants nothing, so every row goes through the validation below.
--     A direct insert grant would let anyone write any `device` any `event`,
--     which is the whole of the abuse surface in one statement.
--
-- WHAT THE KEY IS AND IS NOT. The client authenticates with the publishable
-- key, which ships in a static bundle and is public by construction. It
-- identifies the APP, never a person, and it is not a secret -- anyone can post
-- rubbish here and the only real defences are the caps and the rate limit in
-- the function. That is an accepted trade: the alternative was a bearer token,
-- equally readable in the same bundle, plus a second thing to rotate.
--
-- `device` IS NOT `auth.uid()`, and must never become it. It is a random id the
-- client mints per install (`analytics.ts`, `deviceId()`), and joining it to a
-- real account would turn a content-free counter into a per-person activity
-- log. Nothing in this file references `auth.uid()` for exactly that reason.
--
-- THE PAYLOAD IS ALREADY REDACTED CLIENT-SIDE (`redact()` in analytics.ts drops
-- content, credential, postal and money keys). This function does not re-derive
-- that contract -- it caps size and shape, which is the part SQL can enforce.
--
-- ROLLBACK:
--   drop function if exists public.ingest_events(jsonb);
--   drop table if exists public.analytics_events;

create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  -- When we got it, versus when it happened on the device. Both matter: a PWA
  -- can be offline for days and flush a backlog, so `at` is the only honest
  -- clock for behaviour and `received_at` the only honest one for arrival.
  received_at timestamptz not null default now(),
  at timestamptz not null,
  /** Random per-install id. NOT an account. See the header. */
  device text not null,
  app_version text not null,
  /** One of EVENT_TYPES in analytics.ts, or 'other' -- see the note in the function. */
  event text not null,
  /** Groups a visit's events. Client-minted, meaningless across devices. */
  session text,
  /** The redacted event body, minus `t`/`at`/`sid` which have columns. */
  data jsonb not null default '{}'::jsonb
);

comment on table public.analytics_events is
  'Anonymous, content-free diagnostics. Write-only via ingest_events(); no role but service_role can read.';

-- The rate limit counts a device's recent rows, so it is the hot path.
create index if not exists analytics_events_device_recent_idx
  on public.analytics_events (device, received_at desc);
-- Every dashboard query is "this event type over this window".
create index if not exists analytics_events_event_at_idx
  on public.analytics_events (event, at desc);

alter table public.analytics_events enable row level security;
-- No policies, deliberately: RLS with none denies every role that does not
-- bypass it. Adding a permissive SELECT here would publish the whole log.

revoke all on public.analytics_events from anon, authenticated;

/**
 * Swallow a batch. Returns how many rows were stored.
 *
 * Shape, matching `payload()` in analytics.ts exactly:
 *   { app, v, device, firstSeen, sessions, activeDays, sentAt,
 *     events: [ { t, at, ...redacted fields } ] }
 *
 * UNKNOWN EVENT NAMES ARE BUCKETED, NEVER REJECTED. A PWA keeps users on a
 * cached bundle until they take an update, so a client that predates a rename
 * is a permanent fact of life, not an error. Rejecting its batch would lose
 * every event in it, including the ones this version does understand.
 *
 * It returns a count rather than raising on a bad batch for the same reason the
 * client swallows failures: diagnostics must never be a way for the app to
 * break. A caller that sends nonsense gets 0 and no explanation.
 */
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

  -- One app per receiver. A batch from something else is not ours to store.
  if coalesce(p_batch->>'app', '') <> 'cardstock' then
    return 0;
  end if;

  v_device  := nullif(left(trim(p_batch->>'device'), 64), '');
  v_version := coalesce(nullif(left(trim(p_batch->>'v'), 24), ''), 'unknown');
  v_events  := p_batch->'events';

  if v_device is null or jsonb_typeof(v_events) <> 'array' then
    return 0;
  end if;

  -- RATE LIMIT. The client sends at most 500 every 30s and only while
  -- foregrounded; a device past this is either broken or hostile, and in both
  -- cases the honest answer is to stop storing rather than to argue. Silent by
  -- design -- see the note above about diagnostics never breaking the app.
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
    -- Hard cap per call regardless of what the caller claims to be sending.
    where e.ord <= 500 and jsonb_typeof(e.value) = 'object'
  ), shaped as (
    select
      -- Epoch ms from the client. Anything unparseable, absent or absurd falls
      -- back to now(): a mistimed event is still a countable one, and dropping
      -- it would quietly bias every rate this table is meant to answer.
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
          'want_update','sync_run','error'
        ) then ev->>'t'
        else 'other'
      end as event,
      nullif(left(ev->>'sid', 32), '') as session,
      -- Keep the body minus what has columns. Capped: a payload past this is
      -- not something `redact()` produced.
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

-- The one deliberate hole: anonymous writes, because the app collects
-- diagnostics before anyone signs in and most users never do.
revoke all on function public.ingest_events(jsonb) from public;
grant execute on function public.ingest_events(jsonb) to anon, authenticated;
