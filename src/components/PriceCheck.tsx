import { useState } from 'react'
import { COMPS_AVAILABLE, compsQuery, fetchComps, type CompSummary } from '../lib/ebaycomps'
import { track } from '../lib/analytics'
import type { Card, GradeInfo } from '../lib/types'
import { Icon } from './Icon'

/**
 * "What is eBay asking for this?" — the sports card's price button.
 *
 * The one screen rule that matters here is that **this never runs on its
 * own.** It renders a button; nothing leaves the device until the button is
 * pressed. That is what makes a price check consent rather than telemetry,
 * and it is why there is no settings switch for it (compare `cardSourceLookup`,
 * which needed one precisely because it fires automatically).
 *
 * ## Why the copy is shaped like this
 *
 * The numbers are ASKING prices — eBay's sold-comp API is a limited release we
 * do not have (see `lib/ebaycomps.ts`). So the label says "asking", the sample
 * size is on screen next to the spread, and the sold-comps link sits under it
 * so the collector can check the real thing in one tap. A single confident
 * figure would be the easiest possible UI and the one thing decision 17
 * exists to prevent: the app asserting a value for someone's card that no sale
 * supports.
 *
 * `onUse` is optional and is what turns a reading into the collector's own
 * `marketValue`. It hands over the MEDIAN, never the high — the number that
 * flatters a collection is not the number to make one tap away.
 */
export function PriceCheck({ card, grade, onUse }: { card: Card; grade?: GradeInfo; onUse?: (value: number) => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [summary, setSummary] = useState<CompSummary | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // Not enough printed facts to search with, or a build with no project: the
  // control does not render at all rather than offering a button that fails.
  if (!COMPS_AVAILABLE || !compsQuery(card, grade)) return null

  const check = async () => {
    setState('loading')
    const startedAt = performance.now()
    const result = await fetchComps(card, grade)
    // Content-free, as every event here must be: how many listings and how
    // long, never which card was priced (`analytics.ts`).
    track('comps_check', {
      ok: result.ok,
      ms: Math.round(performance.now() - startedAt),
      count: result.ok ? result.summary.count : 0,
      cached: result.ok ? result.cached : false,
      ...(result.ok ? {} : { reason: result.reason }),
    })
    setSummary(result.ok ? result.summary : null)
    setMessage(result.ok ? null : result.message)
    setState('done')
  }

  return (
    <div className="pricecheck">
      <button className="btn btn--ghost btn--sm" onClick={check} disabled={state === 'loading'}>
        <Icon name="tag" size={15} /> {state === 'loading' ? 'Checking eBay…' : 'Check eBay prices'}
      </button>
      {state === 'done' && summary && (
        <div className="pricecheck__out">
          <span className="pricecheck__spread">
            <strong>${summary.median.toFixed(2)}</strong> median
            <span className="pricecheck__range">
              ${summary.low.toFixed(2)} – ${summary.high.toFixed(2)}
            </span>
          </span>
          <em className="pricecheck__note">
            {summary.count} active listing{summary.count === 1 ? '' : 's'} — asking prices, not sales
          </em>
          {onUse && (
            <button className="btn btn--ghost btn--sm" onClick={() => onUse(summary.median)}>
              Use ${summary.median.toFixed(2)}
            </button>
          )}
        </div>
      )}
      {state === 'done' && !summary && <em className="pricecheck__note">{message}</em>}
    </div>
  )
}
