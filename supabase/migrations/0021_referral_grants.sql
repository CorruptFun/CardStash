-- 0021_referral_grants.sql
--
-- The read-own policies on the referral tables were inert. 0014 and 0016
-- shipped after 0012 stripped the default privileges, and each guarded its
-- table with `revoke insert, update, delete` -- a privilege LIST, the form
-- 0011 proved rots -- with no `grant select` beside it. So `authenticated`
-- held nothing at all, and PostgREST answers 42501 before it ever consults a
-- policy: the policy might as well not exist.
--
-- What that broke in the shipped client: `foundingOffer()`'s first question is
-- a direct read of `referrals` ("was I referred?"), and `!mine.ok` means
-- "nothing to say" -- so every referred account saw no founding offer at all.
-- The price at the till was never wrong (`referral_tier()` is definer and
-- checkout asks it server-side); what broke was the offer being VISIBLE.
--
-- Found by `test:social`'s "THE GRAPH ITSELF STAYS PRIVATE" check the first
-- time it ran against the live project, and confirmed by an ACL audit:
-- `referrals`, `founding_members` and `referral_rewards` were the only three
-- tables holding a select policy and no select grant.
--
-- The canonical form (0011/0012's lesson): revoke ALL, then grant back exactly
-- what is needed. RLS stays the boundary -- every policy here is read-own
-- (`auth.uid() = user_id` / `= referrer_id`), so the grant exposes one's own
-- rows and nothing else. The graph stays private: who I referred is their
-- row, not mine. Writes remain RPC-only on all three.
--
-- Rollback:
--   revoke select on public.referrals, public.founding_members,
--     public.referral_rewards from authenticated;

revoke all on public.referrals        from public, anon, authenticated;
revoke all on public.founding_members from public, anon, authenticated;
revoke all on public.referral_rewards from public, anon, authenticated;

grant select on public.referrals        to authenticated;
grant select on public.founding_members to authenticated;
grant select on public.referral_rewards to authenticated;
