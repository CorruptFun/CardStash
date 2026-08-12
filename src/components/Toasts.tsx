import { useUi } from '../store/ui'
import { Icon } from './Icon'

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismissToast)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          {toast.kind === 'success' && <Icon name="check" size={16} />}
          {toast.kind === 'error' && <Icon name="alert" size={16} />}
          <span className="toast__text">{toast.text}</span>
          {toast.action && (
            <button
              className="toast__action"
              onClick={() => {
                toast.action!.fn()
                dismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
