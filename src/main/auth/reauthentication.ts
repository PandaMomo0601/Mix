import { createClient } from '@supabase/supabase-js'
import { mapAuthError } from '../../shared/auth-errors'
import { MeError } from '../../shared/me-errors'
import type { AuthConfig } from './config'

/** Password verification must never replace or revoke the app's existing session. */
export async function verifyDeletionPassword(
  config: AuthConfig,
  email: string,
  password: string,
  userId: string,
  signal: AbortSignal
): Promise<void> {
  const client = createClient(config.url, config.publicKey, {
    auth: {
      storageKey: 'mix-deletion-reauthentication',
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(12000),
            ...(init?.signal ? [init.signal] : [])
          ])
        })
    }
  })
  let temporarySession = false
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    temporarySession = Boolean(data.session)
    if (signal.aborted) throw new MeError('cancelled')
    if (error) {
      const mapped = mapAuthError(error).code
      throw new MeError(
        mapped === 'invalid-credentials' || mapped === 'email-unconfirmed'
          ? 'reauthentication_failed'
          : mapped === 'rate-limit'
            ? 'rate_limited'
            : 'provider_unavailable'
      )
    }
    if (!data.session || data.user?.id !== userId) throw new MeError('reauthentication_failed')
  } finally {
    if (temporarySession) {
      try {
        await client.auth.signOut({ scope: 'local' })
      } catch {
        /* Only the in-memory verification session is being retired. */
      }
    }
    await client.auth.dispose()
  }
}
