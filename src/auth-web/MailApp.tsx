import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { AuthFrame, Button, Feedback, Field } from '../renderer/src/features/auth/Controls'
import { mapAuthError } from '../shared/auth-errors'
import { parseMailCallback } from '../shared/mail-callback'

type MailState = 'loading' | 'invalid' | 'recovery' | 'confirmed' | 'complete' | 'connection-error'
let client: SupabaseClient | null = null
const callback = parseMailCallback(window.location.hash, window.location.pathname)
// Clear sensitive parameters before async work, rendering or subsequent navigation.
window.history.replaceState(null, '', window.location.pathname)

async function clearSession(): Promise<void> {
  const current = client
  client = null
  if (current) {
    try {
      await current.auth.signOut({ scope: 'local' })
    } catch {
      /* Local memory is discarded below. */
    } finally {
      await current.auth.dispose()
    }
  }
}

async function initialize(): Promise<MailState> {
  if (!callback || !__AUTH_URL__ || !__AUTH_KEY__) return 'invalid'
  client = createClient(__AUTH_URL__, __AUTH_KEY__, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'implicit',
      storageKey: 'mix-mail-only'
    },
    global: {
      fetch: async (input, init) => {
        try {
          return await fetch(input, { ...init, signal: AbortSignal.timeout(12000) })
        } catch {
          throw new TypeError('Auth connection unavailable')
        }
      }
    }
  })
  try {
    const { data, error } = await client.auth.setSession({
      access_token: callback.accessToken,
      refresh_token: callback.refreshToken
    })
    // Drop callback credentials as soon as the SDK has consumed them.
    callback.accessToken = ''
    callback.refreshToken = ''
    if (error) throw error
    if (!data.session || !data.user?.email || data.user.is_anonymous) {
      await clearSession()
      return 'invalid'
    }
    if (callback.type === 'recovery') return 'recovery'
    if (!data.user.email_confirmed_at) {
      await clearSession()
      return 'invalid'
    }
    await clearSession()
    return 'confirmed'
  } catch (error) {
    const code = mapAuthError(error).code
    await clearSession()
    return code === 'connection' ? 'connection-error' : 'invalid'
  } finally {
    callback.accessToken = ''
    callback.refreshToken = ''
  }
}
const initialization = initialize()

export default function MailApp(): React.JSX.Element {
  const [state, setState] = useState<MailState>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const composing = useRef(false)
  useEffect(() => {
    let active = true
    void initialization.then((value) => {
      if (active) setState(value)
    })
    return () => {
      active = false
    }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy || composing.current || !client || state !== 'recovery') return
    const form = event.currentTarget
    const data = new FormData(form)
    const password = String(data.get('password') ?? '')
    if (!password || password !== data.get('confirm')) {
      setMessage(!password ? '请输入新密码。' : '两次输入的密码不一致。')
      ;(form.elements.namedItem(!password ? 'password' : 'confirm') as HTMLElement).focus()
      return
    }
    setBusy(true)
    setMessage(null)
    form.reset()
    try {
      const { error } = await client.auth.updateUser({ password })
      if (error) throw error
      await clearSession()
      setState('complete')
    } catch (error) {
      const mapped = mapAuthError(error)
      if (mapped.code === 'session-expired') {
        await clearSession()
        setState('invalid')
      } else setMessage(mapped.message)
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading') return <AuthFrame title="正在验证链接" description="请稍候…" />
  if (state === 'invalid' || state === 'connection-error')
    return (
      <AuthFrame
        title={state === 'invalid' ? '链接无效或已过期' : '暂时无法验证链接'}
        description="请回到 Mix 重新发起请求，再打开最新邮件中的链接。"
      />
    )
  if (state === 'confirmed' || state === 'complete')
    return (
      <AuthFrame
        title={state === 'confirmed' ? '邮箱已确认' : '密码已更新'}
        description="现在可以关闭此页面，回到 Mix 桌面应用登录。"
      />
    )
  return (
    <AuthFrame title="设置新密码" description="为你的 Mix 账号设置一个新密码。">
      {message && <Feedback title="未能完成" message={message} error />}
      <form
        className="flex flex-col gap-4"
        noValidate
        aria-busy={busy}
        onSubmit={(e) => void submit(e)}
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
          name="password"
          label="新密码"
          type="password"
          placeholder="请输入新密码"
          autoComplete="new-password"
          maxLength={4096}
          required
          disabled={busy}
          hint={__PASSWORD_HINT__}
        />
        <Field
          name="confirm"
          label="确认密码"
          type="password"
          placeholder="请再次输入密码"
          autoComplete="new-password"
          maxLength={4096}
          required
          disabled={busy}
        />
        <Button type="submit" disabled={busy}>
          {busy ? '保存中…' : '保存新密码'}
        </Button>
      </form>
    </AuthFrame>
  )
}
