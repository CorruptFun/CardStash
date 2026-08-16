import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useUi, type Toast } from '../store/ui'
import { Icon } from './Icon'

/**
 * How far a toast has to travel before letting go dismisses it, and how far a
 * finger has to move before the gesture counts as a swipe at all.
 *
 * The second number is the load-bearing one: the pointer is only captured
 * after it, so a tap that lands on Undo still reaches the button. Capturing on
 * pointerdown would eat every Undo on a touchscreen, where a "tap" always
 * carries a pixel or two of drift.
 */
const SWIPE_OUT_PX = 56
const SWIPE_START_PX = 8

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const startRef = useRef<{ id: number; x: number } | null>(null)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    startRef.current = { id: event.pointerId, x: event.clientX }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current
    if (!start || start.id !== event.pointerId) return
    const moved = event.clientX - start.x
    if (!dragging) {
      if (Math.abs(moved) < SWIPE_START_PX) return
      setDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    setDx(moved)
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current
    if (!start || start.id !== event.pointerId) return
    startRef.current = null
    setDragging(false)
    if (Math.abs(dx) >= SWIPE_OUT_PX) {
      onDismiss()
      return
    }
    setDx(0)
  }

  const shifted = dx !== 0
  return (
    <div
      className={`toast toast--${toast.kind}`}
      style={
        shifted
          ? {
              transform: `translateX(${Math.round(dx)}px)`,
              opacity: Math.max(0.25, 1 - Math.abs(dx) / (SWIPE_OUT_PX * 2)),
              transition: dragging ? 'none' : undefined,
            }
          : undefined
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {toast.kind === 'success' && <Icon name="check" size={16} />}
      {toast.kind === 'error' && <Icon name="alert" size={16} />}
      <span className="toast__text">{toast.text}</span>
      {toast.action && (
        <button
          className="toast__action"
          onClick={() => {
            toast.action!.fn()
            onDismiss()
          }}
        >
          {toast.action.label}
        </button>
      )}
      {/* The swipe is invisible and unreachable by keyboard or switch control,
        * so the same escape has to exist as a real control. */}
      <button className="toast__close" onClick={onDismiss} aria-label="Dismiss">
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismissToast)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  )
}
