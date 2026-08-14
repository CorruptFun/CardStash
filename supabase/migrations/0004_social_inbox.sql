-- Hosted social, part 4 of 4: the trade inbox, and erasure.
--
-- WHAT THIS REPLACES. The four-hop link dance: propose -> send them a link ->
-- they open it -> they answer -> send a reply link back -> you open it. Both
-- hops carried the full payload through a chat app and both could simply be
-- lost. Here a proposal is a row addressed to a user id, and the recipient's
-- app finds it. Same payloads, same sanitizers, no pasting.
--
-- This is the direct port of `POST/GET /v1/inbox/:id` from the self-hosted box.
-- The route shape was designed to port, and it did -- what changes is that
-- "auth" stops meaning a device token claimed trust-on-first-use and starts
-- meaning a JWT.

create table if not exists public.inbox (
  id         bigint generated always as identity primary key,
  recipient  uuid not null references auth.users(id) on delete cascade,
  -- Stamped server-side from auth.uid(), NEVER taken from the payload. The
  -- payload also carries a `from` block (the wire format is frozen), but that
  -- one is client-authored and is only ever a display name -- this column is
  -- what the app should trust when the two disagree.
  sender     uuid not null references auth.users(id) on delete cascade,
  -- A TradePayload or ReplyPayload, verbatim, carrying app: 'cardstock-social'.
  payload    jsonb not null,
  created_at timestamptz not null default now()
);

-- The drain query is "mine, newer than my cursor, oldest first".
create index if not exists inbox_recipient_idx on public.inbox (recipient, id);

alter table public.inbox enable row level security;

-- Read: recipient only. Not the sender -- a sent proposal is already in the
-- sender's own trades table locally, and letting senders read the row back
-- would leak whether it had been delivered to an account that may not want to
-- confirm it exists.
drop policy if exists "read own inbox" on public.inbox;
create policy "read own inbox" on public.inbox
  for select using (auth.uid() = recipient);

-- Delete: recipient only, so a drained item can be cleared. A sender cannot
-- retract a proposal from someone's inbox -- consistent with a link, which
-- cannot be un-sent either.
drop policy if exists "clear own inbox" on public.inbox;
create policy "clear own inbox" on public.inbox
  for delete using (auth.uid() = recipient);

-- No INSERT policy at all: sending goes through send_to_inbox() below, which
-- is the only thing that may write here.
grant select, delete on public.inbox to authenticated;

/**
 * Hand a trade proposal or reply to someone's inbox.
 *
 * WHO MAY SEND. Accepted friends, or anyone when the recipient publishes a
 * scope='trade' binder -- they advertised cards for swap, so being reachable
 * about them is the point, and it mirrors today's rule that anyone holding
 * your share link can send you a proposal. A user who publishes nothing and
 * has no friends is unreachable, which is the correct default.
 *
 * RATE CAP. At most 20 undrained items from one sender to one recipient. The
 * cap is per-pair rather than global so a spammer cannot fill one person's
 * inbox, and cannot deny service to third parties either.
 */
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
  -- Bound what one row can cost before anything else touches the table.
  if pg_column_size(p_payload) > 1048576 then
    raise exception 'payload_too_large' using errcode = 'P0001';
  end if;

  select public.are_friends(auth.uid(), p_recipient)
      or exists (select 1 from public.binders b
                  where b.user_id = p_recipient and b.scope = 'trade')
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

revoke execute on function public.send_to_inbox(uuid, jsonb) from public, anon;
grant  execute on function public.send_to_inbox(uuid, jsonb) to authenticated;

/**
 * Drop inbox items older than 30 days.
 *
 * Matches the self-hosted box's TTL. Not scheduled by this migration -- wire
 * it to pg_cron when the project has it, or call it from the ingest path.
 * Nothing depends on it running promptly; it bounds growth, it is not a
 * correctness requirement.
 */
create or replace function public.prune_inbox()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from public.inbox where created_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.prune_inbox() from public, anon, authenticated;

-- ------------------------------------------------------------------- erasure

/**
 * Remove everything this user has published or been sent, in one call.
 *
 * Settings -> Erase must erase server-side too, and until this feature there
 * was nothing server-side to erase. Deleting the auth user cascades all of it
 * anyway; this exists for the far more common case of "stop being social but
 * keep my account and my vault".
 *
 * Note what it does NOT touch: `vaults`. Erasing your social presence must not
 * delete the encrypted backup of your collection -- those are separate
 * decisions and conflating them would lose someone their cards.
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
  delete from public.trade_offers where user_id = auth.uid();
  delete from public.binders     where user_id = auth.uid();
  delete from public.inbox       where recipient = auth.uid() or sender = auth.uid();
  delete from public.friendships where auth.uid() in (requester, addressee);
  delete from public.profiles    where user_id = auth.uid();
end;
$$;

revoke execute on function public.erase_social() from public, anon;
grant  execute on function public.erase_social() to authenticated;

-- Rollback:
--   drop function if exists public.erase_social();
--   drop function if exists public.prune_inbox();
--   drop function if exists public.send_to_inbox(uuid, jsonb);
--   drop table if exists public.inbox;
