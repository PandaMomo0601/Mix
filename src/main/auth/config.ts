export interface AuthConfig {
  url: string
  publicKey: string
  confirmUrl: string | null
  recoveryUrl: string | null
  passwordHint: string
}

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
      return null
    return url.href
  } catch {
    return null
  }
}

export function isPublicKey(key: string): boolean {
  if (key.startsWith('sb_publishable_')) return key.length > 20
  try {
    return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'
  } catch {
    return false
  }
}

export function readAuthConfig(env: {
  MAIN_VITE_SUPABASE_URL?: string
  MAIN_VITE_SUPABASE_PUBLISHABLE_KEY?: string
  MAIN_VITE_AUTH_CONFIRM_URL?: string
  MAIN_VITE_AUTH_RECOVERY_URL?: string
  MAIN_VITE_AUTH_PASSWORD_HINT?: string
}): AuthConfig | null {
  const url = httpsUrl(env.MAIN_VITE_SUPABASE_URL)
  const publicKey = env.MAIN_VITE_SUPABASE_PUBLISHABLE_KEY ?? ''
  if (!url || !isPublicKey(publicKey)) return null
  return {
    url: url.replace(/\/$/, ''),
    publicKey,
    confirmUrl: httpsUrl(env.MAIN_VITE_AUTH_CONFIRM_URL),
    recoveryUrl: httpsUrl(env.MAIN_VITE_AUTH_RECOVERY_URL),
    passwordHint: env.MAIN_VITE_AUTH_PASSWORD_HINT || '请设置不易猜测的密码。'
  }
}
