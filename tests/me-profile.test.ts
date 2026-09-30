import { afterEach, expect, it, vi } from 'vitest'
import { AuthService } from '../src/main/auth/service'
import type { AuthRuntime } from '../src/main/auth/client'
import { avatarFor } from '../src/shared/profile'
const services: AuthService[] = []
afterEach(() => services.splice(0).forEach((s) => s.dispose()))
const config = {
  url: 'https://fixture.supabase.co',
  publicKey: 'fixture',
  confirmUrl: null,
  recoveryUrl: null,
  passwordHint: 'fixture'
}
function fixture(): {
  service: AuthService
  current: {
    id: string
    email: string
    user_metadata: { nickname: string; avatar: ReturnType<typeof avatarFor> }
  }
  auth: Record<string, ReturnType<typeof vi.fn>>
  rpc: ReturnType<typeof vi.fn>
} {
  const current = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'a@example.com',
    user_metadata: { nickname: 'Old', avatar: avatarFor('🐼') }
  }
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: { user: current, access_token: 'synthetic' } },
      error: null
    })),
    getUser: vi.fn(async () => ({
      data: { user: structuredClone(current) },
      error: null as unknown
    })),
    updateUser: vi.fn(async (input: { data: object }) => {
      Object.assign(current.user_metadata, input.data)
      return { data: { user: structuredClone(current) }, error: null }
    }),
    signOut: vi.fn(async () => ({ error: null })),
    onAuthStateChange: vi.fn(),
    startAutoRefresh: vi.fn(),
    dispose: vi.fn()
  }
  const rpc = vi.fn(async () => ({ data: true, error: null }))
  const runtime = {
    client: { auth, rpc },
    storage: { freeze: vi.fn(), clear: vi.fn() },
    abortRequests: vi.fn()
  } as unknown as AuthRuntime
  const service = new AuthService(
    config,
    async () => runtime,
    async () => {}
  )
  services.push(service)
  return { service, auth, rpc, current }
}
it('writes only the edited profile field and preserves a remote change to the other field', async () => {
  const { service, current, auth } = fixture()
  await service.retry()
  current.user_metadata.avatar = avatarFor('🐱')
  expect(await service.updateNickname(' New ')).toMatchObject({
    ok: true,
    data: { outcome: 'saved', profile: { nickname: 'New', avatar: avatarFor('🐱') } }
  })
  expect(auth.updateUser).toHaveBeenLastCalledWith({ data: { nickname: 'New' } })
  await service.updateAvatar(avatarFor('🦊'))
  expect(auth.updateUser).toHaveBeenLastCalledWith({ data: { avatar: avatarFor('🦊') } })
  expect(service.getState().profile?.nickname).toBe('New')
})
it('rejects invalid edits and treats unchanged values as no-ops', async () => {
  const { service, auth } = fixture()
  await service.retry()
  expect(await service.updateNickname('Old')).toMatchObject({
    ok: true,
    data: { outcome: 'unchanged' }
  })
  for (const value of ['', 'x\ny', 'x'.repeat(41)])
    expect(await service.updateNickname(value)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
  expect(await service.updateAvatar({ emoji: '🐼', bg: '#123456' })).toMatchObject({
    ok: false,
    error: { code: 'invalid_input' }
  })
  expect(auth.updateUser).not.toHaveBeenCalled()
})
it('reads back an ambiguous committed write without automatically issuing another write', async () => {
  const { service, auth, current } = fixture()
  await service.retry()
  auth.updateUser.mockImplementationOnce(async (input) => {
    Object.assign(current.user_metadata, input.data)
    throw new TypeError('synthetic transport lost after commit')
  })
  expect(await service.updateNickname('Committed')).toMatchObject({
    ok: true,
    data: { outcome: 'saved', profile: { nickname: 'Committed' } }
  })
  expect(auth.updateUser).toHaveBeenCalledOnce()
})
it('does not log out or erase a confirmed profile when an extra refresh is temporarily unavailable', async () => {
  const { service, auth } = fixture()
  await service.retry()
  auth.getUser.mockResolvedValueOnce({ data: { user: null as never }, error: { status: 503 } })
  expect(await service.refreshProfile()).toMatchObject({
    ok: false,
    error: { code: 'provider_unavailable' }
  })
  expect(service.getState().status).toBe('signed-in')
  expect(auth.signOut).not.toHaveBeenCalled()
})
it('cancels a queued edit and rejects a late write after logout', async () => {
  const { service, auth } = fixture()
  await service.retry()
  let release!: () => void
  auth.updateUser.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      data: {
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          email: 'a@example.com',
          user_metadata: { nickname: 'Late' }
        } as never
      },
      error: null
    }
  })
  const first = service.updateNickname('Late'),
    queued = service.updateAvatar(avatarFor('🐱'))
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await service.signOut()
  release()
  expect(await first).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  expect(await queued).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  expect(auth.updateUser).toHaveBeenCalledOnce()
  expect(service.getState().profile).toBeNull()
})
