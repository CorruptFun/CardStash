/**
 * The AI deck builder, on OUR Gemini key.
 *
 * Users used to paste their own key into Settings. They no longer can, and no
 * longer should have to — the builder is part of what a subscription buys, so
 * the key is ours and is spent under the same entitlement-and-allowance check
 * `scan-card` performs. The whole reason this function exists is that a key
 * which costs money cannot be defended from a static bundle (decision 2a).
 *
 * THE PROMPT IS BUILT HERE, NOT SENT HERE, and that is the security boundary
 * rather than a style choice. If the client posted prose we would be running a
 * general-purpose LLM on our bill for anyone with an account: send "write my
 * dissertation", pay nothing. Accepting only a STRUCTURED request — game,
 * format, style, budget, a card list — means the key can only ever be spent on
 * the thing it is for. The cost is that `DECKLIST_SPEC` exists both here and in
 * `src/lib/gemini.ts`; keep them in step, and prefer duplication to letting
 * arbitrary text reach the model.
 *
 *   200  { markdown }              400  malformed request
 *   401  not signed in             403  not entitled
 *   429  allowance exhausted       502  upstream Gemini failure
 *   503  no key configured        (dormant, exactly as scan-card is)
 *
 * Unlike `scan-card`, failures are NOT silently swallowed by the caller. A scan
 * must never explain billing to someone holding a card; a deck build is a
 * deliberate act with a spinner, and "you are out of builds this month" is the
 * only honest thing to show.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/** Builds per subscriber per month. A build is far dearer than a scan. */
const MONTHLY_LIMIT = Number(Deno.env.get('BUILD_MONTHLY_LIMIT') ?? '60')
const MODEL = Deno.env.get('GEMINI_BUILD_MODEL') ?? 'gemini-flash-latest'

/** Caps, so one request cannot become an essay's worth of tokens. */
const MAX_COLLECTION_CHARS = 60_000
const MAX_STYLE_CHARS = 300
const MAX_SEEDS = 12

const GAME_FULL_NAME: Record<string, string> = {
  mtg: 'Magic: The Gathering',
  pokemon: 'Pokémon TCG',
  yugioh: 'Yu-Gi-Oh!',
  riftbound: 'Riftbound: League of Legends TCG',
  lorcana: 'Disney Lorcana',
  onepiece: 'One Piece Card Game',
  starwars: 'Star Wars: Unlimited',
  digimon: 'Digimon Card Game',
  gundam: 'Gundam Card Game',
}

/** Mirrors DECKLIST_SPEC in src/lib/gemini.ts — keep the two in step. */
const DECKLIST_SPEC: Record<string, string> = {
  mtg: ' (60-card main deck; then a line `-- Sideboard --` and up to 15 cards).',
  pokemon: ' (exactly 60 cards including energy).',
  yugioh: ' (40-60 main deck; then `-- Extra Deck --` up to 15).',
  riftbound: ' (40-card main deck plus the champion and legend lines).',
  lorcana: ' (exactly 60 cards, max 4 of any card).',
  onepiece: ' (exactly 50 cards plus one leader line).',
  starwars: ' (50-card deck plus leader and base lines).',
  digimon: ' (main deck, exactly 50 cards; then a line `-- Egg Deck --` and up to 5 Digi-Eggs).',
  gundam: ' (exactly 50 cards; resource deck is fixed, skip it).',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const clamp = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

function buildPrompt(body: Record<string, unknown>): string | null {
  const game = clamp(body.game, 24)
  if (!GAME_FULL_NAME[game]) return null

  const seeds = Array.isArray(body.seedCards) ? body.seedCards.slice(0, MAX_SEEDS) : []
  const seedList = seeds
    .map((c: Record<string, unknown>) => {
      const name = clamp(c?.name, 120)
      const set = clamp(c?.setName, 80)
      return name ? `- ${name}${set ? ` (${set})` : ''}` : ''
    })
    .filter(Boolean)
    .join('\n')

  const budget = Number(body.budget)
  const collectionList = clamp(body.collectionList, MAX_COLLECTION_CHARS)
  const useCollection = body.useCollection === true && !!collectionList

  return [
    `You are an expert ${GAME_FULL_NAME[game]} deck builder. Use Google Search to check the CURRENT competitive metagame (tier lists, recent tournament results) before answering.`,
    clamp(body.format, 60) ? `Format: ${clamp(body.format, 60)}.` : '',
    clamp(body.style, MAX_STYLE_CHARS) ? `The player wants: ${clamp(body.style, MAX_STYLE_CHARS)}.` : '',
    seedList
      ? `Build every deck AROUND these specific cards — each proposal must include them and make them central to the game plan:\n${seedList}`
      : '',
    Number.isFinite(budget) && budget > 0 ? `Budget for cards they still need to buy: about $${Math.round(budget)} USD.` : '',
    useCollection
      ? `The player's collection (name ×qty):\n${collectionList}\n\nBuild primarily from these cards; only add cards to buy when they matter.`
      : 'Assume the player is starting from scratch.',
    '',
    'Reply in markdown with exactly this structure:',
    '1. `## Meta snapshot` — 3-5 bullets on the current meta with dates/sources.',
    '2. Then 2 deck proposals. Each one:',
    '   - `## Deck: <deck name>` — one line on the game plan and why it fits.',
    '   - A fenced code block starting with ```decklist containing ONLY lines of the form `<qty> <exact card name>`' +
      (DECKLIST_SPEC[game] ?? '.'),
    '   - `**To buy:**` bullets of the key cards they lack, with rough per-card prices.',
    'Keep total response under 900 words. Card names must be exact printed names.',
  ]
    .filter(Boolean)
    .join('\n')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY')
  if (!GEMINI_KEY) return json({ error: 'not configured' }, 503)

  // --- who is calling ------------------------------------------------------
  // Verified by asking GoTrue, not by decoding here: a locally-parsed token is
  // a token nobody checked the signature of.
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return json({ error: 'sign in required' }, 401)
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: SERVICE_KEY },
  }).catch(() => null)
  if (!who?.ok) return json({ error: 'sign in required' }, 401)
  const user = await who.json()
  if (!user?.id) return json({ error: 'sign in required' }, 401)

  // --- may they, and have they got any left --------------------------------
  const credit = await fetch(`${SUPABASE_URL}/rest/v1/rpc/consume_build_credit`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_user: user.id, p_limit: MONTHLY_LIMIT }),
  }).catch(() => null)
  if (!credit?.ok) return json({ error: 'entitlement check failed' }, 503)
  const remaining = Number(await credit.json())
  if (remaining < 0) return json({ error: 'not subscribed' }, 403)
  if (remaining === 0) return json({ error: 'monthly allowance used' }, 429)

  // --- build ---------------------------------------------------------------
  let prompt: string | null
  try {
    prompt = buildPrompt((await req.json()) as Record<string, unknown>)
  } catch {
    return json({ error: 'bad request' }, 400)
  }
  if (!prompt) return json({ error: 'bad request' }, 400)

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.6, maxOutputTokens: 4096 },
    }),
  }).catch(() => null)
  if (!res?.ok) return json({ error: 'upstream failed' }, 502)

  const payload = await res.json().catch(() => null)
  const markdown: string = (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p?.text ?? '')
    .join('')
    .trim()
  if (!markdown) return json({ error: 'upstream failed' }, 502)

  // Parsing into decklists stays on the client: it is presentation logic, it is
  // already unit-tested there, and an older bundle must keep working against
  // this function without a redeploy.
  return json({ markdown, remaining: remaining - 1 })
})
