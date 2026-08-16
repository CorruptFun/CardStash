-- Referrals, part 3: an invite that actually introduces two people.
--
-- 0014 recorded WHO arrived through whose link, because that is what decides a
-- price. It stopped there: the two of them were never connected, so the person
-- who did the inviting had to be added again by hand, by handle, by whoever
-- remembered to. An invite that does not end in a friendship is a coupon.
--
-- CONSENT. 0002 is emphatic that friendship is mutual and that a requester may
-- never flip their own row to accepted -- "that is the whole consent gate".
-- This function does not weaken it. It creates an accepted edge only where
-- BOTH sides have already acted: the referrer wrote and sent the invite, and
-- the person arriving followed it and set up an account. The referral row is
-- the proof of both halves, and it is the only thing that can authorise the
-- edge -- there is no handle argument, nothing the caller passes in, and
-- nothing to point at a stranger. That is why this is a separate function
-- rather than a flag on request_friend().
--
-- A REFUSAL IS NEVER LAUNDERED. If a 'blocked' row exists in either direction,
-- this does nothing at all. Someone who declined a person must not find them
-- back in their friends list because the same person sent them an invite link.
--
-- Rollback:
--   drop function if exists public.befriend_referrer();
--   drop function if exists public.referral_joins();

/**
 * Make the caller and whoever referred them accepted friends.
 *
 * Returns the referrer's handle when this call is what made them friends, and
 * NULL every other time -- no referral, no profile yet, already friends,
 * blocked, or the referrer has since deleted their account. The client shows a
 * message on a handle and stays silent on NULL, so "already friends" is not
 * announced twice on a second device.
 *
 * Definer because the caller cannot see the other side of any of this: the
 * `referrals` policy is read-own, and `friendships` is visible only to its own
 * endpoints, so an invoker function could neither find the referrer nor detect
 * an existing edge -- it would create duplicate rows and resurrect blocks.
 *
 * `set search_path` is mandatory on a definer function (0002's note): without
 * it, `friendships` resolves against the caller's search_path and can be
 * pointed at a table they created.
 */
create or replace function public.befriend_referrer()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_ref    uuid;
  v_status text;
  v_handle text;
begin
  if v_user is null then return null; end if;

  -- "When they set up their profile" is the trigger the product promises, and
  -- it is load-bearing rather than cosmetic: a friend row with no handle is a
  -- person the other side cannot name, look up or answer.
  if not exists (select 1 from public.profiles p where p.user_id = v_user) then
    return null;
  end if;

  select r.referred_by into v_ref
  from public.referrals r
  where r.user_id = v_user;

  -- No referral is the ordinary case (most accounts arrive on their own), and
  -- the self check is belt-and-braces: `referrals_not_self` already forbids it.
  if v_ref is null or v_ref = v_user then return null; end if;

  select p.handle into v_handle from public.profiles p where p.user_id = v_ref;
  -- A referrer who never claimed a handle, or whose account is gone, is not
  -- someone this can introduce. `referrals.referred_by` cascades on delete, so
  -- the row is normally gone with them; this covers the gap before it is.
  if v_handle is null then return null; end if;

  -- Both column orders, because the edge is undirected and either side may
  -- hold it. This is also the block check: a refusal in either direction ends
  -- the call, and it is deliberately indistinguishable from "already friends"
  -- to the caller (0002's rule -- telling someone they are blocked invites
  -- them to make a second account).
  select f.status into v_status
  from public.friendships f
  where (f.requester = v_ref  and f.addressee = v_user)
     or (f.requester = v_user and f.addressee = v_ref);

  if v_status = 'blocked' or v_status = 'accepted' then return null; end if;

  if v_status = 'pending' then
    -- One of them had already asked. Both have now consented -- one by
    -- inviting, one by following the invite -- so this is the same
    -- both-sides-asked case request_friend() already accepts, and leaving it
    -- pending would strand two people who each said yes.
    update public.friendships
       set status = 'accepted', updated_at = now()
     where (requester = v_ref  and addressee = v_user)
        or (requester = v_user and addressee = v_ref);
    return v_handle;
  end if;

  -- The referrer is recorded as the requester because they are the one who
  -- reached out; the row reads the way it happened.
  insert into public.friendships (requester, addressee, status)
  values (v_ref, v_user, 'accepted')
  on conflict (requester, addressee) do nothing;

  return v_handle;
end;
$$;

comment on function public.befriend_referrer() is
  'Accepted friendship between the caller and their referrer, authorised by the referrals row alone. Never overwrites an existing edge.';

revoke execute on function public.befriend_referrer() from public, anon;
grant  execute on function public.befriend_referrer() to authenticated;

/**
 * How many accounts arrived through my link.
 *
 * A COUNT and nothing else. `referrals` is read-own precisely so the graph
 * stays private (0014), and this must not become a back door to it: who
 * joined is their business, how many is the inviter's own.
 *
 * Distinct from `referral_earnings()` in 0016, which counts money and
 * therefore only sees the ones who PAID. Someone inviting testers needs to
 * know the link works long before anybody buys anything.
 */
create or replace function public.referral_joins()
returns int
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select count(*)::int
  from public.referrals r
  where auth.uid() is not null and r.referred_by = auth.uid();
$$;

comment on function public.referral_joins() is
  'Count of accounts that arrived through the caller''s referral link. Count only, never identities.';

revoke execute on function public.referral_joins() from public, anon;
grant  execute on function public.referral_joins() to authenticated;
