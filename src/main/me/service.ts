import { randomBytes } from 'node:crypto'
import type { AuthService } from '../auth/service'
import type { AuthConfig } from '../auth/config'
import type {
  MeResult,
  ConnectionList,
  ConnectionSummary,
  ConnectionWriteResult,
  CreateConnectionInput,
  ConnectionInput,
  KeyInput,
  CredentialInput,
  ModelOption,
  DeletionStatus
} from '../../shared/me'
import { MeError, isMeErrorCode, meFailed } from '../../shared/me-errors'
import { CredentialStore } from './credential-store'
import { parseSummary, parseList, parseDeletion } from './responses'

export class MeService {
  private unsubscribe: () => void
  private unsubscribeRemoval: () => void
  private deletionRequest: { id: string; promise: Promise<MeResult<DeletionStatus>> } | null = null
  constructor(
    private readonly auth: AuthService,
    private readonly config: AuthConfig | null,
    private readonly vault: CredentialStore,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.unsubscribeRemoval = auth.onAccountRemoved((userId) => vault.clearAccount(userId))
    let previous = auth.getState().profile?.id
    this.unsubscribe = auth.subscribe((state) => {
      const next = state.profile?.id
      if (previous && next !== previous && state.status !== 'connection-error')
        void vault.discardCandidates(previous).catch(() => {})
      if (next || state.status === 'signed-out' || state.status === 'starting') previous = next
    })
  }
  dispose(): void {
    this.unsubscribe()
    this.unsubscribeRemoval()
  }
  private async request(
    path: string,
    body: Record<string, unknown>,
    token?: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!this.config) throw new MeError('not_ready')
    const raw = JSON.stringify(body)
    if (Buffer.byteLength(raw) > 16384) throw new MeError('invalid_input')
    const timer = new AbortController()
    const timeout = setTimeout(() => timer.abort(), 30000)
    try {
      const response = await this.fetcher(this.config.url + '/functions/v1/' + path, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.config.publicKey,
          ...(token ? { Authorization: 'Bearer ' + token } : {})
        },
        body: raw,
        signal: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal
      })
      const reader = response.body?.getReader()
      let size = 0
      const chunks: Uint8Array[] = []
      if (!reader) throw new MeError('unknown')
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2 * 1024 * 1024) {
          await reader.cancel()
          throw new MeError('unknown')
        }
        chunks.push(value)
      }
      let result: unknown
      try {
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        throw new MeError(response.status === 404 ? 'not_ready' : 'unknown')
      }
      const value = result as {
        ok?: boolean
        error?: { code?: unknown; retryAfter?: unknown }
        data?: unknown
      }
      if (!response.ok || value.ok !== true) {
        const c = isMeErrorCode(value.error?.code)
          ? value.error.code
          : response.status === 404
            ? 'not_ready'
            : response.status === 401
              ? 'unauthorized'
              : 'unknown'
        throw new MeError(
          c,
          typeof value.error?.retryAfter === 'number'
            ? Math.max(1, Math.min(3600, value.error.retryAfter))
            : undefined
        )
      }
      return value.data
    } catch (error) {
      if (signal?.aborted) throw new MeError('cancelled')
      if (error instanceof MeError) throw error
      throw new MeError(timer.signal.aborted ? 'validation_timeout' : 'unknown')
    } finally {
      clearTimeout(timeout)
    }
  }
  private async enrich(userId: string, c: ConnectionSummary): Promise<ConnectionSummary> {
    return { ...c, localCredentialState: await this.vault.state(userId, c.id, c.credentialVersion) }
  }
  private async getList(
    userId: string,
    token: string,
    signal: AbortSignal
  ): Promise<ConnectionList> {
    const list = parseList(await this.request('me-connections', { action: 'list' }, token, signal))
    list.connections = await Promise.all(list.connections.map((c) => this.enrich(userId, c)))
    // Only a trusted successful full list permits removing credentials for deleted connections.
    await this.vault.reconcile(
      userId,
      list.connections.map((c) => c.id)
    )
    return list
  }
  async listConnections(): Promise<MeResult<ConnectionList>> {
    try {
      return {
        ok: true,
        data: await this.auth.authenticated((i) => this.getList(i.userId, i.token, i.signal))
      }
    } catch (e) {
      return meFailed(e)
    }
  }
  private async writeKey(
    action: 'create' | 'replace' | 'attach',
    input: CreateConnectionInput | CredentialInput | (ConnectionInput & KeyInput)
  ): Promise<MeResult<ConnectionWriteResult>> {
    try {
      const data = await this.auth.authenticated(async (i) => {
        await this.vault.stage(i.userId, {
          requestId: input.requestId,
          apiKey: input.apiKey,
          createdAt: Date.now()
        })
        let summary: ConnectionSummary
        try {
          summary = parseSummary(
            await this.request('me-connections', { action, ...input }, i.token, i.signal)
          )
        } catch (e) {
          if (
            e instanceof MeError &&
            ![
              'validation_timeout',
              'provider_unavailable',
              'unknown',
              'probe_unknown',
              'cancelled'
            ].includes(e.code)
          )
            await this.vault.discard(i.userId, input.requestId)
          throw e
        }
        if (i.signal.aborted) throw new MeError('cancelled')
        try {
          await this.vault.save(i.userId, summary.id, summary.credentialVersion, input.apiKey)
          await this.vault.discard(i.userId, input.requestId)
          return {
            connection: await this.enrich(i.userId, summary),
            outcome: 'saved' as const,
            requestId: input.requestId
          }
        } catch {
          return {
            connection: { ...summary, localCredentialState: 'error' as const },
            outcome: 'partial' as const,
            requestId: input.requestId
          }
        }
      })
      return { ok: true, data }
    } catch (e) {
      return meFailed(e)
    }
  }
  createVerifiedConnection(input: CreateConnectionInput): Promise<MeResult<ConnectionWriteResult>> {
    return this.writeKey('create', input)
  }
  attachLocalCredential(input: CredentialInput): Promise<MeResult<ConnectionWriteResult>> {
    return this.writeKey('attach', input)
  }
  async updateConnection(
    input: ConnectionInput & ({ displayName: string } | KeyInput)
  ): Promise<MeResult<ConnectionWriteResult>> {
    if ('apiKey' in input) return this.writeKey('replace', input)
    try {
      return {
        ok: true,
        data: await this.auth.authenticated(async (i) => ({
          connection: await this.enrich(
            i.userId,
            parseSummary(
              await this.request(
                'me-connections',
                { action: 'rename', ...input },
                i.token,
                i.signal
              )
            )
          ),
          outcome: 'saved',
          requestId: input.requestId
        }))
      }
    } catch (e) {
      return meFailed(e)
    }
  }
  async revalidateConnection(
    input: ConnectionInput & { credentialVersion: number; confirmedProbeVersion?: string }
  ): Promise<MeResult<ConnectionWriteResult>> {
    try {
      return {
        ok: true,
        data: await this.auth.authenticated(async (i) => {
          const apiKey = await this.vault.key(i.userId, input.id, input.credentialVersion)
          const c = parseSummary(
            await this.request(
              'me-connections',
              { action: 'revalidate', ...input, apiKey },
              i.token,
              i.signal
            )
          )
          return {
            connection: await this.enrich(i.userId, c),
            outcome: 'saved',
            requestId: input.requestId
          }
        })
      }
    } catch (e) {
      return meFailed(e)
    }
  }
  async deleteConnection(
    input: ConnectionInput
  ): Promise<MeResult<{ localCleanup: 'done' | 'failed' }>> {
    try {
      return {
        ok: true,
        data: await this.auth.authenticated(async (i) => {
          await this.request('me-connections', { action: 'delete', ...input }, i.token, i.signal)
          try {
            await this.vault.remove(i.userId, input.id)
            return { localCleanup: 'done' as const }
          } catch {
            return { localCleanup: 'failed' as const }
          }
        })
      }
    } catch (e) {
      return meFailed(e)
    }
  }
  async reorderConnections(input: {
    requestId: string
    ids: string[]
    listRevision: number
  }): Promise<MeResult<ConnectionList>> {
    try {
      return {
        ok: true,
        data: await this.auth.authenticated(async (i) => {
          await this.request('me-connections', { action: 'reorder', ...input }, i.token, i.signal)
          return this.getList(i.userId, i.token, i.signal)
        })
      }
    } catch (e) {
      return meFailed(e)
    }
  }
  async recoverOperation(input: { requestId: string }): Promise<MeResult<ConnectionWriteResult>> {
    try {
      return {
        ok: true,
        data: await this.auth.authenticated(async (i) => {
          const candidate = await this.vault.candidate(i.userId, input.requestId)
          const c = parseSummary(
            await this.request(
              'me-connections',
              { action: 'operation', ...input },
              i.token,
              i.signal
            )
          )
          const current = (await this.getList(i.userId, i.token, i.signal)).connections.find(
            (v) => v.id === c.id
          )
          if (!current || current.credentialVersion !== c.credentialVersion) {
            await this.vault.discard(i.userId, input.requestId)
            throw new MeError('credential_stale')
          }
          if (candidate) {
            await this.vault.save(i.userId, c.id, c.credentialVersion, candidate.apiKey)
            await this.vault.discard(i.userId, input.requestId)
          }
          return {
            connection: await this.enrich(i.userId, current),
            outcome: 'saved',
            requestId: input.requestId
          }
        })
      }
    } catch (e) {
      return meFailed(e)
    }
  }
  async getModelOptions(input: {
    id: string
    credentialVersion: number
  }): Promise<MeResult<ModelOption[]>> {
    try {
      return {
        ok: true,
        data: await this.auth.authenticated(async (i) => {
          const list = await this.getList(i.userId, i.token, i.signal),
            c = list.connections.find((v) => v.id === input.id)
          if (!c) throw new MeError('not_found')
          const apiKey = await this.vault.key(i.userId, c.id, input.credentialVersion)
          const models = await this.request(
            'me-connections',
            { action: 'models', ...input, apiKey },
            i.token,
            i.signal
          )
          if (!Array.isArray(models) || models.length > 10000) throw new MeError('unknown')
          return models.map((m) => {
            if (
              !m ||
              typeof m.id !== 'string' ||
              m.id.length > 200 ||
              typeof m.label !== 'string' ||
              m.label.length > 200
            )
              throw new MeError('unknown')
            return {
              connectionId: c.id,
              providerModelId: m.id,
              modelLabel: m.label,
              connectionName: c.displayName,
              status: c.status,
              localCredentialState: c.localCredentialState
            }
          })
        })
      }
    } catch (e) {
      return meFailed(e)
    }
  }
  requestAccountDeletion(input: {
    requestId: string
    password: string
    confirmed: true
    scopeVersion: 'shared-account-v1'
  }): Promise<MeResult<DeletionStatus>> {
    if (this.deletionRequest)
      return this.deletionRequest.id === input.requestId
        ? this.deletionRequest.promise
        : Promise.resolve(meFailed(new MeError('rate_limited', 30)))
    const promise = this.performAccountDeletion(input).finally(() => {
      this.deletionRequest = null
    })
    this.deletionRequest = { id: input.requestId, promise }
    return promise
  }
  private async performAccountDeletion(input: {
    requestId: string
    password: string
    confirmed: true
    scopeVersion: 'shared-account-v1'
  }): Promise<MeResult<DeletionStatus>> {
    try {
      const accepted = await this.auth.authenticated(async (i) => {
        const old = await this.vault.receipt()
        const receipt =
          old?.userId === i.userId
            ? old
            : {
                userId: i.userId,
                requestId: input.requestId,
                secret: randomBytes(32).toString('base64url'),
                createdAt: Date.now()
              }
        await this.vault.saveReceipt(receipt)
        const result = parseDeletion(
          await this.request(
            'delete-account',
            { ...input, requestId: receipt.requestId, receiptSecret: receipt.secret },
            i.token,
            i.signal
          )
        )
        // The pre-staged request ID and secret already suffice for recovery.
        // Failure to add the operation ID must not keep an accepted account signed in.
        await this.vault
          .saveReceipt({ ...receipt, operationId: result.operationId })
          .catch(() => {})
        return { userId: i.userId, result }
      })
      let localCleanup: 'done' | 'failed' = 'done'
      try {
        await this.vault.clearAccount(accepted.userId)
      } catch {
        localCleanup = 'failed'
      }
      if (this.auth.getState().profile?.id === accepted.userId) {
        const logout = await this.auth.signOut()
        if (!logout.ok) localCleanup = 'failed'
      }
      return { ok: true, data: { ...accepted.result, localCleanup } }
    } catch (e) {
      return meFailed(e)
    }
  }
  async getDeletionStatus(): Promise<MeResult<DeletionStatus | null>> {
    try {
      const receipt = await this.vault.receipt()
      if (!receipt) return { ok: true, data: null }
      const profile = this.auth.getState().profile
      if (profile && profile.id !== receipt.userId) return { ok: true, data: null }
      let response: unknown
      try {
        response = await this.request('account-deletion-status', {
          requestId: receipt.requestId,
          receiptSecret: receipt.secret
        })
      } catch (error) {
        if (error instanceof MeError && error.code === 'not_found') return { ok: true, data: null }
        throw error
      }
      const result = parseDeletion(response)
      const currentProfile = this.auth.getState().profile
      if (currentProfile && currentProfile.id !== receipt.userId) return { ok: true, data: null }
      let localCleanup: 'done' | 'failed' = 'done'
      if (result.phase !== 'expired') {
        try {
          await this.vault.clearAccount(receipt.userId)
        } catch {
          localCleanup = 'failed'
        }
        if (this.auth.getState().profile?.id === receipt.userId && !(await this.auth.signOut()).ok)
          localCleanup = 'failed'
      }
      return { ok: true, data: { ...result, localCleanup } }
    } catch (e) {
      return meFailed(e)
    }
  }
}
