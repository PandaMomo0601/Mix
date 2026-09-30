import { createClient } from '@supabase/supabase-js'
import { expect, it, vi } from 'vitest'
import { AuthService } from '../src/main/auth/service'
import type { AuthRuntime } from '../src/main/auth/client'

it.each(['deleting', 'deleted', 'session_expired'])(
  'checks %s with the retained request token after Auth clears the SDK session',
  async (status) => {
    const user = { id: '00000000-0000-4000-8000-000000000001', email: 'fixture@example.invalid' }
    const token = 'synthetic-retained-token'
    const values = new Map<string, string>()
    values.set(
      'fixture-session',
      JSON.stringify({
        access_token: token,
        refresh_token: 'synthetic-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600,
        token_type: 'bearer',
        user
      })
    )
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
      freeze: vi.fn(),
      clear: vi.fn(async () => {
        values.clear()
      })
    }
    const headers: string[] = []
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/auth/v1/user')) {
        // A revoked session makes the real SDK discard its persisted session.
        return new Response(
          JSON.stringify({ code: 'session_not_found', message: 'Fixture session unavailable' }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json', 'x-supabase-api-version': '2024-01-01' }
          }
        )
      }
      expect(String(input)).toContain('/rest/v1/rpc/mix_account_status')
      headers.push(new Headers(init?.headers).get('Authorization') ?? '')
      return new Response(JSON.stringify(status), {
        headers: { 'Content-Type': 'application/json' }
      })
    }
    const config = {
      url: 'https://fixture.supabase.co',
      publicKey: 'fixture',
      confirmUrl: null,
      recoveryUrl: null,
      passwordHint: 'fixture'
    }
    const client = createClient(config.url, config.publicKey, {
      auth: {
        storage,
        storageKey: 'fixture-session',
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false
      },
      global: { fetch: fetcher }
    })
    const runtime = { client, storage, abortRequests: vi.fn() } as unknown as AuthRuntime
    const service = new AuthService(
      config,
      async () => runtime,
      async () => {}
    )
    const clearKeys = vi.fn(async () => {})
    service.onAccountRemoved(clearKeys)
    try {
      await service.retry()
      expect(service.getState().status).toBe('signed-out')
      expect(headers).toEqual(['Bearer ' + token])
      expect(clearKeys).toHaveBeenCalledTimes(status === 'session_expired' ? 0 : 1)
    } finally {
      service.dispose()
    }
  }
)
