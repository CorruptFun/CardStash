import { useMemo, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './basics'
import { binderCode, binderUrl } from '../lib/binders'
import { downloadFile } from '../lib/csv'
import { encodeQr, qrPath } from '../lib/qr'
import type { Binder } from '../lib/types'

/**
 * The sticker that goes on the physical binder.
 *
 * The whole point is that the paper and the app stay attached to each other:
 * scan the label with any phone camera — no app installed, no account, no
 * network — and land on that binder's contents in Cardstock. So the QR carries
 * a plain URL to this deployment (`lib/binders.ts`), the code is printed
 * underneath in case the sticker gets scuffed past reading, and the whole
 * thing is drawn as an SVG so it prints at the printer's resolution rather
 * than a screenshot's.
 *
 * Printing is `window.print()` against a print stylesheet that hides the app
 * and leaves this sheet — no popup, because a popup is what mobile browsers
 * block. The PNG is for the case print has nowhere to go: a phone with no
 * printer, where the label gets sent to whoever does have one.
 */

/**
 * PNG fallback geometry. 12px per module puts a version-3 symbol at ~460px
 * square — big enough to print at a comfortable size without resampling, small
 * enough to message to whoever owns the printer. `PNG_QUIET` is the quiet zone
 * every decoder needs around a symbol; 4 modules is the spec's minimum and the
 * difference between a label that scans and one that does not.
 */
const PNG_MODULE_PX = 12
const PNG_QUIET = 4

export function BinderLabel({ binder, count, onClose }: { binder: Binder; count: number; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const url = useMemo(() => binderUrl(binder.id), [binder.id])
  const qr = useMemo(() => {
    try {
      return encodeQr(url)
    } catch {
      return null
    }
  }, [url])
  const path = useMemo(() => (qr ? qrPath(qr) : ''), [qr])
  /** Module span including the quiet zone every decoder needs around a symbol. */
  const span = qr ? qr.size + PNG_QUIET * 2 : 0
  const code = binderCode(binder.id)

  /**
   * A PNG of the same symbol, drawn from the matrix rather than rasterized
   * from the SVG — an `<img>` of an SVG taints nothing here, but Safari has
   * historically refused to draw one to a canvas at all, and a Save button
   * that works everywhere except the platform most of these users are on is
   * not a Save button.
   */
  const savePng = () => {
    if (!qr) return
    const span = (qr.size + PNG_QUIET * 2) * PNG_MODULE_PX
    const canvas = document.createElement('canvas')
    canvas.width = span
    canvas.height = span + 84
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#000000'
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (!qr.modules[y * qr.size + x]) continue
        ctx.fillRect((x + PNG_QUIET) * PNG_MODULE_PX, (y + PNG_QUIET) * PNG_MODULE_PX, PNG_MODULE_PX, PNG_MODULE_PX)
      }
    }
    ctx.textAlign = 'center'
    ctx.font = '600 30px system-ui, sans-serif'
    ctx.fillText(binder.name.slice(0, 28), span / 2, span + 24)
    ctx.font = '400 20px ui-monospace, monospace'
    ctx.fillStyle = '#555555'
    ctx.fillText(binderCode(binder.id), span / 2, span + 56)
    canvas.toBlob((blob) => {
      if (!blob) return
      const link = document.createElement('a')
      const href = URL.createObjectURL(blob)
      link.href = href
      link.download = `${binder.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'binder'}-label.png`
      link.click()
      setTimeout(() => URL.revokeObjectURL(href), 5000)
    }, 'image/png')
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard is permission-gated and simply absent in some contexts; the
      // URL is printed on the sheet either way, so this is never the only door.
      downloadFile(`${binder.id}-link.txt`, url)
    }
  }

  return (
    <Modal open onClose={onClose} title="Binder label">
      {qr ? (
        <div className="labelbox">
          {/* The printed artefact. Everything else on screen is hidden by the
            * print stylesheet; this element IS the page. */}
          <div className="labelsheet">
            <svg
              className="labelsheet__qr"
              viewBox={`0 0 ${span} ${span}`}
              role="img"
              aria-label={`QR code linking to ${binder.name}`}
            >
              <rect width={span} height={span} fill="#fff" />
              <g transform={`translate(${PNG_QUIET} ${PNG_QUIET})`}>
                <path d={path} fill="#000" shapeRendering="crispEdges" />
              </g>
            </svg>
            <strong className="labelsheet__name">{binder.name}</strong>
            {binder.note && <span className="labelsheet__note">{binder.note}</span>}
            <span className="labelsheet__code">{code}</span>
            <span className="labelsheet__meta">
              {count} {count === 1 ? 'card' : 'cards'} · Cardstock
            </span>
          </div>
          <p className="labelbox__hint">
            Print it, cut it out and stick it on the binder. Any phone camera opens it — scanning the label brings up
            these cards in the app.
          </p>
          <div className="labelbox__btns">
            <button className="btn btn--primary" onClick={() => window.print()}>
              <Icon name="printer" size={16} /> Print
            </button>
            <button className="btn btn--ghost" onClick={savePng}>
              <Icon name="download" size={16} /> Save PNG
            </button>
            <button className="btn btn--ghost" onClick={() => void copyLink()}>
              <Icon name={copied ? 'check' : 'link'} size={16} /> {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      ) : (
        <p className="labelbox__hint">This binder’s link is too long to put in a QR code.</p>
      )}
    </Modal>
  )
}
