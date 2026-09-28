import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AuthConfig } from './config'
import type { SecureSessionStorage } from './secure-storage'

export interface AuthRuntime {
  client: SupabaseClient
  storage: SecureSessionStorage
  abortRequests: () => void
}

export function createAuthRuntime(config: AuthConfig, storage: SecureSessionStorage): AuthRuntime {
  const pending = new Set<AbortController>()
  const boundedFetch: typeof fetch = async (input, init) => {
    const controller = new AbortController()
    pending.add(controller)
    const timer = setTimeout(() => controller.abort(), 12000)
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal
    try {
      return await fetch(input, { ...init, signal })
    } catch {
      throw new TypeError('Auth connection unavailable')
    } finally {
      clearTimeout(timer)
      pending.delete(controller)
    }
  }
  const client = createClient(config.url, config.publicKey, {
    auth: {
      storage,
      storageKey: 'mix-auth-session',
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'implicit'
    },
    global: { fetch: boundedFetch }
  })
  return {
    client,
    storage,
    abortRequests: () => {
      for (const c of pending) c.abort()
    }
  }
}
