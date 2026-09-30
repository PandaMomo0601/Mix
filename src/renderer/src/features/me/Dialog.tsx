import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from '../auth/Controls'

export function Dialog({
  title,
  onClose,
  busy = false,
  height = 400,
  variant = 'classic',
  className = '',
  children,
  footer
}: {
  title: string
  onClose: () => void
  busy?: boolean
  height?: number
  variant?: 'classic' | 'profile'
  className?: string
  children: ReactNode
  footer: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`me-dialog me-dialog-${variant} ${className}`}
      style={{ height }}
      aria-labelledby={titleId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header className="me-dialog-header">
        <h2 id={titleId}>{title}</h2>
        <Button variant="text" onClick={onClose} disabled={busy}>
          关闭
        </Button>
      </header>
      <div className="me-dialog-body">
        <div className="me-dialog-content">{children}</div>
      </div>
      <footer className="me-dialog-footer">{footer}</footer>
    </dialog>
  )
}
