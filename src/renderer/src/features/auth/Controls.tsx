import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode
} from 'react'

export function AuthFrame({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <main className="auth-viewport flex min-h-dvh flex-col p-6" data-theme="light">
      <section
        className="auth-column my-auto flex w-full shrink-0 flex-col gap-4"
        aria-labelledby="auth-title"
      >
        <p className="mix-wordmark">Mix</p>
        <header className="flex flex-col gap-2">
          <h1 id="auth-title" tabIndex={-1}>
            {title}
          </h1>
          {description && <p className="secondary">{description}</p>}
        </header>
        {children}
      </section>
    </main>
  )
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'text'
}): React.JSX.Element {
  return <button type="button" {...props} className={`mix-button ${variant} ${className}`} />
}

export function Feedback({
  message,
  title = '提示',
  error = false
}: {
  message: string
  title?: string
  error?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error) ref.current?.focus()
  }, [error, message])
  return (
    <div ref={ref} className="mix-feedback" role={error ? 'alert' : 'status'} tabIndex={-1}>
      <p className="font-medium">{title}</p>
      <p className="secondary">{message}</p>
    </div>
  )
}

export function Field({
  label,
  error,
  hint,
  type,
  name,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string
  name: string
  error?: string
  hint?: string
}): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const password = type === 'password'
  return (
    <div className="mix-field flex flex-col gap-2">
      <label htmlFor={name}>{label}</label>
      <div className={`mix-input ${error ? 'invalid' : ''}`}>
        <input
          {...props}
          id={name}
          name={name}
          type={password && visible ? 'text' : type}
          aria-invalid={Boolean(error)}
          aria-describedby={error || hint ? `${name}-hint` : undefined}
        />
        {password && (
          <button
            className="password-toggle"
            type="button"
            aria-label={`${visible ? '隐藏' : '显示'}${label}`}
            aria-pressed={visible}
            disabled={props.disabled}
            onClick={() => setVisible(!visible)}
          >
            {visible ? '隐藏' : '显示'}
          </button>
        )}
      </div>
      {(error || hint) && (
        <p className="field-hint" id={`${name}-hint`}>
          {error || hint}
        </p>
      )}
    </div>
  )
}
