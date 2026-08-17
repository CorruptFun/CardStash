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
 *   200  { name, number?, printedTotal?, setCode?, game?, treatment?, foil?, remaining }
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
 * What someone with NO subscription gets. A rescue costs ~$0.00015, so this is
 * pennies a year and it is the difference between a scanner that looks like it
 * works and one that looks broken to the people deciding whether to pay.
 *
 * ORDINARY SCANNING IS NOT METERED — it runs on the device and costs nothing.
 * Only this fallback, for a card the local pipeline could not read, is counted.
 */
const FREE_MONTHLY_LIMIT = Number(Deno.env.get('SCAN_FREE_MONTHLY_LIMIT') ?? '50')

/**
 * Pinned server-side, NOT taken from the request. A client-chosen model is a
 * client-chosen bill: nothing stops a caller asking for the most expensive
 * tier on every scan. Measured, the lite tier reads these cards 6/6 anyway.
 */
const MODEL = Deno.env.get('GEMINI_SCAN_MODEL') ?? 'gemini-3.1-flash-lite'

/** A card photo at capture size is ~250KB of base64; this is a sanity ceiling. */
const MAX_IMAGE_BYTES = 6_000_000

// The canonical copy — the harness mirrors it WORD FOR WORD as SCAN_PROMPT in
// tests/harness/run-matrix.mjs. The rescue in src/lib/identify.ts parses what
// this returns, so a prompt that drifts here is a field the client quietly
// stops getting.
const PROMPT =
  'You are reading a trading card photograph for a collection app. ' +
  'Return the card NAME exactly as printed, including any suffix that is part of the name ' +
  "(ex, GX, V, VMAX, VSTAR) and any possessive prefix (\"Iono's\", \"Team Rocket's\"). " +
  'Also return the collector number and printed set total from the small collector line ' +
  '(for "055/086": number "055", printedTotal "086"), and the printed set code if visible. ' +
  'Magic cards print that line as two rows in a bottom corner — "0321 U" over "MSH★EN" — ' +
  'giving number "0321" and setCode "MSH", with no printed total to return. Its separator ' +
  'is sometimes a star (★) rather than a dot (•), and its number is sometimes higher than the set ' +
  'actually holds; both mark a special printing, so transcribe the digits exactly as they ' +
  'appear and do not normalise them. On full-art and borderless cards this line is printed ' +
  'over the artwork in small light or dark type close to the card edge — look for it there too. ' +
  'Then judge the FRAME and return treatment: "borderless" when the artwork runs to the card ' +
  'edges with no border at all, "extended" when a thin border remains but the art reaches the ' +
  'sides, "showcase" for an alternate stylised frame, "retro" for an old-style frame, ' +
  '"regular" for the ordinary modern frame; and foil: true only when the surface clearly ' +
  'shows holographic shine. Those two describe the printing rather than transcribe it, so ' +
  'answer them only when the card is clearly enough visible to judge. ' +
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
    // A plain STRING, not a schema `enum`: the client's `asTreatment` is the
    // vocabulary check, and it costs nothing when the answer is unrecognised.
    // A schema rejection here would lose the whole read, name included.
    treatment: { type: 'STRING' },
    foil: { type: 'BOOLEAN' },
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
    body: JSON.stringify({ p_user: user.id, p_limit: MONTHLY_LIMIT, p_free_limit: FREE_MONTHLY_LIMIT }),
  }).catch(() => null)
  if (!credit?.ok) return json({ error: 'entitlement check failed' }, 503)
  const remaining = Number(await credit.json())
  // A non-finite answer is NOT permission. If the RPC ever changes shape, this
  // must fail closed rather than hand out a paid call to everyone.
  if (!Number.isFinite(remaining)) return json({ error: 'entitlement check failed' }, 503)
  // -1 = not entitled; -2 = over the cap (0023). Zero is a VALID answer: the
  // month's last credit, consumed and spendable -- refusing it ate a call the
  // allowance had already paid for.
  if (remaining === -1) return json({ error: 'not subscribed' }, 403)
  if (remaining < 0) return json({ error: 'monthly allowance used' }, 429)

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
    treatment: parsed.treatment ? String(parsed.treatment) : undefined,
    foil: typeof parsed.foil === 'boolean' ? parsed.foil : undefined,
    remaining,
  })
})
