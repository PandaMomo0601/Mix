import { afterEach, expect, it, vi } from 'vitest'
import { MeService } from '../src/main/me/service'
import type { AuthService } from '../src/main/auth/service'
import type { CredentialStore, DeletionReceipt } from '../src/main/me/credential-store'
const A = '00000000-0000-4000-8000-000000000001',
  B = '00000000-0000-4000-8000-000000000002',
  id = '00000000-0000-4000-8000-000000000003'
const summary = {
  id,
  providerId: 'deepseek',
  displayName: 'DeepSeek',
  keyHint: '•••• 1234',
  status: 'verified',
  lastVerifiedAt: '2026-09-29T00:00:00Z',
  displayOrder: 0,
  revision: 1,
  credentialVersion: 1,
  createdAt: '2026-09-29T00:00:00Z',
  updatedAt: '2026-09-29T00:00:00Z'
}
const services: MeService[] = []
afterEach(() => services.splice(0).forEach((s) => s.dispose()))
function fixture(): {
  service: MeService
  fetcher: ReturnType<typeof vi.fn>
  vault: Record<string, ReturnType<typeof vi.fn>>
  auth: Record<string, ReturnType<typeof vi.fn>>
  identity: { userId: string; token: string; signal: AbortSignal; epoch: number }
  profile: { id: string }
} {
  const profile = { id: A },
    identity = {
      userId: A,
      token: 'synthetic-token',
      signal: new AbortController().signal,
      epoch: 1
    }
  const auth = {
    subscribe: vi.fn(() => () => {}),
    onAccountRemoved: vi.fn(() => () => {}),
    getState: vi.fn(() => ({ profile })),
    signOut: vi.fn(async () => ({ ok: true })),
    authenticated: vi.fn(async (action) => action(identity))
  }
  const vault = {
    state: vi.fn(async () => 'ready'),
    stage: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    candidate: vi.fn(async () => ({ apiKey: 'synthetic-key-1234' })),
    discardCandidates: vi.fn(async () => {}),
    receipt: vi.fn(async () => null as DeletionReceipt | null),
    saveReceipt: vi.fn(async () => {}),
    clearAccount: vi.fn(async () => {})
  }
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body)
    return Response.json({
      ok: true,
      data:
        body.action === 'list'
          ? { connections: [summary], providers: [], listRevision: 1 }
          : summary
    })
  })
  const service = new MeService(
    auth as unknown as AuthService,
    {
      url: 'https://fixture.supabase.co',
      publicKey: 'fixture',
      confirmUrl: null,
      recoveryUrl: null,
      passwordHint: 'fixture'
    },
    vault as unknown as CredentialStore,
    fetcher
  )
  services.push(service)
  return { service, fetcher, vault, auth, identity, profile }
}
it('reopening after an unknown deletion result reuses the saved request and secret', async () => {
  const { service, fetcher, vault } = fixture()
  const receipt = {
    userId: A,
    requestId: crypto.randomUUID(),
    secret: 'x'.repeat(43),
    createdAt: Date.now()
  }
  vault.receipt.mockResolvedValue(receipt)
  fetcher.mockRejectedValueOnce(new TypeError('synthetic unknown result'))
  expect(
    await service.requestAccountDeletion({
      requestId: crypto.randomUUID(),
      password: 'synthetic',
      confirmed: true,
      scopeVersion: 'shared-account-v1'
    })
  ).toMatchObject({ ok: false, error: { code: 'unknown' } })
  const body = JSON.parse(fetcher.mock.calls[0][1].body)
  expect(body.requestId).toBe(receipt.requestId)
  expect(body.receiptSecret).toBe(receipt.secret)
  expect(vault.saveReceipt).toHaveBeenCalledWith(receipt)
})
it('reports a cloud commit with failed local saving and recovers without another provider call', async () => {
  const { service, fetcher, vault } = fixture(),
    requestId = crypto.randomUUID()
  vault.save.mockRejectedValueOnce(Error('synthetic disk failure'))
  expect(
    await service.createVerifiedConnection({
      providerId: 'deepseek',
      apiKey: 'synthetic-key-1234',
      requestId
    })
  ).toMatchObject({
    ok: true,
    data: { outcome: 'partial', connection: { localCredentialState: 'error' } }
  })
  expect(await service.recoverOperation({ requestId })).toMatchObject({
    ok: true,
    data: { outcome: 'saved', connection: { localCredentialState: 'ready' } }
  })
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init.body).action)).toEqual([
    'create',
    'operation',
    'list'
  ])
  expect(vault.save).toHaveBeenLastCalledWith(A, id, 1, 'synthetic-key-1234')
})
it('does not overwrite a newer cloud credential version during recovery', async () => {
  const { service, fetcher, vault } = fixture()
  fetcher.mockResolvedValueOnce(Response.json({ ok: true, data: summary })).mockResolvedValueOnce(
    Response.json({
      ok: true,
      data: {
        connections: [{ ...summary, credentialVersion: 2 }],
        providers: [],
        listRevision: 2
      }
    })
  )
  expect(await service.recoverOperation({ requestId: crypto.randomUUID() })).toMatchObject({
    ok: false,
    error: { code: 'credential_stale' }
  })
  expect(vault.save).not.toHaveBeenCalled()
  expect(vault.discard).toHaveBeenCalledOnce()
})
it('keeps ambiguous candidates and never automatically retries a request', async () => {
  const { service, fetcher, vault } = fixture()
  fetcher.mockRejectedValueOnce(TypeError('synthetic response loss'))
  expect(
    await service.createVerifiedConnection({
      providerId: 'deepseek',
      apiKey: 'synthetic-key-1234',
      requestId: crypto.randomUUID()
    })
  ).toMatchObject({ ok: false, error: { code: 'unknown' } })
  expect(fetcher).toHaveBeenCalledOnce()
  expect(vault.discard).not.toHaveBeenCalled()
})
it('never treats a failed or malformed list as permission to erase credentials', async () => {
  const { service, fetcher, vault } = fixture()
  fetcher.mockResolvedValueOnce(
    Response.json({ ok: false, error: { code: 'provider_unavailable' } }, { status: 503 })
  )
  expect(await service.listConnections()).toMatchObject({ ok: false })
  fetcher.mockResolvedValueOnce(
    Response.json({ ok: true, data: { connections: [], providers: [] } })
  )
  expect(await service.listConnections()).toMatchObject({ ok: false })
  expect(vault.reconcile).not.toHaveBeenCalled()
})
it('strips unsolicited secrets from the renderer summary', async () => {
  const { service, fetcher } = fixture()
  fetcher.mockResolvedValueOnce(
    Response.json({
      ok: true,
      data: {
        connections: [{ ...summary, apiKey: 'must-not-reach-renderer', ownerId: 'forged' }],
        providers: [],
        listRevision: 1
      }
    })
  )
  expect(JSON.stringify(await service.listConnections())).not.toMatch(
    /must-not-reach-renderer|ownerId/
  )
})
it('pre-stages a receipt, coalesces deletion and blocks a competing request from replacing it', async () => {
  const { service, fetcher, vault } = fixture(),
    requestId = crypto.randomUUID()
  let release!: () => void
  fetcher.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return Response.json({
      ok: true,
      data: { operationId: id, phase: 'processing', nextPollAfter: 10 }
    })
  })
  const input = {
    requestId,
    password: 'synthetic-password',
    confirmed: true as const,
    scopeVersion: 'shared-account-v1' as const
  }
  const pending = service.requestAccountDeletion(input)
  expect(service.requestAccountDeletion(input)).toBe(pending)
  expect(
    await service.requestAccountDeletion({ ...input, requestId: crypto.randomUUID() })
  ).toMatchObject({ ok: false, error: { code: 'rate_limited' } })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(vault.saveReceipt).toHaveBeenCalledOnce()
  expect(vault.saveReceipt.mock.calls[0][0].secret).toHaveLength(43)
  release()
  expect(await pending).toMatchObject({ ok: true, data: { phase: 'processing' } })
  expect(fetcher).toHaveBeenCalledOnce()
})
it('does not sign out a new account while accepted deletion cleans the old account', async () => {
  const { service, fetcher, vault, auth, profile } = fixture()
  fetcher.mockResolvedValueOnce(
    Response.json({ ok: true, data: { operationId: id, phase: 'processing', nextPollAfter: 10 } })
  )
  vault.clearAccount.mockImplementationOnce(async () => {
    profile.id = B
  })
  expect(
    await service.requestAccountDeletion({
      requestId: crypto.randomUUID(),
      password: 'synthetic',
      confirmed: true,
      scopeVersion: 'shared-account-v1'
    })
  ).toMatchObject({ ok: true, data: { phase: 'processing' } })
  expect(vault.clearAccount).toHaveBeenCalledWith(A)
  expect(auth.signOut).not.toHaveBeenCalled()
})
it('an expired receipt cannot erase credentials or sign out the user', async () => {
  const { service, fetcher, vault, auth } = fixture()
  vault.receipt.mockResolvedValue({
    userId: A,
    requestId: crypto.randomUUID(),
    secret: 'synthetic',
    createdAt: Date.now()
  })
  fetcher.mockResolvedValueOnce(
    Response.json({ ok: true, data: { operationId: id, phase: 'expired', nextPollAfter: 10 } })
  )
  expect(await service.getDeletionStatus()).toMatchObject({ ok: true, data: { phase: 'expired' } })
  expect(vault.clearAccount).not.toHaveBeenCalled()
  expect(auth.signOut).not.toHaveBeenCalled()
})
