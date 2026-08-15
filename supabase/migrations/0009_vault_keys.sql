-- 0009_vault_keys.sql
--
-- Backup that happens WITHOUT being asked for, which means a key nobody has to
-- remember.
--
-- WHY THIS EXISTS, stated plainly because it reverses a documented decision.
-- Decision 15 said the vault key is derived from a passphrase on the device and
-- that this is not negotiable. The evidence says otherwise: on 2026-08-15 this
-- project held **zero vault rows**. Not few — zero. Nobody had ever completed
-- the setup, and a user lost a real collection that day because the only copy
-- was in browser storage iOS had evicted. A backup that nobody switches on is
-- not a backup, and a passphrase with no reset cannot be switched on BY DEFAULT
-- because forgetting it is unrecoverable by construction.
--
-- WHAT THIS IS, AND WHAT IT IS NOT. It is encryption at rest with a key we
-- hold. It is **not** end-to-end encryption and the docs must never call it
-- that. Concretely:
--
--   * It DOES defend against a leak of `vaults` alone — a dumped table, a
--     mistaken policy, a stray backup file. Ciphertext without `vault_keys` is
--     noise.
--   * It DOES stop one user reading another's vault: the function below only
--     ever returns the key belonging to `auth.uid()`.
--   * It does NOT stop anyone with full database access from decrypting a
--     collection. We can. Say so in privacy.md rather than implying otherwise.
--
-- The honest alternative was plaintext, and this is strictly better than that
-- for the same effort. The honest ideal was keeping the passphrase, and that
-- ideal had a 0% adoption rate and cost somebody their cards.
--
-- SEPARATE TABLE, NOT A COLUMN ON `vaults`. A key stored beside the ciphertext
-- it decrypts protects against nothing at all — the entire (modest) value here
-- is that the two are separately grantable and separately dumpable. Never move
-- this into `vaults`, and never join them in a view.
--
-- ROLLBACK:
--   drop function if exists public.get_or_create_vault_key();
--   drop table if exists public.vault_keys;

create table if not exists public.vault_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  /** base64 of 32 random bytes — an AES-256-GCM key, minted server-side. */
  key text not null,
  created_at timestamptz not null default now()
);

comment on table public.vault_keys is
  'Per-user vault keys. Unreadable by any role through PostgREST; only get_or_create_vault_key() hands one out, and only to its owner.';

alter table public.vault_keys enable row level security;
-- No policies, and no grants. RLS with neither denies everything that does not
-- bypass it, so the ONLY route in is the security-definer function below.
revoke all on public.vault_keys from anon, authenticated;

/**
 * The caller's vault key, minted on first use.
 *
 * `auth.uid()` and nothing else decides whose key comes back — there is
 * deliberately no user-id argument, because a function that takes one is a
 * function someone will eventually call with a stranger's id.
 *
 * `gen_random_bytes` comes from pgcrypto, which Supabase enables by default in
 * the `extensions` schema; it is on the search path below so this works whether
 * the project installed it there or in `public`.
 */
create or replace function public.get_or_create_vault_key()
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_key  text;
begin
  if v_user is null then
    raise exception 'not_signed_in';
  end if;

  select k.key into v_key from public.vault_keys k where k.user_id = v_user;
  if v_key is not null then
    return v_key;
  end if;

  -- Two devices signing in at once must not mint two different keys, or one of
  -- them writes ciphertext the other cannot read. The conflict clause makes the
  -- loser adopt the winner's key rather than overwrite it.
  insert into public.vault_keys (user_id, key)
  values (v_user, encode(gen_random_bytes(32), 'base64'))
  on conflict (user_id) do update set key = public.vault_keys.key
  returning key into v_key;

  return v_key;
end;
$$;

revoke execute on function public.get_or_create_vault_key() from public, anon;
grant  execute on function public.get_or_create_vault_key() to authenticated;
