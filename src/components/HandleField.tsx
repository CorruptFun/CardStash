import { useEffect, useRef, useState } from 'react'
import { checkHandle, normalizeHandle, type HandleStatus } from '../lib/socialcloud'

/**
 * The one handle picker, shared by first run and the Friends screen.
 *
 * It exists as a component because a handle is **permanent** (migration 0010):
 * once claimed it can never be changed, and it can never be reused by anyone
 * else. Two copies of that promise would eventually make it in two different
 * ways, and the version that drifts is the one someone lives with forever.
 *
 * ## Why availability is checked while typing
 *
 * The old flow found out the name was taken *after* the tap, by way of a red
 * toast — acceptable when a handle is a mutable label, unacceptable when it is
 * the one irreversible decision in onboarding. Asking the server as they type
 * turns "your choice was rejected" into "that one's gone, pick another", which
 * is the same information delivered before it costs anything.
 *
 * `checkHandle` consults the claim ledger, not the directory, so a handle that
 * was claimed and later erased reads as taken here — exactly as it will when
 * the claim is attempted.
 */

const DEBOUNCE_MS = 350

/** What the user is told, per answer. `null` is "nothing to say yet". */
const SAYS: Record<HandleStatus, { tone: 'ok' | 'no'; text: string } | null> = {
  ok: { tone: 'ok', text: 'is available' },
  mine: { tone: 'ok', text: 'is already yours' },
  taken: { tone: 'no', text: 'is taken — try another' },
  reserved: { tone: 'no', text: 'is reserved' },
  bad: null,
}

export function HandleField({
  value,
  onChange,
  onSubmit,
  onBlockedChange,
  disabled,
  autoFocus,
}: {
  value: string
  onChange: (handle: string) => void
  onSubmit: () => void
  /**
   * Told whenever the server's verdict makes this handle unclaimable, so the
   * parent's Claim button can go dead without a second copy of the rule.
   */
  onBlockedChange?: (blocked: boolean) => void
  disabled?: boolean
  autoFocus?: boolean
}) {
  const [status, setStatus] = useState<HandleStatus | null>(null)
  const [checking, setChecking] = useState(false)
  // Only the newest answer may paint: a slow reply for "ra" must never
  // overwrite the verdict on "rae".
  const asked = useRef(0)

  useEffect(() => {
    const clean = normalizeHandle(value)
    setStatus(null)
    if (clean.length < 3) {
      setChecking(false)
      return
    }
    const mine = ++asked.current
    setChecking(true)
    const timer = setTimeout(() => {
      checkHandle(clean)
        .then((next) => {
          if (asked.current !== mine) return
          setStatus(next)
          setChecking(false)
        })
        .catch(() => {
          // Offline: say nothing rather than guess. The claim itself is still
          // the authority, and it will fail honestly if the name is gone.
          if (asked.current !== mine) return
          setStatus(null)
          setChecking(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value])

  const clean = normalizeHandle(value)
  const says = status ? SAYS[status] : null
  const blocked = status === 'taken' || status === 'reserved'
  const canSubmit = !disabled && !blocked && clean.length >= 3

  useEffect(() => {
    onBlockedChange?.(blocked)
  }, [blocked, onBlockedChange])

  return (
    <>
      <div className="setrow cloudrow">
        <span className="handleat">@</span>
        <input
          className="input"
          value={value}
          onChange={(e) => onChange(normalizeHandle(e.target.value))}
          placeholder="yourhandle"
          maxLength={24}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-label="Your handle"
          aria-describedby="handle-status"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSubmit) onSubmit()
          }}
        />
      </div>
      {/* Always mounted and always live, so a verdict arriving after the user
          has stopped looking at the field is still announced. */}
      <p className="handlestatus" id="handle-status" role="status">
        {clean.length < 3 ? (
          <span className="handlestatus__hint">Letters, numbers and underscores. 3–24 characters.</span>
        ) : checking ? (
          <span className="handlestatus__hint">Checking @{clean}…</span>
        ) : says ? (
          <span className={`handlestatus__${says.tone}`}>
            @{clean} {says.text}
          </span>
        ) : (
          <span className="handlestatus__hint">@{clean}</span>
        )}
      </p>
    </>
  )
}
