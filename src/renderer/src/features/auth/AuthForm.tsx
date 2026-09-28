import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AuthResult, AuthSnapshot } from '../../../../shared/auth'
import { normalizeEmail } from '../../../../shared/validation'
import { AuthFrame, Button, Feedback, Field } from './Controls'

type Mode = 'login' | 'register' | 'forgot' | 'confirm' | 'recovery-sent'
const headings = {
  login: ['欢迎回来', '使用 Mix 账号登录，继续你的工作。'],
  register: ['创建账号', '注册后，通过邮件确认你的邮箱。'],
  forgot: ['找回密码', '输入注册邮箱，我们会发送密码重置指引。'],
  confirm: ['检查你的邮箱', '请通过邮件完成邮箱确认，再回来登录。'],
  'recovery-sent': ['检查你的邮箱', '在浏览器完成密码重设后，回到 Mix 登录。']
} satisfies Record<Mode, string[]>

export function AuthForm({ snapshot }: { snapshot: AuthSnapshot }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(snapshot.message)
  const [isError, setIsError] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const alive = useRef(true)
  const composing = useRef(false)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    const input = formRef.current?.querySelector('input')
    if (input) input.focus()
    else document.getElementById('auth-title')?.focus()
  }, [mode])

  function changeMode(next: Mode): void {
    setMode(next)
    setMessage(null)
    setErrors({})
    setIsError(false)
  }

  async function perform(task: () => Promise<AuthResult>, after?: Mode): Promise<void> {
    if (busy) return
    setBusy(true)
    setMessage(null)
    setIsError(false)
    try {
      const result = await task()
      if (!alive.current) return
      if (!result.ok) {
        setIsError(true)
        setMessage(result.error.message)
        if (result.error.code === 'email-unconfirmed') setMode('confirm')
      } else if (result.outcome === 'check-email') {
        if (after) setMode(after)
        setMessage(result.message ?? null)
      }
    } catch {
      if (alive.current) {
        setIsError(true)
        setMessage('暂时无法完成，请稍后重试。')
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (busy || composing.current) return
    const form = event.currentTarget
    const data = new FormData(form)
    const normalized = normalizeEmail(email)
    const password = String(data.get('password') ?? '')
    const nextErrors: Record<string, string> = {}
    if (!normalized) nextErrors.email = email.trim() ? '请输入有效的邮箱地址。' : '请输入邮箱地址。'
    if (mode !== 'forgot' && !password) nextErrors.password = '请输入密码。'
    if (mode === 'register' && password !== data.get('confirm'))
      nextErrors.confirm = '两次输入的密码不一致。'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      const first = form.elements.namedItem(Object.keys(nextErrors)[0]) as HTMLElement | null
      first?.focus()
      return
    }
    setEmail(normalized!)
    if (mode === 'forgot') {
      void perform(() => window.mix.auth.requestPasswordReset(normalized!), 'recovery-sent')
      return
    }
    const credentials = { email: normalized!, password }
    // Clear password fields before waiting on IPC; no credentials in Zustand or browser storage.
    form.reset()
    if (mode === 'register') void perform(() => window.mix.auth.signUp(credentials), 'confirm')
    else void perform(() => window.mix.auth.signIn(credentials))
  }

  const [title, description] = headings[mode]
  return (
    <AuthFrame title={title} description={description}>
      {message && (
        <Feedback title={isError ? '未能完成' : '提示'} message={message} error={isError} />
      )}
      {mode === 'confirm' ? (
        <>
          <p className="secondary break-all">{email}</p>
          <Feedback
            title="确认后回来登录"
            message="打开邮件中的链接，完成邮箱确认。未收到时也请检查垃圾邮件。"
          />
          <div className="auth-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void perform(() => window.mix.auth.resendConfirmation(email))}
            >
              {busy ? '请求中…' : '重新发送确认邮件'}
            </Button>
            <Button disabled={busy} onClick={() => changeMode('login')}>
              我已确认，去登录
            </Button>
            <Button variant="text" disabled={busy} onClick={() => changeMode('register')}>
              换个邮箱注册
            </Button>
          </div>
        </>
      ) : mode === 'recovery-sent' ? (
        <>
          <Feedback
            title="已请求发送重置指引"
            message="如果该邮箱已注册，你将收到重设密码邮件，请检查收件箱和垃圾邮件。"
          />
          <Button onClick={() => changeMode('login')}>返回登录</Button>
          <Button variant="text" onClick={() => changeMode('forgot')}>
            重新发起找回
          </Button>
        </>
      ) : (
        <form
          ref={formRef}
          key={mode}
          noValidate
          className="flex flex-col gap-4"
          onSubmit={submit}
          aria-busy={busy}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.nativeEvent.isComposing || composing.current))
              e.preventDefault()
          }}
        >
          <Field
            name="email"
            label="邮箱地址"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="name@example.com"
            maxLength={320}
            required
            disabled={busy}
            error={errors.email}
          />
          {mode !== 'forgot' && (
            <Field
              name="password"
              label="密码"
              type="password"
              required
              maxLength={4096}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              placeholder="请输入密码"
              disabled={busy}
              hint={mode === 'register' ? snapshot.capabilities.passwordHint : undefined}
              error={errors.password}
            />
          )}
          {mode === 'register' && (
            <Field
              name="confirm"
              label="确认密码"
              type="password"
              autoComplete="new-password"
              required
              maxLength={4096}
              placeholder="请再次输入密码"
              disabled={busy}
              error={errors.confirm}
            />
          )}
          <div className="auth-actions">
            {mode === 'login' && (
              <Button variant="text" disabled={busy} onClick={() => changeMode('forgot')}>
                忘记密码？
              </Button>
            )}
            <Button type="submit" disabled={busy}>
              {busy
                ? '处理中…'
                : mode === 'login'
                  ? '登录'
                  : mode === 'register'
                    ? '创建账号'
                    : '发送重置指引'}
            </Button>
            <Button
              variant="text"
              disabled={busy}
              onClick={() => changeMode(mode === 'login' ? 'register' : 'login')}
            >
              {mode === 'login'
                ? '没有账号？创建账号'
                : mode === 'register'
                  ? '已有账号？登录'
                  : '返回登录'}
            </Button>
          </div>
        </form>
      )}
    </AuthFrame>
  )
}
