export interface MailCallback {
  type: 'signup' | 'recovery'
  accessToken: string
  refreshToken: string
}

// This parses the callback shape only. Supabase still has to validate its credentials.
export function parseMailCallback(hash: string, pathname: string): MailCallback | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const type = params.get('type')
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  const expected = pathname.endsWith('/recovery.html')
    ? 'recovery'
    : pathname.endsWith('/confirm.html')
      ? 'signup'
      : null
  if (!expected || type !== expected || params.has('error') || !accessToken || !refreshToken)
    return null
  if (
    params.getAll('type').length !== 1 ||
    params.getAll('access_token').length !== 1 ||
    params.getAll('refresh_token').length !== 1
  )
    return null
  if (accessToken.length > 32768 || refreshToken.length > 4096) return null
  return { type, accessToken, refreshToken }
}
