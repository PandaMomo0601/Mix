import type { AuthErrorCode, AuthFailure } from './auth'

const messages: Record<AuthErrorCode, string> = {
  'invalid-input': '请检查邮箱和密码后再试。',
  'invalid-credentials': '邮箱或密码不正确。',
  'email-unconfirmed': '请先完成邮箱确认，再回来登录。',
  'weak-password': '密码未满足安全要求，请使用更长、包含多种字符且未被泄露的密码。',
  'rate-limit': '操作太频繁，请稍后重试。',
  connection: '连接失败，请检查网络后重试。',
  'session-expired': '登录已失效，请重新登录。',
  storage: '暂时无法访问本机登录信息，请重试，或清除本机登录信息后重新登录。',
  configuration: '账号服务暂未就绪，请稍后重试。',
  busy: '正在处理，请稍候。',
  cancelled: '操作已取消，请重新操作。',
  unknown: '暂时无法完成，请稍后重试。'
}

export function failure(code: AuthErrorCode): AuthFailure {
  return { code, message: messages[code] }
}

export class LocalAuthError extends Error {
  constructor(public readonly kind: AuthErrorCode) {
    super(kind)
  }
}

export function mapAuthError(error: unknown): AuthFailure {
  if (error instanceof LocalAuthError) return failure(error.kind)
  if (!error || typeof error !== 'object') return failure('unknown')
  const { code, status, name } = error as { code?: string; status?: number; name?: string }
  if (code === 'invalid_credentials') return failure('invalid-credentials')
  if (code === 'email_not_confirmed') return failure('email-unconfirmed')
  if (code === 'weak_password' || code === 'same_password') return failure('weak-password')
  if (status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit')
    return failure('rate-limit')
  if (
    [
      'refresh_token_not_found',
      'refresh_token_already_used',
      'session_not_found',
      'session_expired',
      'bad_jwt',
      'user_not_found',
      'user_banned'
    ].includes(code ?? '')
  )
    return failure('session-expired')
  if (name === 'AuthSessionMissingError') return failure('session-expired')
  if (
    (status && status >= 500) ||
    ['AuthRetryableFetchError', 'AbortError', 'TimeoutError', 'TypeError'].includes(name ?? '')
  )
    return failure('connection')
  return failure('unknown')
}
