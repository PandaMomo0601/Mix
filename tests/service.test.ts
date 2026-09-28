import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthRuntime } from '../src/main/auth/client'
import type { AuthConfig } from '../src/main/auth/config'
import { AuthService } from '../src/main/auth/service'

const config: AuthConfig = {
  url: 'https://example.supabase.co',
  publicKey: 'fixture',
  confirmUrl: 'https://example.com/confirm.html',
  recoveryUrl: 'https://example.com/recovery.html',
  passwordHint: 'test'
}
const userA = { id: 'A', email: 'a@example.com', user_metadata: { nickname: 'A' } }
const userB = { id: 'B', email: 'b@example.com', user_metadata: { nickname: 'B' } }
const credentials = { email: 'a@example.com', password: 'secret-fixture' }
const services: AuthService[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.dispose()
  vi.useRealTimers()
})

function fixture(user = userA): {
  runtime: AuthRuntime
  auth: Record<string, ReturnType<typeof vi.fn>>
  storage: Record<string, ReturnType<typeof vi.fn>>
} {
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: { user } }, error: null })),
    getUser: vi.fn(async () => ({ data: { user }, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: { session: { user } }, error: null })),
    signUp: vi.fn(async () => ({ data: { user, session: null }, error: null })),
    resend: vi.fn(async () => ({ error: null })),
    resetPasswordForEmail: vi.fn(async () => ({ error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    onAuthStateChange: vi.fn(),
    startAutoRefresh: vi.fn(async () => {}),
    dispose: vi.fn(async () => {})
  }
  const storage = { freeze: vi.fn(), clear: vi.fn(async () => {}) }
  return {
    auth,
    storage,
    runtime: { client: { auth }, storage, abortRequests: vi.fn() } as unknown as AuthRuntime
  }
}
function setup(...runtimes: AuthRuntime[]): {
  service: AuthService
  clear: ReturnType<typeof vi.fn>
} {
  const clear = vi.fn(async () => {})
  const service = new AuthService(config, async () => runtimes.shift()!, clear)
  services.push(service)
  return { service, clear }
}

describe('authentication lifecycle', () => {
  it('verifies remote identity and exposes only the normalized public snapshot', async () => {
    const f = fixture()
    const { service } = setup(f.runtime)
    await service.retry()
    expect(f.auth.getUser).toHaveBeenCalledOnce()
    expect(service.getState()).toMatchObject({
      status: 'signed-in',
      profile: { id: 'A', displayName: 'A' }
    })
    expect(JSON.stringify(service.getState())).not.toMatch(/token|user_metadata|password"/)
  })
  it('retains credentials on a transient failure but clears an explicitly expired session', async () => {
    const offline = fixture()
    offline.auth.getUser.mockResolvedValue({ data: { user: null }, error: { status: 503 } })
    const { service } = setup(offline.runtime)
    await service.retry()
    expect(service.getState().status).toBe('connection-error')
    expect(offline.storage.clear).not.toHaveBeenCalled()
    const expired = fixture()
    expired.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: { code: 'refresh_token_not_found' }
    })
    const other = setup(expired.runtime).service
    await other.retry()
    expect(expired.storage.clear).toHaveBeenCalledOnce()
    expect(other.getState().status).toBe('signed-out')
  })
  it('clears locally after an offline local-scope logout', async () => {
    const f = fixture()
    f.auth.signOut.mockRejectedValue(new TypeError('offline'))
    const { service } = setup(f.runtime)
    await service.retry()
    const result = await service.signOut()
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(f.storage.clear).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: true, message: '本机已退出，未能确认远端会话撤销。' })
    expect(service.getState().profile).toBeNull()
  })
  it('does not allow delayed A verification to overwrite a new B lifetime', async () => {
    let release!: (value: unknown) => void
    const a = fixture()
    a.auth.getUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const b = fixture(userB)
    const { service } = setup(a.runtime, b.runtime)
    const pending = service.signIn(credentials)
    await vi.waitFor(() => expect(a.auth.getUser).toHaveBeenCalledOnce())
    await service.signOut()
    await service.signIn({ email: 'b@example.com', password: 'fixture' })
    release({ data: { user: userA }, error: null })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(service.getState().profile?.id).toBe('B')
    expect(a.storage.freeze).toHaveBeenCalled()
  })
  it('coalesces repeated logout while the remote request is pending', async () => {
    let release!: (value: unknown) => void
    const f = fixture()
    f.auth.signOut.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const { service } = setup(f.runtime)
    await service.retry()
    const one = service.signOut()
    const two = service.signOut()
    expect(one).toBe(two)
    await vi.waitFor(() => expect(f.auth.signOut).toHaveBeenCalledOnce())
    release({ error: null })
    await one
    expect(f.storage.clear).toHaveBeenCalledOnce()
  })
  it('does not accept a User without a session as a successful sign-in', async () => {
    const f = fixture()
    const { service } = setup(f.runtime)
    const result = await service.signUp(credentials)
    expect(result).toEqual({ ok: true, outcome: 'check-email' })
    expect(service.getState().profile).toBeNull()
    expect(f.auth.getUser).not.toHaveBeenCalled()
  })
  it('reports a failed local deletion and supports retrying clear', async () => {
    const f = fixture()
    f.storage.clear.mockRejectedValueOnce(Error('filesystem'))
    const { service, clear } = setup(f.runtime)
    await service.retry()
    expect(await service.signOut()).toMatchObject({ ok: false, error: { code: 'storage' } })
    expect(service.getState().status).toBe('storage-error')
    await service.signOut()
    expect(clear).toHaveBeenCalledOnce()
    expect(service.getState().status).toBe('signed-out')
  })
  it('bounds a hung operation and rejects its eventual response', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let release!: (value: unknown) => void
    f.auth.signInWithPassword.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const { service } = setup(f.runtime)
    const pending = service.signIn(credentials)
    await vi.advanceTimersByTimeAsync(16001)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'connection' } })
    release({ data: { session: { user: userA } }, error: null })
    await vi.advanceTimersByTimeAsync(1)
    expect(service.getState().profile).toBeNull()
    expect(f.storage.freeze).toHaveBeenCalled()
  })
})
