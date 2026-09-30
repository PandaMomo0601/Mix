import { afterEach, expect, it, vi } from 'vitest'
import { AuthService } from '../src/main/auth/service'
import type { AuthRuntime } from '../src/main/auth/client'

const temporary = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  dispose: vi.fn()
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ auth: temporary })) }))
const config = {
  url: 'https://fixture.supabase.co',
  publicKey: 'fixture',
  confirmUrl: null,
  recoveryUrl: null,
  passwordHint: 'fixture'
}
const services: AuthService[] = []
afterEach(() => {
  services.splice(0).forEach((s) => s.dispose())
  vi.clearAllMocks()
})
function setup(): {
  service: AuthService
  auth: {
    signInWithPassword: ReturnType<typeof vi.fn>
    signOut: ReturnType<typeof vi.fn>
  }
  user: { id: string; email: string; user_metadata: { nickname: string } }
} {
  const user = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'a@example.com',
    user_metadata: { nickname: 'Original' }
  }
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: { user, access_token: 'original-session' } },
      error: null
    })),
    getUser: vi.fn(async () => ({ data: { user }, error: null })),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(async () => ({ error: null })),
    onAuthStateChange: vi.fn(),
    startAutoRefresh: vi.fn(),
    dispose: vi.fn()
  }
  const service = new AuthService(
    config,
    async () =>
      ({
        client: { auth, rpc: vi.fn(async () => ({ data: true, error: null })) },
        storage: { freeze: vi.fn(), clear: vi.fn() },
        abortRequests: vi.fn()
      }) as unknown as AuthRuntime,
    async () => {}
  )
  services.push(service)
  temporary.signOut.mockResolvedValue({ error: null })
  temporary.dispose.mockResolvedValue(undefined)
  return { service, auth, user }
}
it('verifies the current account without replacing or revoking its active session', async () => {
  const { service, auth, user } = setup()
  await service.retry()
  temporary.signInWithPassword.mockResolvedValue({
    data: { user, session: { access_token: 'temporary-session' } },
    error: null
  })
  const before = service.getState()
  expect(await service.reauthenticateForDeletion('synthetic-password')).toEqual({
    ok: true,
    data: { verified: true }
  })
  expect(service.getState()).toEqual(before)
  expect(auth.signInWithPassword).not.toHaveBeenCalled()
  expect(auth.signOut).not.toHaveBeenCalled()
  expect(temporary.signOut).toHaveBeenCalledWith({ scope: 'local' })
  expect(temporary.dispose).toHaveBeenCalledOnce()
})
it('rejects incorrect passwords and a successful verification for a different account', async () => {
  const { service, auth, user } = setup()
  await service.retry()
  temporary.signInWithPassword.mockResolvedValueOnce({
    data: { user: null, session: null },
    error: { code: 'invalid_credentials' }
  })
  expect(await service.reauthenticateForDeletion('wrong')).toMatchObject({
    ok: false,
    error: { code: 'reauthentication_failed' }
  })
  temporary.signInWithPassword.mockResolvedValueOnce({
    data: { user: { ...user, id: 'different-account' }, session: {} },
    error: null
  })
  expect(await service.reauthenticateForDeletion('synthetic-password')).toMatchObject({
    ok: false,
    error: { code: 'reauthentication_failed' }
  })
  expect(service.getState().status).toBe('signed-in')
  expect(auth.signOut).not.toHaveBeenCalled()
  expect(temporary.dispose).toHaveBeenCalledTimes(2)
})
it('cannot advance a pending verification after the current session is signed out', async () => {
  const { service, user } = setup()
  await service.retry()
  let release!: () => void
  temporary.signInWithPassword.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { data: { user, session: {} }, error: null }
  })
  const pending = service.reauthenticateForDeletion('synthetic-password')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await service.signOut()
  release()
  expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  expect(service.getState().status).toBe('signed-out')
  expect(temporary.dispose).toHaveBeenCalledOnce()
})
