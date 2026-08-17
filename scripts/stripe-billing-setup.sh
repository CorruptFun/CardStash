#!/bin/zsh
# stripe-billing-setup.sh — the Monday checklist, as one command.
#
# Creates everything `supabase/functions/stripe-billing` needs and is currently
# missing (checkout answers 503 "not configured" until this runs):
#
#   1. one Product ("Cardstock") with the three prices the code sells:
#        founding  $6.99  one-off   (first 100, referred)
#        referred  $9.99  /year     (referred, after the seats go)
#        standard  $11.99 /year     (everyone else)
#   2. the billing webhook endpoint (checkout.session.completed +
#      customer.subscription.*) pointed at the stripe-billing function
#   3. a Customer Portal configuration (the /checkout "managing" path creates
#      portal sessions against the account default)
#   4. sets the four Supabase secrets, without ever printing them
#
# TEST MODE BY DEFAULT. Run once bare to rehearse against the test account,
# then `./scripts/stripe-billing-setup.sh --live` for the real one.
#
# Notes that matter:
#   * `--project-name cardstash` on every stripe call — the `default` profile
#     is ReformHER (vault rule, easy to forget, expensive to get wrong).
#   * STRIPE_BILLING_WEBHOOK_SECRET is billing's OWN secret. Never reuse
#     STRIPE_WEBHOOK_SECRET — that is escrow's, and a single-secret verifier
#     silently 401s every delivery from the other endpoint.
#   * Idempotent-ish: re-running creates duplicate prices/webhooks rather than
#     failing, so check `stripe prices list` first if unsure whether it ran.
#   * The live key on this machine is RESTRICTED (rk_live_…). If a step answers
#     "permission denied for this key", do that step in the dashboard instead —
#     the script prints what it was about to create.
set -euo pipefail

MODE_FLAG=""
MODE_NAME="TEST"
if [[ "${1:-}" == "--live" ]]; then MODE_FLAG="--live"; MODE_NAME="LIVE"; fi

PROJECT=(--project-name cardstash)
REF="xvfuyvaehtdxroyzixak"
FN_URL="https://${REF}.supabase.co/functions/v1/stripe-billing/webhook"

echo "== stripe-billing setup, ${MODE_NAME} mode =="

sid() { python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"; }

echo "-- 1/4 product + three prices"
PRODUCT_ID=$(stripe products create "${PROJECT[@]}" $MODE_FLAG \
  --name "Cardstock" \
  --description "Cloud scan rescue and the AI deck builder" | sid)
echo "   product: $PRODUCT_ID"

FOUNDING_PRICE=$(stripe prices create "${PROJECT[@]}" $MODE_FLAG \
  --product "$PRODUCT_ID" --currency usd --unit-amount 699 \
  --nickname "founding-lifetime-699" | sid)
echo "   founding (one-off \$6.99): $FOUNDING_PRICE"

REFERRED_PRICE=$(stripe prices create "${PROJECT[@]}" $MODE_FLAG \
  --product "$PRODUCT_ID" --currency usd --unit-amount 999 \
  -d "recurring[interval]=year" \
  --nickname "referred-year-999" | sid)
echo "   referred (\$9.99/yr): $REFERRED_PRICE"

STANDARD_PRICE=$(stripe prices create "${PROJECT[@]}" $MODE_FLAG \
  --product "$PRODUCT_ID" --currency usd --unit-amount 1199 \
  -d "recurring[interval]=year" \
  --nickname "standard-year-1199" | sid)
echo "   standard (\$11.99/yr): $STANDARD_PRICE"

echo "-- 2/4 webhook endpoint -> $FN_URL"
WEBHOOK_JSON=$(stripe webhook_endpoints create "${PROJECT[@]}" $MODE_FLAG \
  --url "$FN_URL" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.created" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted" \
  --description "cardstock billing (subscription lifecycle)")
WEBHOOK_ID=$(echo "$WEBHOOK_JSON" | sid)
# The signing secret is returned ONCE, here. It goes straight into the Supabase
# secret and is never echoed.
WEBHOOK_SECRET=$(echo "$WEBHOOK_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['secret'])")
echo "   webhook: $WEBHOOK_ID (secret captured, not shown)"

echo "-- 3/4 customer portal configuration"
stripe billing_portal configurations create "${PROJECT[@]}" $MODE_FLAG \
  -d "business_profile[headline]=Cardstock" \
  -d "features[customer_update][enabled]=false" \
  -d "features[invoice_history][enabled]=true" \
  -d "features[payment_method_update][enabled]=true" \
  -d "features[subscription_cancel][enabled]=true" \
  -d "features[subscription_cancel][mode]=at_period_end" \
  -d "default_return_url=https://cardstock.corrupt.solutions/" > /dev/null \
  && echo "   portal configuration created" \
  || echo "   !! portal configuration failed — activate it in the dashboard (Settings → Billing → Customer portal)"

if [[ "$MODE_NAME" == "LIVE" ]]; then
  echo "-- 4/4 supabase secrets (project $REF)"
  supabase secrets set --project-ref "$REF" \
    "STRIPE_PRICE_ID=$STANDARD_PRICE" \
    "STRIPE_FOUNDING_PRICE_ID=$FOUNDING_PRICE" \
    "STRIPE_REFERRED_PRICE_ID=$REFERRED_PRICE" \
    "STRIPE_BILLING_WEBHOOK_SECRET=$WEBHOOK_SECRET"
  echo "   secrets set. Functions read them per-request — no redeploy needed."
else
  echo "-- 4/4 SKIPPED secrets in test mode (would set STRIPE_PRICE_ID=$STANDARD_PRICE etc.)"
  echo "   Re-run with --live to configure the real account and set them."
fi

echo "== done. Verify: curl -s -X POST https://${REF}.supabase.co/functions/v1/stripe-billing/checkout  (expect 401 'sign in required', NOT 503) =="
