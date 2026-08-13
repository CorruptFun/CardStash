import { useSyncExternalStore } from 'react'
import { clearScanTraces, onScanTraces, scanTraces, type ScanTrace, type TraceEvent } from '../lib/scandebug'
import { useUi } from '../store/ui'
import { Icon } from './Icon'

/**
 * "What did the scanner see?" — the per-attempt stage trace, on screen.
 * Strictly local: the trace holds card text and OCR reads, so it renders
 * here and leaves the device only if the user taps Copy. Never analytics.
 */

const pct = (v: number) => `${Math.round(v * 100)}%`

function eventLine(event: TraceEvent): string {
  const { stage } = event
  if (stage === 'ocr-band') {
    const c = (event.candidates as string[]) ?? []
    return `read ${pct(event.y as number)}–${pct((event.y as number) + (event.h as number))}: ${
      c.length ? c.map((x) => `“${x}”`).join(' · ') : '(no legible text)'
    }`
  }
  if (stage === 'ocr-anywhere') {
    const c = (event.candidates as string[]) ?? []
    return `full-card sweep: ${c.length ? c.map((x) => `“${x}”`).join(' · ') : '(no legible text)'}`
  }
  if (stage === 'ocr-region')
    return `collector line: ${String(event.raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) || '(blank)'}`
  if (stage === 'lookup')
    return event.matched
      ? `“${event.read}” → ${event.game}: ${event.matched} (score ${event.score})`
      : `“${event.read}” → no match`
  if (stage === 'refine')
    return event.number || event.setCode
      ? `edition read: ${[event.setCode, event.number].filter(Boolean).join(' ')}${event.total ? `/${event.total}` : ''}${event.foil ? ' · foil sheen' : ''}`
      : `edition: collector line not legible${event.foil ? ' · foil sheen' : ''}`
  if (stage === 'crop') return `card region: ${event.applied ? `tightened to ${pct(event.w as number)}×${pct(event.h as number)}` : 'kept full frame'}`
  if (stage === 'cache') return event.hit ? `cache: same frame → ${event.card}` : 'cache: same frame as a recent miss'
  return stage
}

function TraceBlock({ trace }: { trace: ScanTrace }) {
  const outcome = trace.outcome
  return (
    <div className="scandebug__trace">
      <div className="scandebug__head">
        <span className={`scandebug__badge ${outcome?.ok ? 'scandebug__badge--ok' : ''}`}>
          {outcome?.ok ? outcome.name : (outcome?.reason ?? 'in flight')}
        </span>
        <span className="scandebug__meta">
          {trace.hint ?? 'auto'} · {outcome ? `${outcome.ms}ms` : '…'}
        </span>
      </div>
      {!outcome?.ok && outcome?.message ? <p className="scandebug__msg">{outcome.message}</p> : null}
      <ol className="scandebug__events">
        {trace.events.map((event, at) => (
          <li key={at}>
            <em>+{event.t}ms</em> {eventLine(event)}
          </li>
        ))}
        {!trace.events.length && <li>(no stages recorded)</li>}
      </ol>
    </div>
  )
}

export function ScanDebugPanel({ onClose }: { onClose: () => void }) {
  const toast = useUi((s) => s.toast)
  const traces = useSyncExternalStore(onScanTraces, scanTraces, scanTraces)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(traces.slice(0, 8), null, 1))
      toast('Scan details copied', 'success')
    } catch {
      toast('Copy failed — clipboard unavailable', 'error')
    }
  }
  return (
    <div className="scandebug" role="dialog" aria-label="Scan diagnostics">
      <div className="scandebug__bar">
        <strong>What the scanner saw</strong>
        <span className="scandebug__actions">
          <button className="iconbtn" onClick={copy} aria-label="Copy scan details">
            <Icon name="copy" size={16} />
          </button>
          <button
            className="iconbtn"
            onClick={() => {
              clearScanTraces()
            }}
            aria-label="Clear scan details"
          >
            <Icon name="trash" size={16} />
          </button>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={17} />
          </button>
        </span>
      </div>
      <p className="scandebug__note">Last {Math.min(traces.length, 8)} attempts, newest first. Stays on this device.</p>
      <div className="scandebug__list">
        {traces.slice(0, 8).map((trace) => (
          <TraceBlock key={trace.seq} trace={trace} />
        ))}
        {!traces.length && <p className="scandebug__msg">No attempts yet — point the camera at a card first.</p>}
      </div>
    </div>
  )
}
