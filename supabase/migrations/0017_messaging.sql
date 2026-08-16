-- 0017_messaging.sql
--
-- Two collectors talking to each other about a card.
--
-- WHY THIS IS A NEW SUBSYSTEM AND NOT A WIDENED INBOX. `inbox` (0004) is
-- recipient-read-only, sender-stamped, drained-and-deleted, 30-day TTL, capped
-- at 20 undrained items per pair. Every one of those properties is right for
-- handing someone a trade payload and wrong for a conversation: a sender who
-- cannot read the thread back cannot see what they said, and a row that is
-- deleted on read is not a history. docs/social.md said in as many words that
-- the inbox is not the channel for this. It still is not. This is.
--
-- WHY IT EXISTS AT ALL, given that the same document argued against a free-text
-- field on an order. That argument was about `orders`: a message box attached
-- to a payment is an unmoderated channel between two people who are, by
-- construction, in a dispute, and it invites "just send me the money directly"
-- next to a button that would have escrowed it. This is the opposite end — the
-- conversation that happens BEFORE anyone agrees to anything, which today
-- happens on Discord and Instagram and therefore happens outside the app that
-- knows which card is being discussed. `orders` still has no free-text field,
-- and nothing here is attached to one.
--
-- WHO MAY START ONE. Exactly the `send_to_inbox()` rule, plus one addition:
--   * accepted friends, always;
--   * anyone publishing a `scope='trade'` binder — they advertised cards for
--     swap, so being reachable about them is the point;
--   * anyone who has already spoken to you, so a reply cannot be refused
--     because the person you are answering has since unpublished.
-- Publish nothing and have no friends and you are unreachable, which stays
-- the correct default.
--
-- WHAT THE SERVER CAN READ. All of it. This is plaintext for the same reason
-- `binders` is: the other person's app has to display it. It is NOT encrypted
-- and must never be described as private from us — the same honesty decision
-- 15b forced on the vault. What it is, is bounded: text and one optional card
-- reference, no attachments, no images, no addresses. There is nothing here to
-- put a photo or a postal address into, and that is deliberate.
--
-- BLOCKING IS ONE-SIDED AND SILENT. `lo_blocked`/`hi_blocked` say "this side
-- has blocked the other". A blocked thread simply stops appearing in the
-- blocker's list; the sender's own history is untouched and they are never
-- told. That mirrors `request_friend()`, which returns 'pending' to someone
-- who has been blocked precisely so being told does not become an instruction
-- to make a new account.
--
-- ROLLBACK:
--   drop function if exists public.prune_messages();
--   drop function if exists public.set_thread_block(bigint, boolean);
--   drop function if exists public.mark_thread_read(bigint);
--   drop function if exists public.list_threads();
--   drop function if exists public.send_message(uuid, text, jsonb);
--   drop function if exists public.can_message(uuid);
--   drop function if exists public.in_thread(bigint, uuid);
--   drop table if exists public.messages;
--   drop table if exists public.message_threads;
--   (and re-apply 0004's erase_social(), which this file replaces)

/* -------------------------------------------------------------- the tables */

create table if not exists public.message_threads (
  id          bigint generated always as identity primary key,
  -- ONE ROW PER PAIR, enforced by ordering the two ids rather than by a
  -- convention nobody can see. `user_lo < user_hi` plus the unique index means
  -- two people who message each other simultaneously cannot end up with two
  -- threads and half a conversation in each.
  user_lo     uuid not null references auth.users(id) on delete cascade,
  user_hi     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  -- Denormalized so a thread list renders in one query without reading a
  -- single message body — the same trade `binders.card_count` makes.
  last_at     timestamptz not null default now(),
  last_sender uuid,
  last_preview text,
  -- Read watermarks are MESSAGE IDS, not timestamps. Ids are monotonic and
  -- server-assigned; a clock is neither, and "unread" computed against a
  -- client-supplied time is a bug that only shows up on one person's phone.
  lo_read_id  bigint not null default 0,
  hi_read_id  bigint not null default 0,
  lo_blocked  boolean not null default false,
  hi_blocked  boolean not null default false,
  constraint threads_ordered check (user_lo < user_hi),
  unique (user_lo, user_hi)
);

-- "My threads, newest first" is the only listing query, asked from both sides.
create index if not exists message_threads_lo_idx on public.message_threads (user_lo, last_at desc);
create index if not exists message_threads_hi_idx on public.message_threads (user_hi, last_at desc);

create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  thread_id  bigint not null references public.message_threads(id) on delete cascade,
  -- Stamped from auth.uid() by send_message(), never taken from the client —
  -- the same rule as `inbox.sender`, and for the same reason.
  sender     uuid not null references auth.users(id) on delete cascade,
  body       text not null check (length(body) between 1 and 2000),
  -- One optional card the message is about: the `SharedCard` wire shape, so
  -- the client re-sanitizes it with the sanitizer it already has (decision 7)
  -- and "are you still after this Charizard?" carries the printing, the
  -- condition and the asking price instead of being prose someone has to
  -- parse. Nullable because most messages are just words.
  about      jsonb,
  created_at timestamptz not null default now()
);

-- The thread reader pages `thread_id=eq.N&order=id.asc`.
create index if not exists messages_thread_idx on public.messages (thread_id, id);
-- The hourly rate limiter counts one sender's recent rows.
create index if not exists messages_sender_recent_idx on public.messages (sender, created_at desc);

/* ----------------------------------------------------------- who reads what */

/**
 * Is this user a participant in this thread?
 *
 * `security definer` because the messages SELECT policy calls it while
 * evaluating a read, and it must not be filtered by the caller's own RLS on
 * `message_threads` — that would be the `are_friends()` trap from 0002 in a
 * new place. `set search_path` for the same reason it is mandatory there.
 */
create or replace function public.in_thread(p_thread bigint, p_user uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1 from public.message_threads t
     where t.id = p_thread and p_user in (t.user_lo, t.user_hi)
  );
$$;

revoke all on function public.in_thread(bigint, uuid) from public, anon;
grant  execute on function public.in_thread(bigint, uuid) to authenticated;

alter table public.message_threads enable row level security;
alter table public.messages        enable row level security;

-- Read only, both tables, participants only. There is deliberately no write
-- policy of any kind: every mutation goes through an RPC below, because the
-- denormalized preview, the read watermarks and the block flags are all
-- things a client could otherwise forge about the OTHER person's row.
drop policy if exists "read own threads" on public.message_threads;
create policy "read own threads" on public.message_threads
  for select using (auth.uid() in (user_lo, user_hi));

drop policy if exists "read thread messages" on public.messages;
create policy "read thread messages" on public.messages
  for select using (public.in_thread(thread_id, auth.uid()));

-- `revoke all` first: Supabase's default privileges hand `anon` and
-- `authenticated` things nobody asked for, and a revoke that NAMES privileges
-- only takes back the ones you thought of (0011/0012).
revoke all on public.message_threads from public, anon, authenticated;
revoke all on public.messages        from public, anon, authenticated;
grant  select on public.message_threads to authenticated;
grant  select on public.messages        to authenticated;

/* ------------------------------------------------------------ reachability */

/**
 * May I open a conversation with `p_to`?
 *
 * The `send_to_inbox()` rule plus "they spoke to me first". That last clause
 * is not politeness: without it, answering someone who unpublished their
 * binder between their message and your reply fails, and the person who
 * started the conversation is the one who gets ignored.
 *
 * The sender is `auth.uid()` rather than an argument, so this cannot be used
 * to ask questions about two OTHER people. Everything it does tell the caller
 * — are we friends, do they publish a trade binder — the caller can already
 * see for themselves; what it saves is having to fetch both to find out.
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

/* ------------------------------------------------------------------ sending */

/**
 * Say something to someone. Returns the thread id.
 *
 * Creates the thread on first message, so there is no separate "start a
 * conversation" call to get out of step with this one.
 *
 * TWO CAPS, doing different jobs. The per-thread one bounds a monologue: at
 * most `UNANSWERED` messages since the other person last said anything, so
 * somebody who is being ignored is told to stop rather than able to fill a
 * screen. The hourly one bounds a broadcast: a single account cannot walk the
 * want index messaging every publisher on it. Neither is a substitute for the
 * other — the first is per-pair and the second is global.
 */
create or replace function public.send_message(p_to uuid, p_body text, p_about jsonb default null)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  unanswered  constant integer := 15;
  hourly_cap  constant integer := 120;
  v_me        uuid := auth.uid();
  v_lo        uuid;
  v_hi        uuid;
  v_body      text := trim(p_body);
  v_thread    bigint;
  v_their_max bigint;
  v_mine      integer;
  v_recent    integer;
  v_id        bigint;
begin
  if v_me is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if p_to is null or p_to = v_me then
    raise exception 'bad_recipient' using errcode = 'P0001';
  end if;
  if v_body is null or length(v_body) = 0 then
    raise exception 'empty_message' using errcode = 'P0001';
  end if;
  if length(v_body) > 2000 then
    raise exception 'message_too_long' using errcode = 'P0001';
  end if;
  -- Bound what one row can cost before anything else touches the table. A
  -- SharedCard is a few hundred bytes; 8 KB is generous and still finite.
  if p_about is not null and pg_column_size(p_about) > 8192 then
    raise exception 'attachment_too_large' using errcode = 'P0001';
  end if;

  select count(*) into v_recent
    from public.messages
   where sender = v_me and created_at > now() - interval '1 hour';
  if v_recent >= hourly_cap then
    raise exception 'too_many_messages' using errcode = 'P0001';
  end if;

  if not public.can_message(p_to) then
    raise exception 'not_reachable' using errcode = 'P0001';
  end if;

  v_lo := least(v_me, p_to);
  v_hi := greatest(v_me, p_to);

  insert into public.message_threads (user_lo, user_hi)
       values (v_lo, v_hi)
  on conflict (user_lo, user_hi) do update set user_lo = excluded.user_lo
  returning id into v_thread;

  -- How much have I said since they last said anything? `coalesce(...,0)`
  -- makes a thread they have never answered count from the beginning, which
  -- is exactly the case this cap is for.
  select coalesce(max(id), 0) into v_their_max
    from public.messages where thread_id = v_thread and sender = p_to;
  select count(*) into v_mine
    from public.messages where thread_id = v_thread and sender = v_me and id > v_their_max;
  if v_mine >= unanswered then
    raise exception 'thread_full' using errcode = 'P0001';
  end if;

  insert into public.messages (thread_id, sender, body, about)
       values (v_thread, v_me, v_body, p_about)
  returning id into v_id;

  update public.message_threads
     set last_at      = now(),
         last_sender  = v_me,
         last_preview = left(v_body, 140),
         -- Sending is reading: a message I just wrote is not unread to me.
         lo_read_id   = case when v_lo = v_me then v_id else lo_read_id end,
         hi_read_id   = case when v_hi = v_me then v_id else hi_read_id end,
         -- Talking to someone unblocks THEM for me. It does not touch their
         -- block on me, which is theirs alone to lift.
         lo_blocked   = case when v_lo = v_me then false else lo_blocked end,
         hi_blocked   = case when v_hi = v_me then false else hi_blocked end
   where id = v_thread;

  return v_thread;
end;
$$;

revoke all on function public.send_message(uuid, text, jsonb) from public, anon;
grant  execute on function public.send_message(uuid, text, jsonb) to authenticated;

/* ----------------------------------------------------------- the thread list */

/**
 * My conversations, newest first, with the counterparty's name and my unread
 * count already worked out.
 *
 * One call rather than a `message_threads` select plus a `profiles` select
 * plus an unread count per thread, because this runs on a 25-second poll and
 * three round trips per tick is how a poll becomes a cost. Capped at 200: a
 * listing, not an export.
 *
 * Threads I have blocked are omitted — that is what blocking DOES here. The
 * other side's block flag is never returned to anyone, so nothing in this
 * result tells a sender they have been blocked.
 */
create or replace function public.list_threads()
returns table (
  thread_id    bigint,
  other_id     uuid,
  handle       text,
  display_name text,
  last_at      timestamptz,
  last_preview text,
  last_sender  uuid,
  unread       integer
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  with mine as (
    select t.id,
           case when t.user_lo = auth.uid() then t.user_hi else t.user_lo end as other,
           case when t.user_lo = auth.uid() then t.lo_read_id else t.hi_read_id end as read_id,
           case when t.user_lo = auth.uid() then t.lo_blocked else t.hi_blocked end as blocked,
           t.last_at, t.last_preview, t.last_sender
      from public.message_threads t
     where auth.uid() is not null
       and auth.uid() in (t.user_lo, t.user_hi)
  )
  select m.id,
         m.other,
         p.handle,
         p.display_name,
         m.last_at,
         m.last_preview,
         m.last_sender,
         (select count(*)::integer from public.messages g
           where g.thread_id = m.id and g.sender = m.other and g.id > m.read_id) as unread
    from mine m
    join public.profiles p on p.user_id = m.other
   where not m.blocked
   order by m.last_at desc
   limit 200;
$$;

revoke all on function public.list_threads() from public, anon;
grant  execute on function public.list_threads() to authenticated;

/** Mark everything currently in a thread as read by me. */
create or replace function public.mark_thread_read(p_thread bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me  uuid := auth.uid();
  v_max bigint;
begin
  if v_me is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if not public.in_thread(p_thread, v_me) then
    raise exception 'not_in_thread' using errcode = 'P0001';
  end if;
  select coalesce(max(id), 0) into v_max from public.messages where thread_id = p_thread;
  update public.message_threads
     set lo_read_id = case when user_lo = v_me then greatest(lo_read_id, v_max) else lo_read_id end,
         hi_read_id = case when user_hi = v_me then greatest(hi_read_id, v_max) else hi_read_id end
   where id = p_thread;
end;
$$;

revoke all on function public.mark_thread_read(bigint) from public, anon;
grant  execute on function public.mark_thread_read(bigint) to authenticated;

/**
 * Stop (or resume) hearing from the other person in a thread.
 *
 * Sets only MY side's flag, and the other person is never told. Their messages
 * keep being accepted and stored — refusing them would tell the sender exactly
 * what this is built not to tell them — they simply stop reaching me.
 */
create or replace function public.set_thread_block(p_thread bigint, p_blocked boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  if not public.in_thread(p_thread, v_me) then
    raise exception 'not_in_thread' using errcode = 'P0001';
  end if;
  update public.message_threads
     set lo_blocked = case when user_lo = v_me then coalesce(p_blocked, false) else lo_blocked end,
         hi_blocked = case when user_hi = v_me then coalesce(p_blocked, false) else hi_blocked end
   where id = p_thread;
end;
$$;

revoke all on function public.set_thread_block(bigint, boolean) from public, anon;
grant  execute on function public.set_thread_block(bigint, boolean) to authenticated;

/**
 * Drop messages older than a year, and threads left with nothing in them.
 *
 * A year rather than the inbox's thirty days: a conversation is a record of
 * what two people agreed, and "you said you'd send the Charizard" nine months
 * later is the case where it matters most. Like `prune_inbox()` this is not
 * scheduled by the migration and nothing depends on it running promptly — it
 * bounds growth, it is not a correctness requirement.
 */
create or replace function public.prune_messages()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from public.messages where created_at < now() - interval '365 days';
  get diagnostics v_count = row_count;
  delete from public.message_threads t
   where not exists (select 1 from public.messages m where m.thread_id = t.id)
     and t.created_at < now() - interval '365 days';
  return v_count;
end;
$$;

revoke all on function public.prune_messages() from public, anon, authenticated;

/* --------------------------------------------------------------- erasure */

/**
 * 0004's `erase_social()`, extended to take conversations with it.
 *
 * Replaced rather than supplemented because Settings → Erase must be ONE call
 * that leaves nothing behind; a second RPC the client could forget to make is
 * how a "delete everything" button comes to be a lie.
 *
 * Deleting the thread removes it for BOTH people, and that is the honest
 * behaviour rather than an oversight: half a conversation, attributed to
 * somebody who no longer exists, is not a record anyone is served by keeping.
 * What it still does not touch is `vaults` (your encrypted backup) or `orders`
 * (a completed sale backs a 1099-K and a chargeback response).
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
  -- Threads first: `messages` cascades off the thread, so this is one delete
  -- rather than two, and it cannot leave an orphan behind if it half-fails.
  delete from public.message_threads where auth.uid() in (user_lo, user_hi);
  delete from public.trade_offers where user_id = auth.uid();
  delete from public.binders     where user_id = auth.uid();
  delete from public.inbox       where recipient = auth.uid() or sender = auth.uid();
  delete from public.friendships where auth.uid() in (requester, addressee);
  delete from public.profiles    where user_id = auth.uid();
end;
$$;

revoke all on function public.erase_social() from public, anon;
grant  execute on function public.erase_social() to authenticated;
