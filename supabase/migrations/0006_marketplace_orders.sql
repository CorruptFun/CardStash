-- 0006_marketplace_orders.sql
--
-- Marketplace, part 1: paying a friend for a card. `seller_accounts` (who may
-- receive money) and `orders` (one sale, and where it has got to).
--
-- WHY IT EXISTS AT ALL. A trade only happens when both people want something
-- the other has. Buying is the escape hatch, and it needs somewhere to hold the
-- buyer's money between "paid" and "the card arrived" -- which is the whole
-- feature, and the reason none of it can live in the client.
--
-- WHERE THE MONEY ACTUALLY IS. Not here. Stripe holds it: the buyer is charged
-- to OUR platform balance, and a Transfer to the seller's connected account is
-- created on release (Stripe calls this "separate charges and transfers"). This
-- table records what state that arrangement is in; it never holds a balance.
-- That distinction is legal as well as technical -- Stripe is the licensed
-- custodian, we only direct the release.
--
-- TRUST MODEL -- read this before changing a policy:
--   * A signed-in user may READ an order they are the buyer or the seller of.
--     Nobody else may, including friends of either party.
--   * NOBODY may INSERT, UPDATE or DELETE an order through PostgREST. Not the
--     buyer, not the seller. Every state change goes through one of the
--     functions below, which check who is asking and what the current state is.
--     A user who could UPDATE this table directly could mark their own order
--     'delivered' and collect a stranger's money, or rewrite `fee_cents` to
--     zero. Those are the same bug.
--   * `seller_accounts` is READ-OWN and WRITE-NOBODY for the same reason, but a
--     sharper one: `stripe_account_id` is where money goes. A user who could
--     write another user's row could redirect that person's payouts to
--     themselves. It is the single most dangerous column in the schema.
--   * Money transitions (paid / released / refunded) are `service_role` only --
--     they are facts Stripe reports, never things a user asserts. Fulfilment
--     transitions (shipped / delivered / disputed) are the users' to make, and
--     are the only functions granted to `authenticated`.
--
-- AMOUNTS ARE INTEGER CENTS. Never a float, never a numeric that someone will
-- eventually round twice. `usd` is the only currency and the check enforces it
-- rather than leaving a column that looks multi-currency and is not.
--
-- WHY ORDERS SURVIVE `erase_social()`. That function deliberately does not
-- touch this table, and neither does account deletion -- `buyer` and `seller`
-- are `on delete set null` rather than `cascade`. A completed sale is a
-- financial record: it backs a 1099-K, a chargeback response and a tax return,
-- and none of those stop being true because someone closed their account. The
-- privacy cost is bounded on purpose -- an orphaned row keeps no name, no
-- handle and no address, only two nulls and an amount, and RLS makes it
-- invisible to every user (a null is never equal to an `auth.uid()`), leaving
-- it readable by the service role alone.
--
-- ADDRESSES ARE NOT HERE, AND MUST NOT BE ADDED. The buyer's shipping address
-- stays on the Stripe Checkout Session; the seller's app fetches it through an
-- edge function that checks it is asking about its own paid order. Adding an
-- address column here would put plaintext PII beside `binders` and, once it
-- reached a client, would ride into the JSON backup, the CSV export and the
-- daily Google Drive backup. See docs/privacy.md rule 5.
--
-- GRANTS ARE NOT OPTIONAL: Supabase projects created from ~2026 no longer grant
-- DML on new public tables. PostgREST returns `42501 permission denied` BEFORE
-- it consults any policy, so a table with flawless RLS still fails every
-- request. Grant explicitly, always. Do not delete these on the grounds that
-- Supabase does it automatically; it does not.
--
-- ORDERING: safe to apply before the client ships. It only ADDS tables and
-- functions -- no deployed client reads any of this yet, and nothing existing
-- loses access. `erase_social()` is NOT modified, so 0004 stands as written.
--
-- ROLLBACK:
--   drop function if exists public.raise_dispute(uuid, text);
--   drop function if exists public.confirm_receipt(uuid);
--   drop function if exists public.mark_shipped(uuid, text);
--   drop function if exists public.advance_order(uuid, text, jsonb);
--   drop function if exists public.open_order(uuid, uuid, text, text, integer, integer, integer, integer);
--   drop function if exists public.can_sell(uuid);
--   drop table if exists public.orders;
--   drop table if exists public.seller_accounts;

-- ------------------------------------------------------------ seller_accounts

create table if not exists public.seller_accounts (
  user_id           uuid        primary key references auth.users(id) on delete cascade,
  -- The Stripe connected account (`acct_...`). Unique because two of our users
  -- sharing one payout destination is either a mistake or an attack.
  stripe_account_id text        not null unique,
  -- Mirrored from Stripe's `account.updated` webhook. `payouts_enabled` is the
  -- one that gates selling: an account that has not finished identity
  -- verification can be transferred to and then cannot pay out, which strands
  -- the money somewhere neither party can reach.
  payouts_enabled   boolean     not null default false,
  charges_enabled   boolean     not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.seller_accounts enable row level security;

-- Read your own row, so the UI can say "you're set up to sell" and, when you
-- are not, "finish verifying with Stripe". Nothing else is readable: whether
-- someone ELSE can sell is answered by can_sell() below, which returns a
-- boolean rather than an account id.
drop policy if exists seller_accounts_read_own on public.seller_accounts;
create policy seller_accounts_read_own
  on public.seller_accounts for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert/update/delete policy exists on purpose. Absent a policy, RLS denies.
grant select on public.seller_accounts to authenticated;
grant select, insert, update, delete on public.seller_accounts to service_role;

-- -------------------------------------------------------------------- orders

create table if not exists public.orders (
  id             uuid        primary key default gen_random_uuid(),
  -- Nullable and `set null`, not `cascade` -- see the header. A closed account
  -- must not erase the other party's record of a sale that really happened.
  buyer          uuid        references auth.users(id) on delete set null,
  seller         uuid        references auth.users(id) on delete set null,

  status         text        not null default 'pending'
                             check (status in ('pending','paid','shipped','delivered',
                                               'released','refunded','cancelled','disputed')),

  -- WHAT WAS BOUGHT, denormalised on purpose. The seller's binder is a living
  -- document they can edit or unpublish; an order must still say what it was
  -- for a year later, in a chargeback, when that row is long gone.
  card_id        text        not null check (length(card_id) between 1 and 160),
  card_name      text        not null check (length(card_name) between 1 and 200),
  qty            integer     not null default 1 check (qty between 1 and 99),

  -- MONEY, IN INTEGER CENTS. `fee_cents` is ours; the seller receives
  -- item + shipping - fee. Stored rather than recomputed so that changing the
  -- fee schedule later cannot silently restate what someone already agreed to.
  item_cents     integer     not null check (item_cents >= 0),
  shipping_cents integer     not null default 0 check (shipping_cents >= 0),
  fee_cents      integer     not null check (fee_cents >= 0),
  currency       text        not null default 'usd' check (currency = 'usd'),

  -- STRIPE HANDLES. Nullable because they arrive at different moments.
  -- `checkout_session_id` is unique so a replayed webhook cannot open a second
  -- order for one payment, and it is how the seller's app finds the shipping
  -- address without us storing one.
  checkout_session_id text   unique,
  payment_intent_id   text,
  charge_id           text,
  transfer_id         text,

  -- Tracking is optional and free-text: most people post a card in an envelope
  -- and have nothing to give. Capped so it cannot become a message channel.
  tracking       text        check (tracking is null or length(tracking) <= 64),

  created_at     timestamptz not null default now(),
  paid_at        timestamptz,
  shipped_at     timestamptz,
  delivered_at   timestamptz,
  released_at    timestamptz,
  refunded_at    timestamptz,
  disputed_at    timestamptz
);

-- "My orders", both directions, newest first -- the only query the app makes.
create index if not exists orders_buyer_idx  on public.orders (buyer,  created_at desc);
create index if not exists orders_seller_idx on public.orders (seller, created_at desc);
-- The sweep's query: things whose timer may have expired.
create index if not exists orders_status_idx on public.orders (status, shipped_at, paid_at);

alter table public.orders enable row level security;

-- Both parties read the order, and nobody else does. Kept as one policy rather
-- than two because the audiences are genuinely the same set with the same
-- rights -- unlike binders, where each audience has its own reason.
drop policy if exists orders_read_own on public.orders;
create policy orders_read_own
  on public.orders for select
  to authenticated
  using (auth.uid() = buyer or auth.uid() = seller);

-- No write policy of any kind. Every mutation is a function below.
grant select on public.orders to authenticated;
grant select, insert, update, delete on public.orders to service_role;

-- ------------------------------------------------------------------ can_sell

/**
 * Can `p_user` be paid for a card by the caller?
 *
 * Answers a boolean rather than exposing `seller_accounts`, so the Buy button
 * can be hidden without anybody learning another user's Stripe account id.
 *
 * Both halves are load-bearing. Friendship is the marketplace's scope: this
 * release lets you buy from people you have accepted, and nobody else.
 * `payouts_enabled` is Stripe's word that the seller finished verification --
 * without it a Transfer would land in an account that cannot pay out, stranding
 * the money where neither party can reach it.
 *
 * SECURITY DEFINER because it reads `seller_accounts`, which the caller cannot
 * see, and `friendships` from a side the caller may not be able to read.
 */
create or replace function public.can_sell(p_user uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null
     and p_user is not null
     and p_user <> auth.uid()
     and public.are_friends(auth.uid(), p_user)
     and exists (
       select 1 from public.seller_accounts s
        where s.user_id = p_user and s.payouts_enabled
     );
$$;

revoke execute on function public.can_sell(uuid) from public, anon;
grant  execute on function public.can_sell(uuid) to authenticated;

-- ---------------------------------------------------------------- open_order

/**
 * Open a pending order. Called by the `stripe-escrow` edge function with the
 * service role, AFTER it has established the buyer's identity from their own
 * JWT -- never by a client.
 *
 * WHY NOT LET THE BUYER CALL THIS. Because the caller supplies the amounts, and
 * a buyer who could name their own price would. The edge function computes item
 * price, shipping and fee from the seller's published binder and the fee
 * schedule, then hands them here. This function's job is the rules the edge
 * function must not be trusted to remember: that the two are friends, that the
 * seller can actually be paid, and that the money adds up.
 *
 * The floor is not decoration. Stripe takes 2.9% + 30c of every charge and we
 * pay it, so a $2 sale costs more to process than it earns; and the fee must
 * never exceed what is being charged, or the transfer on release would be
 * negative.
 */
create or replace function public.open_order(
  p_buyer          uuid,
  p_seller         uuid,
  p_card_id        text,
  p_card_name      text,
  p_qty            integer,
  p_item_cents     integer,
  p_shipping_cents integer,
  p_fee_cents      integer
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Below this a sale loses money after Stripe's cut. Mirrored in logic.ts's
  -- fee arithmetic; this is the copy that is actually enforced.
  c_min_total constant integer := 500;
  v_total  integer;
  v_result public.orders;
begin
  if p_buyer is null or p_seller is null or p_buyer = p_seller then
    raise exception 'bad_parties' using errcode = 'P0001';
  end if;

  -- Friendship, checked from the BUYER's side explicitly. can_sell() reads
  -- auth.uid(), which is the service role here and therefore meaningless.
  if not public.are_friends(p_buyer, p_seller) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.seller_accounts s
     where s.user_id = p_seller and s.payouts_enabled
  ) then
    raise exception 'seller_not_ready' using errcode = 'P0001';
  end if;

  if p_qty is null or p_qty < 1 or p_qty > 99 then
    raise exception 'bad_quantity' using errcode = 'P0001';
  end if;

  v_total := coalesce(p_item_cents, 0) + coalesce(p_shipping_cents, 0);
  if p_item_cents is null or p_item_cents < 0
     or p_shipping_cents is null or p_shipping_cents < 0
     or p_fee_cents is null or p_fee_cents < 0 then
    raise exception 'bad_amount' using errcode = 'P0001';
  end if;
  if v_total < c_min_total then
    raise exception 'below_minimum' using errcode = 'P0001';
  end if;
  -- A fee at or above the total would leave the seller nothing or less.
  if p_fee_cents >= v_total then
    raise exception 'bad_fee' using errcode = 'P0001';
  end if;

  insert into public.orders (
    buyer, seller, card_id, card_name, qty, item_cents, shipping_cents, fee_cents
  ) values (
    p_buyer, p_seller, left(p_card_id, 160), left(p_card_name, 200), p_qty,
    p_item_cents, p_shipping_cents, p_fee_cents
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.open_order(uuid, uuid, text, text, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.open_order(uuid, uuid, text, text, integer, integer, integer, integer)
  to service_role;

-- ------------------------------------------------------------- advance_order

/**
 * The money transitions, and the one place the legal state graph is written
 * down.
 *
 * THIS IS THE ONLY COPY OF THE TRANSITION TABLE, deliberately. It was tempting
 * to mirror it in the edge function's logic.ts so it could be unit-tested in
 * node, but two authorities on a money state machine disagree eventually, and
 * the one that loses is always the one that is not actually guarding the row.
 * logic.ts decides what a Stripe event MEANS; this decides whether that is
 * allowed. The pairs are proven by tests/harness/escrow-rls.mjs against real
 * SQL rather than against a copy.
 *
 * `service_role` only. Every transition here is a fact Stripe reported -- the
 * charge succeeded, the transfer went out, the refund cleared -- and none of
 * them is something a user may assert about their own order.
 *
 * Idempotent by design: advancing to the state an order is already in is a
 * no-op that returns the row. The sweep runs on pg_cron, which does not retry
 * skipped ticks and cheerfully double-fires, and Stripe redelivers webhooks.
 */
create or replace function public.advance_order(
  p_order  uuid,
  p_to     text,
  -- {checkout_session_id, payment_intent_id, charge_id, transfer_id} -- any
  -- subset; a key that is absent leaves the column as it was.
  p_stripe jsonb default '{}'::jsonb
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from   text;
  v_ok     boolean;
  v_result public.orders;
begin
  select status into v_from from public.orders where id = p_order for update;
  if v_from is null then
    raise exception 'no_such_order' using errcode = 'P0001';
  end if;

  -- Already there. Return the row rather than raising, so a redelivered
  -- webhook is a success and Stripe stops retrying it.
  if v_from = p_to then
    select * into v_result from public.orders where id = p_order;
    return v_result;
  end if;

  v_ok := case
    -- The buyer paid. Money is now in the platform balance.
    when v_from = 'pending'   and p_to = 'paid'      then true
    -- Never paid, or the session expired.
    when v_from = 'pending'   and p_to = 'cancelled' then true
    -- Paid but never sent: the sweep refunds it.
    when v_from = 'paid'      and p_to = 'refunded'  then true
    when v_from = 'shipped'   and p_to = 'refunded'  then true
    when v_from = 'delivered' and p_to = 'refunded'  then true
    -- A dispute resolved for the buyer, after the timer was frozen.
    when v_from = 'disputed'  and p_to = 'refunded'  then true
    -- ...or resolved for the seller, which puts it back on the release path.
    when v_from = 'disputed'  and p_to = 'delivered' then true
    -- The auto-release timer asserting delivery on a silent buyer's behalf.
    -- A user cannot reach this edge -- `confirm_receipt` is how a buyer says it
    -- arrived, and this function is service_role only. It exists so the sweep
    -- does not have to jump straight to 'released', which would leave
    -- `delivered_at` null and lose the record of why the money moved.
    when v_from = 'shipped'   and p_to = 'delivered' then true
    -- The only door money leaves by.
    when v_from = 'delivered' and p_to = 'released'  then true
    else false
  end;

  if not v_ok then
    raise exception 'bad_transition' using errcode = 'P0001';
  end if;

  update public.orders set
    status              = p_to,
    checkout_session_id = coalesce(p_stripe->>'checkout_session_id', checkout_session_id),
    payment_intent_id   = coalesce(p_stripe->>'payment_intent_id',   payment_intent_id),
    charge_id           = coalesce(p_stripe->>'charge_id',           charge_id),
    transfer_id         = coalesce(p_stripe->>'transfer_id',         transfer_id),
    paid_at             = case when p_to = 'paid'      then now() else paid_at      end,
    delivered_at        = case when p_to = 'delivered' then now() else delivered_at end,
    released_at         = case when p_to = 'released'  then now() else released_at  end,
    refunded_at         = case when p_to = 'refunded'  then now() else refunded_at  end
  where id = p_order
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.advance_order(uuid, text, jsonb) from public, anon, authenticated;
grant  execute on function public.advance_order(uuid, text, jsonb) to service_role;

-- ------------------------------------------- the two transitions users make

/**
 * The seller says they have posted it. `paid` -> `shipped`.
 *
 * SECURITY DEFINER because `orders` has no write policy at all -- but the
 * function re-checks `auth.uid() = seller` itself, so being definer buys the
 * ability to write the row and nothing else. A buyer calling this gets the same
 * `not_your_order` as a stranger: which of the two you are is not information
 * this function owes anybody.
 */
create or replace function public.mark_shipped(p_order uuid, p_tracking text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    public.orders;
  v_result public.orders;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;

  select * into v_row from public.orders where id = p_order for update;
  if v_row.id is null or v_row.seller is distinct from auth.uid() then
    raise exception 'not_your_order' using errcode = 'P0001';
  end if;
  if v_row.status <> 'paid' then
    raise exception 'bad_transition' using errcode = 'P0001';
  end if;

  update public.orders set
    status     = 'shipped',
    shipped_at = now(),
    tracking   = nullif(left(coalesce(p_tracking, ''), 64), '')
  where id = p_order
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.mark_shipped(uuid, text) from public, anon;
grant  execute on function public.mark_shipped(uuid, text) to authenticated;

/**
 * The buyer says it arrived and they are happy. `shipped` -> `delivered`.
 *
 * This does NOT move the money. Release is a separate transition made by the
 * edge function once it has actually created the Stripe Transfer, because a row
 * that said 'released' before the transfer existed would be a lie we would
 * later have to reconcile by hand.
 *
 * The same edge is reached without the buyer by the auto-release sweep. An
 * escrow with no timer is one where a buyer who stops replying keeps a seller's
 * money forever, which is a worse failure than releasing a few days early.
 */
create or replace function public.confirm_receipt(p_order uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    public.orders;
  v_result public.orders;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;

  select * into v_row from public.orders where id = p_order for update;
  if v_row.id is null or v_row.buyer is distinct from auth.uid() then
    raise exception 'not_your_order' using errcode = 'P0001';
  end if;
  if v_row.status <> 'shipped' then
    raise exception 'bad_transition' using errcode = 'P0001';
  end if;

  update public.orders set status = 'delivered', delivered_at = now()
   where id = p_order
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.confirm_receipt(uuid) from public, anon;
grant  execute on function public.confirm_receipt(uuid) to authenticated;

/**
 * The buyer raises a problem: it never came, or it is not what was described.
 * Freezes the auto-release timer and hands the order to a human.
 *
 * There is no automatic resolution and that is deliberate. Deciding whether a
 * card arrived in the condition promised is not something this schema can know,
 * and a coin flip dressed up as arbitration would be worse than admitting that
 * a person has to look.
 *
 * Note what is NOT stored: the reason text. `p_reason` is accepted and
 * discarded. An order carries no free-text field a user can write into, because
 * the moment one exists it is an unmoderated message channel between two people
 * who are by construction already in a dispute. The parameter is in the
 * signature so the client may send it and the contract does not have to change
 * on the day an operator inbox exists to receive it.
 */
create or replace function public.raise_dispute(p_order uuid, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    public.orders;
  v_result public.orders;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = 'P0001';
  end if;
  -- Accepted and ignored, so the client may send it and the signature does not
  -- have to change when an operator inbox exists to receive it.
  perform p_reason;

  select * into v_row from public.orders where id = p_order for update;
  if v_row.id is null or v_row.buyer is distinct from auth.uid() then
    raise exception 'not_your_order' using errcode = 'P0001';
  end if;
  -- Only while the money is still ours to hold. Once released it is gone, and
  -- the honest answer is a card-network chargeback rather than a state here.
  if v_row.status not in ('paid', 'shipped', 'delivered') then
    raise exception 'bad_transition' using errcode = 'P0001';
  end if;

  update public.orders set status = 'disputed', disputed_at = now()
   where id = p_order
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.raise_dispute(uuid, text) from public, anon;
grant  execute on function public.raise_dispute(uuid, text) to authenticated;
