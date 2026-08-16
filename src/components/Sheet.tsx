import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react'

/**
 * Bottom sheet with swipe-to-dismiss and a history entry so the hardware
 * back button closes the sheet instead of leaving the app.
 */

let sheetSeq = 0

function shouldPopHistory(state: unknown, id: number, poppedAlready: boolean): boolean {
  if (poppedAlready) return false
  return (state as { cardstockSheet?: number } | null)?.cardstockSheet === id
}

export function Sheet({
  open,
  onClose,
  children,
  tall = false,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  tall?: boolean
}) {
  const [dragY, setDragY] = useState(0)
  const [closing, setClosing] = useState(false)
  const touchRef = useRef<{ y: number; scrollTop: number; dragging: boolean } | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => {
    setClosing(true)
    setTimeout(() => {
      setClosing(false)
      setDragY(0)
      onClose()
    }, 190)
  }, [onClose])

  /**
   * The close callback, reached through a ref so the effects below can depend
   * on `open` ALONE.
   *
   * This is not a tidiness point, it is the whole correctness of the history
   * entry. Callers pass `onClose={() => setThing(false)}` — a new function
   * every render — so an effect depending on `close` tore down and re-ran
   * whenever the parent re-rendered for any reason. Its cleanup calls
   * `history.back()`, and the listener the re-run had just registered saw that
   * as a back-button press and closed the sheet. Any sheet over a live query
   * therefore shut itself the moment the data under it changed: adding a card
   * to a binder closed the picker after exactly one card.
   */
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!open) return
    const id = ++sheetSeq
    history.pushState({ cardstockSheet: id }, '')
    let popped = false
    const onPop = () => {
      popped = true
      closeRef.current()
    }
    const onHash = () => closeRef.current()
    window.addEventListener('popstate', onPop)
    window.addEventListener('hashchange', onHash)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('hashchange', onHash)
      if (shouldPopHistory(history.state, id, popped)) history.back()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const onTouchStart = (event: TouchEvent) => {
    touchRef.current = {
      y: event.touches[0].clientY,
      scrollTop: bodyRef.current?.scrollTop ?? 0,
      dragging: false,
    }
  }
  const onTouchMove = (event: TouchEvent) => {
    const touch = touchRef.current
    if (!touch) return
    const delta = event.touches[0].clientY - touch.y
    const atTop = (bodyRef.current?.scrollTop ?? 0) <= 0
    if (!touch.dragging && delta > 8 && (atTop || touch.scrollTop <= 0)) touch.dragging = true
    if (touch.dragging && delta > 0) setDragY(delta)
  }
  const onTouchEnd = () => {
    const touch = touchRef.current
    touchRef.current = null
    if (touch?.dragging) {
      if (dragY > 110) close()
      else setDragY(0)
    }
  }

  return (
    <div className={`sheet-root ${closing ? 'sheet-root--closing' : ''}`} role="dialog" aria-modal="true">
      <div className="sheet-backdrop" onClick={close} />
      <div
        className={`sheet ${tall ? 'sheet--tall' : ''}`}
        style={dragY ? { transform: `translateY(${dragY}px)`, transition: 'none' } : undefined}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <button className="sheet__grab" onClick={close} aria-label="Close">
          <span />
        </button>
        <div className="sheet__body" ref={bodyRef}>
          {children}
        </div>
      </div>
    </div>
  )
}
