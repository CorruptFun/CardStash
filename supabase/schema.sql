-- Cardstock cloud vault — run once in the Supabase SQL editor.
--
-- One row per user, holding a blob this database CANNOT read: the app
-- encrypts with a key derived from the user's passphrase (src/lib/crypto.ts)
-- before upload. Sign-in decides which row you may touch; the passphrase
-- decides whether it means anything. Losing the passphrase loses the vault --
-- there is deliberately no reset path, because a reset path is a back door.

create table if not exists public.vaults (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  -- The VaultEnvelope from crypto.ts, as JSON: { v, salt, iv, ct }.
  envelope    jsonb not null,
  -- Non-secret fingerprint of the key, so a device can say "wrong
  -- passphrase" before downloading a large blob. See keyCheck().
  key_check   text not null,
  -- Bumped by the trigger on every write; the client sends the revision it
  -- last saw and a mismatch means another device wrote first -> merge.
  revision    bigint not null default 1,
  updated_at  timestamptz not null default now(),
  -- Free-text label of the last writer ("iPhone", "Chrome on Mac"), so the
  -- conflict message can name the other device. Never card data.
  device      text
);

alter table public.vaults enable row level security;

-- One policy covering all four verbs. This is deliberate, and it is the bug
-- that silently killed telemetry in a sibling project: an upsert executes
-- ON CONFLICT, which needs to READ the conflicting row. With only an INSERT
-- policy every upsert 401s -- including the very first one, which makes it
-- look like the table is broken rather than the policy.
drop policy if exists "own vault" on public.vaults;
create policy "own vault" on public.vaults
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- revision/updated_at are server-owned: a client that lies about them would
-- defeat the conflict check that stops one device overwriting another.
create or replace function public.bump_vault_revision()
returns trigger
language plpgsql
as $$
begin
  new.revision   := coalesce(old.revision, 0) + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists vaults_bump on public.vaults;
create trigger vaults_bump
  before insert or update on public.vaults
  for each row execute function public.bump_vault_revision();

-- Reject a write whose claimed base revision is not the current one. The
-- client calls this instead of a bare upsert, so a stale device is told to
-- pull and merge rather than silently clobbering the other device's cards.
create or replace function public.put_vault(
  p_envelope  jsonb,
  p_key_check text,
  p_device    text,
  p_base      bigint
)
returns public.vaults
language plpgsql
security invoker
as $$
declare
  current_rev bigint;
  result public.vaults;
begin
  select revision into current_rev from public.vaults where user_id = auth.uid();

  if current_rev is not null and p_base is distinct from current_rev then
    raise exception 'vault_conflict:%', current_rev using errcode = 'P0001';
  end if;

  insert into public.vaults (user_id, envelope, key_check, device)
    values (auth.uid(), p_envelope, p_key_check, p_device)
  on conflict (user_id) do update
    set envelope = excluded.envelope,
        key_check = excluded.key_check,
        device = excluded.device
  returning * into result;

  return result;
end;
$$;
