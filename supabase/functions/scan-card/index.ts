/**
 * scan-card — the hosted cloud scan rescue.
 *
 * Holds the Gemini API key server-side and will not call Google until it has
 * checked that the caller is signed in AND entitled AND under their monthly
 * allowance. That check is the entire reason this function exists: the app
 * deploys as a static bundle, so a key shipped to the client is public, and an
 * unauthenticated proxy is the same thing with extra steps.
 *
 * Contract (matches CloudCardRead in src/lib/gemini.ts):
 *   POST { image: "<base64 jpeg>", model?: string }
 *   200  { name, number?, printedTotal?, setCode?, game?, remaining }
 *   401  not signed in            403  not entitled
 *   429  allowance exhausted      502  upstream Gemini failure
 *
 * The client treats EVERY non-200 the same way — as a local miss — so scanning
 * degrades to on-device rather than erroring. Do not make the client branch on
 * these; they are for logs and for the Settings screen, not the viewfinder.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/** Monthly allowance per subscriber. Generous — a heavy month of binder work. */
const MONTHLY_LIMIT = Number(Deno.env.get('SCAN_MONTHLY_LIMIT') ?? '1000')

/**
 * Pinned server-side, NOT taken from the request. A client-chosen model is a
 * client-chosen bill: nothing stops a caller asking for the most expensive
 * tier on every scan. Measured, the lite tier reads these cards 6/6 anyway.
 */
const MODEL = Deno.env.get('GEMINI_SCAN_MODEL') ?? 'gemini-3.1-flash-lite'

/** A card photo at capture size is ~250KB of base64; this is a sanity ceiling. */
const MAX_IMAGE_BYTES = 6_000_000

const PROMPT =
  'You are reading a trading card photograph for a collection app. ' +
  'Return the card NAME exactly as printed, including any suffix that is part of the name ' +
  "(ex, GX, V, VMAX, VSTAR) and any possessive prefix (\"Iono's\", \"Team Rocket's\"). " +
  'Also return the collector number and printed set total from the small collector line ' +
  '(for "055/086": number "055", printedTotal "086"), and the printed set code if visible. ' +
  'CRITICAL: omit any field you cannot actually read on the card. Never guess a number. ' +
  'An omitted field is correct; an invented one is not.'

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    number: { type: 'STRING' },
    printedTotal: { type: 'STRING' },
    setCode: { type: 'STRING' },
    game: { type: 'STRING' },
  },
  required: ['name'],
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY')
  if (!GEMINI_KEY) return json({ error: 'not configured' }, 503)

  // --- who is calling ------------------------------------------------------
  // The caller's own JWT, verified by asking GoTrue rather than by decoding it
  // here: a locally-parsed token is a token nobody checked the signature of.
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return json({ error: 'sign in required' }, 401)
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: SERVICE_KEY },
  }).catch(() => null)
  if (!who?.ok) return json({ error: 'sign in required' }, 401)
  const user = await who.json()
  if (!user?.id) return json({ error: 'sign in required' }, 401)

  // --- may they, and have they got any left --------------------------------
  // Entitlement and metering in ONE statement: read-then-write would let the
  // nine concurrent identifications of a binder page each read the same count.
  const credit = await fetch(`${SUPABASE_URL}/rest/v1/rpc/consume_scan_credit`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_user: user.id, p_limit: MONTHLY_LIMIT }),
  }).catch(() => null)
  if (!credit?.ok) return json({ error: 'entitlement check failed' }, 503)
  const remaining = Number(await credit.json())
  if (remaining < 0) return json({ error: 'not subscribed' }, 403)
  if (remaining === 0) return json({ error: 'monthly allowance used' }, 429)

  // --- read the card -------------------------------------------------------
  let image: string
  try {
    const body = await req.json()
    image = String(body?.image ?? '')
  } catch {
    return json({ error: 'bad request' }, 400)
  }
  if (!image || image.length > MAX_IMAGE_BYTES) return json({ error: 'bad image' }, 400)

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
      generationConfig: {
        temperature: 0,
        // Room for a thinking model's reasoning tokens. Measured: a 200 cap let
        // gemini-3.5-flash burn ~380 thinking tokens and return an EMPTY body
        // with finishReason MAX_TOKENS — a silent null at full price.
        maxOutputTokens: 2000,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
      },
    }),
  }).catch(() => null)
  if (!res?.ok) return json({ error: 'upstream failed' }, 502)

  const payload = await res.json().catch(() => null)
  const text = (payload?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('').trim()
  let parsed: any = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return json({ error: 'unreadable' }, 502)
  }
  if (!parsed?.name) return json({ error: 'unreadable' }, 502)

  return json({
    name: String(parsed.name),
    number: parsed.number ? String(parsed.number) : undefined,
    printedTotal: parsed.printedTotal ? String(parsed.printedTotal) : undefined,
    setCode: parsed.setCode ? String(parsed.setCode) : undefined,
    game: parsed.game ? String(parsed.game) : undefined,
    remaining,
  })
})
