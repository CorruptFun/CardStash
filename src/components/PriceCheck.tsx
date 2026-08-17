import { useEffect, useState } from 'react'
import { COMPS_AVAILABLE, compsQuery, fetchComps, type CompSummary } from '../lib/ebaycomps'
import { estimateFor, formatEstimate, type Estimate } from '../lib/estimate'
import { track } from '../lib/analytics'
import type { Card, GradeInfo } from '../lib/types'
import { Icon } from './Icon'

/**
 * What a sports card is worth, in the two forms the app can honestly offer.
 *
 * **The estimate** is local and free, so it renders on its own: a range worked
 * out from cards the collector has already priced, with the comparables named
 * underneath it (`lib/estimate.ts`). It is labelled an estimate everywhere it
 * appears — the word, the range instead of a figure, and the basis line are
 * three separate ways of saying the same thing, which is deliberate. A number
 * this soft is read by whichever cue the user notices first.
 *
 * **The eBay check** is the harder evidence, and it costs a request, so it
 * stays behind a button. Nothing leaves the device until that button is
 * pressed — which is what makes it consent rather than telemetry, and why it
 * needs no settings switch (compare `cardSourceLookup`, which fires on its own
 * and therefore does). Those numbers are ASKING prices; eBay's sold-comp API
 * is a limited release we do not have, so the label says "asking", the sample
 * size is beside the spread, and the sold-comps link sits under it.
 *
 * The ordering is the point: a comp, when there is one, is better evidence
 * than an estimate, so it is shown below and reads as the firmer answer.
 *
 * `onUse` turns either reading into the collector's own `marketValue`. It
 * hands over the MIDDLE of the range, never the top — the number that flatters
 * a collection is not the number to make one tap away.
 */
export function PriceCheck({ card, grade, onUse }: { card: Card; grade?: GradeInfo; onUse?: (value: number) => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [summary, setSummary] = useState<CompSummary | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<Estimate | null>(null)

  const gradeKey = grade ? `${grade.company}:${grade.grade}` : ''
  useEffect(() => {
    let live = true
    estimateFor(card, grade)
      .then((next) => live && setEstimate(next))
      .catch(() => {})
    return () => {
      live = false
    }
    // The card and whether it is slabbed are the whole input; `grade` itself is
    // a fresh object on every render, so the key stands in for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, gradeKey])

  const canCheck = COMPS_AVAILABLE && Boolean(compsQuery(card, grade))
  // Nothing to say about this card at all: no comparables owned and not enough
  // printed facts to search on. Render nothing rather than an empty affordance.
  if (!canCheck && !estimate) return null

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
      {estimate && (
        <div className="pricecheck__out pricecheck__out--estimate">
          <span className="pricecheck__spread">
            <span className="pricecheck__tag">Estimate</span>
            <strong>
              {estimate.low === estimate.high
                ? `~${formatEstimate(estimate.low)}`
                : `${formatEstimate(estimate.low)} – ${formatEstimate(estimate.high)}`}
            </strong>
          </span>
          {/* The basis is not a footnote — it is what makes the number
              arguable instead of authoritative. It never gets dropped for
              space; the range goes first if something has to give. */}
          <em className="pricecheck__note">Rough guess from {estimate.from} — not a market price</em>
          {onUse && (
            <button className="btn btn--ghost btn--sm" onClick={() => onUse(estimate.mid)}>
              Use {formatEstimate(estimate.mid)}
            </button>
          )}
        </div>
      )}
      {canCheck && (
        <button className="btn btn--ghost btn--sm" onClick={check} disabled={state === 'loading'}>
          <Icon name="tag" size={15} />{' '}
          {state === 'loading' ? 'Checking eBay…' : estimate ? 'Check eBay for a real figure' : 'Check eBay prices'}
        </button>
      )}
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
