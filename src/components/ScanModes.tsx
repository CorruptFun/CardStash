import { useState } from 'react'
import { Modal, Toggle } from './basics'
import { Icon, type IconName } from './Icon'

/**
 * The scan screen's mode switches, behind one button.
 *
 * They used to be three pills — Packs, Page, Collect — sitting across the top
 * of the viewfinder next to the game picker, the upload button and the torch.
 * Six controls over the camera picture is a toolbar, and the thing underneath
 * it is the actual product. One button opens the rest.
 *
 * ## Why the button still says what is on
 *
 * Hiding a mode is fine; hiding that a mode is *active* is not. **Collect mode
 * files every confident scan straight into the collection with no
 * confirmation** — someone who forgets it is on discovers it as a pile of
 * cards they did not mean to add. So the button carries a count badge and an
 * on state, and the label names the active mode when there is exactly one.
 *
 * The label is capped at one name on purpose: this control sits over a live
 * camera, and a button that changes width as state changes makes the whole
 * viewfinder feel unstable.
 */

export interface ScanModeToggle {
  key: string
  icon: IconName
  label: string
  description: string
  on: boolean
  onChange: (on: boolean) => void
}

export function ScanModes({ modes }: { modes: ScanModeToggle[] }) {
  const [open, setOpen] = useState(false)
  const active = modes.filter((mode) => mode.on)
  const label = active.length === 1 ? active[0].label : 'Modes'

  return (
    <>
      <button
        className={`collectpill ${active.length ? 'collectpill--on' : ''}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={
          active.length ? `Scan modes — ${active.map((mode) => mode.label).join(', ')} on` : 'Scan modes'
        }
      >
        <Icon name={active.length === 1 ? active[0].icon : 'sort'} size={14} />
        <span className="collectpill__label">{label}</span>
        {active.length > 1 && <span className="collectpill__count">{active.length}</span>}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Scan modes" variant="glass">
        <div className="modelist">
          {modes.map((mode) => (
            <div key={mode.key} className="moderow">
              <span className={`moderow__icon ${mode.on ? 'moderow__icon--on' : ''}`} aria-hidden="true">
                <Icon name={mode.icon} size={17} />
              </span>
              <span className="moderow__text">
                <span className="moderow__label">{mode.label}</span>
                <em>{mode.description}</em>
              </span>
              <Toggle on={mode.on} onChange={mode.onChange} label={mode.label} />
            </div>
          ))}
        </div>
      </Modal>
    </>
  )
}
