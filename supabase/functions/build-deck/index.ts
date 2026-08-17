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
const MONTHLY_LIMIT = Number(Deno.env.get('BUILD_MONTHLY_LIMIT') ?? '12')
/**
 * The free taste. Small on purpose: a build is ~250x the cost of a rescue, so
 * this is the feature the subscription actually sells. Enough to feel what it
 * does and want more; not enough to be the product.
 */
const FREE_MONTHLY_LIMIT = Number(Deno.env.get('BUILD_FREE_MONTHLY_LIMIT') ?? '3')
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

/**
 * Ask Gemini, once a day per game, what the metagame currently looks like.
 * Grounded — this is the only call that pays for Google Search.
 */
function metaPrompt(game: string): string {
  return [
    `Use Google Search to check the CURRENT competitive ${GAME_FULL_NAME[game]} metagame:`,
    'recent tournament results, tier lists, and what is actually winning.',
    'Reply with ONLY 3-5 markdown bullets, each naming a deck or strategy and citing a date or source.',
    'No preamble, no headings, no closing remarks.',
  ].join(' ')
}

function buildPrompt(body: Record<string, unknown>, meta: string): string | null {
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
    `You are an expert ${GAME_FULL_NAME[game]} deck builder.`,
    // The meta arrives as text rather than being looked up again. See the cache
    // note in Deno.serve below for why that is the whole cost model.
    meta
      ? `Here is the current metagame, already researched. Treat it as fact and do NOT search:\n${meta}`
      : 'Use Google Search to check the CURRENT competitive metagame (tier lists, recent tournament results) before answering.',
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
    meta
      ? '1. `## Meta snapshot` — reproduce the bullets you were given above, unchanged.'
      : '1. `## Meta snapshot` — 3-5 bullets on the current meta with dates/sources.',
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

/** One Gemini call. `grounded` is the expensive switch — see the cache note below. */
async function askGemini(key: string, prompt: string, grounded: boolean, maxTokens: number): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      ...(grounded ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: { temperature: 0.6, maxOutputTokens: maxTokens },
    }),
  }).catch(() => null)
  if (!res?.ok) return ''
  const payload = await res.json().catch(() => null)
  return ((payload?.candidates?.[0]?.content?.parts ?? []) as { text?: string }[])
    .map((p) => p?.text ?? '')
    .join('')
    .trim()
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
    body: JSON.stringify({ p_user: user.id, p_limit: MONTHLY_LIMIT, p_free_limit: FREE_MONTHLY_LIMIT }),
  }).catch(() => null)
  if (!credit?.ok) return json({ error: 'entitlement check failed' }, 503)
  const remaining = Number(await credit.json())
  if (!Number.isFinite(remaining)) return json({ error: 'entitlement check failed' }, 503)
  // -1 = not entitled; -2 = over the cap (0023). Zero is a VALID answer: the
  // month's last credit, consumed and spendable -- refusing it ate a call the
  // allowance had already paid for.
  if (remaining === -1) return json({ error: 'not subscribed' }, 403)
  if (remaining < 0) return json({ error: 'monthly allowance used' }, 429)

  // --- build ---------------------------------------------------------------
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'bad request' }, 400)
  }
  const game = typeof body.game === 'string' ? body.game : ''
  if (!GAME_FULL_NAME[game]) return json({ error: 'bad request' }, 400)

  // THE CACHE, AND WHY IT IS THE WHOLE COST MODEL. Grounding a build with
  // Google Search costs roughly ten times the tokens do — and the question it
  // answers ("what is winning in Modern right now") has the SAME answer for
  // every user on a given day. So it is asked once per game per day and the
  // text is handed to every build after. First build of the day for a game
  // pays for the lookup; the rest are a fraction of a cent.
  //
  // A miss is never fatal: if grounding fails we build ungrounded rather than
  // refusing, because a deck built without today's tier list is still a deck,
  // and a user who paid should not be told "no" because a search timed out.
  let meta = ''
  const cached = await fetch(`${SUPABASE_URL}/rest/v1/rpc/read_meta_snapshot`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_game: game }),
  }).catch(() => null)
  if (cached?.ok) meta = (await cached.json().catch(() => '')) || ''

  if (!meta) {
    meta = await askGemini(GEMINI_KEY, metaPrompt(game), true, 600)
    if (meta) {
      // Two builds can miss at once and both ground; the insert does nothing on
      // conflict. One wasted lookup beats serialising every build behind a writer.
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/take_meta_snapshot`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_game: game, p_markdown: meta }),
      }).catch(() => null)
    }
  }

  const prompt = buildPrompt(body, meta)
  if (!prompt) return json({ error: 'bad request' }, 400)

  // Ungrounded: the meta is already in the prompt, and searching again would
  // pay twice for one answer.
  const markdown = await askGemini(GEMINI_KEY, prompt, !meta, 4096)
  if (!markdown) return json({ error: 'upstream failed' }, 502)

  // Parsing into decklists stays on the client: it is presentation logic, it is
  // already unit-tested there, and an older bundle must keep working against
  // this function without a redeploy.
  // NOT `remaining - 1`. `consume_build_credit` increments the counter and then
  // returns `p_limit - v_calls`, so its answer ALREADY excludes this call —
  // subtracting again under-reported by one and would have told someone they
  // had none left while they still had one. Caught by a real build reporting
  // 4998 against a limit of 5000.
  return json({ markdown, remaining })
})
