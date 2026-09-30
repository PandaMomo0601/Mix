import type { AuthResult, AuthSnapshot, Credentials } from '../../shared/auth'
import { failure, LocalAuthError, mapAuthError } from '../../shared/auth-errors'
import { normalizeAccountProfile } from '../../shared/profile'
import type { AuthConfig } from './config'
import type { AuthRuntime } from './client'
import type { AccountProfile } from '../../shared/auth'
import type { MeResult, ProfileWriteResult } from '../../shared/me'
import { MeError, meFailed } from '../../shared/me-errors'
import { normalizeName, parseAvatar } from '../../shared/me-validation'
import { verifyDeletionPassword } from './reauthentication'

async function deadline<T>(promise: Promise<T>, ms = 16000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LocalAuthError('connection')), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class AuthService {
  private runtime: AuthRuntime | null = null
  private retiredForLogout: AuthRuntime | null = null
  private epoch = 0
  private busy = false
  private logoutPromise: Promise<AuthResult> | null = null
  private cleanupPromise: Promise<void> = Promise.resolve()
  private listeners = new Set<(state: AuthSnapshot) => void>()
  private authenticatedRequests = new Set<AbortController>()
  private removedListeners = new Set<(userId: string) => Promise<void>>()
  private profileQueue: Promise<unknown> = Promise.resolve()
  private state: AuthSnapshot

  constructor(
    private readonly config: AuthConfig | null,
    private readonly factory: () => Promise<AuthRuntime>,
    private readonly clearStorage: () => Promise<void>
  ) {
    this.state = {
      revision: 0,
      status: config ? 'starting' : 'configuration-error',
      profile: null,
      message: config ? null : failure('configuration').message,
      capabilities: {
        registration: Boolean(config?.confirmUrl),
        recovery: Boolean(config?.recoveryUrl),
        passwordHint: config?.passwordHint ?? '请设置不易猜测的密码。'
      }
    }
  }

  getState(): AuthSnapshot {
    return structuredClone(this.state)
  }

  subscribe(listener: (snapshot: AuthSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onAccountRemoved(listener: (userId: string) => Promise<void>): () => void {
    this.removedListeners.add(listener)
    return () => this.removedListeners.delete(listener)
  }
  private async confirmRemoval(
    runtime: AuthRuntime,
    userId: string,
    epoch: number,
    token: string
  ): Promise<void> {
    let status: unknown
    try {
      // getUser may already have cleared the SDK session. Keep the verified request's
      // token only for this read-only status check; it never leaves the main process.
      const response = await deadline(
        Promise.resolve(
          runtime.client.rpc('mix_account_status').setHeader('Authorization', 'Bearer ' + token)
        )
      )
      if (response.error || epoch !== this.epoch) return
      status = response.data
    } catch {
      return
    }
    if (status === 'deleting' || status === 'deleted') {
      try {
        await Promise.all([...this.removedListeners].map((listener) => listener(userId)))
      } catch {
        throw new LocalAuthError('storage')
      }
    }
  }

  private publish(
    status: AuthSnapshot['status'],
    message: string | null = null,
    profile: AuthSnapshot['profile'] = null
  ): void {
    this.state = { ...this.state, revision: this.state.revision + 1, status, message, profile }
    for (const listener of this.listeners) listener(this.getState())
  }

  private async ensureRuntime(epoch: number): Promise<AuthRuntime> {
    if (!this.config) throw new LocalAuthError('configuration')
    if (!this.runtime) {
      const runtime = await this.factory()
      if (epoch !== this.epoch) {
        runtime.storage.freeze()
        runtime.abortRequests()
        await runtime.client.auth.dispose()
        throw new LocalAuthError('cancelled')
      }
      this.runtime = runtime
      this.retiredForLogout = null
      runtime.client.auth.onAuthStateChange((event) => {
        // Never await an Auth API from the SDK's callback. Old lifetimes are ignored.
        if (['SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event)) {
          queueMicrotask(() => {
            if (epoch === this.epoch && !this.busy) void this.retry(true)
          })
        }
      })
    }
    return this.runtime
  }

  private retire(): AuthRuntime | null {
    const old = this.runtime
    this.runtime = null
    this.epoch++
    for (const controller of this.authenticatedRequests) controller.abort()
    this.authenticatedRequests.clear()
    if (old) {
      old.storage.freeze()
      old.abortRequests()
      void old.client.auth.dispose()
    }
    return old
  }

  private async verify(runtime: AuthRuntime, epoch: number): Promise<boolean> {
    const { data, error } = await runtime.client.auth.getSession()
    if (error) throw error
    if (epoch !== this.epoch) throw new LocalAuthError('cancelled')
    if (!data.session) {
      this.publish('signed-out')
      return false
    }
    const current = await runtime.client.auth.getUser()
    if (current.error) {
      if (mapAuthError(current.error).code === 'session-expired')
        await this.confirmRemoval(runtime, data.session.user.id, epoch, data.session.access_token)
      throw current.error
    }
    if (epoch !== this.epoch) throw new LocalAuthError('cancelled')
    const user = current.data.user
    if (!user || user.id !== data.session.user.id || !user.email || user.is_anonymous)
      throw new LocalAuthError('session-expired')
    this.publish('signed-in', null, normalizeAccountProfile(user))
    await runtime.client.auth.startAutoRefresh()
    return true
  }

  async retry(silent = false): Promise<void> {
    if (this.busy || !this.config) return
    this.busy = true
    const epoch = this.epoch
    if (!silent) this.publish('starting')
    try {
      const runtime = await this.ensureRuntime(epoch)
      await deadline(this.verify(runtime, epoch))
    } catch (error) {
      if (epoch === this.epoch) await this.handleFailure(error, true)
    } finally {
      if (epoch === this.epoch) this.busy = false
    }
  }

  private async handleFailure(error: unknown, restoring: boolean): Promise<void> {
    const mapped = mapAuthError(error)
    // Freeze on failed operations too: a timed-out response cannot commit later.
    const old = this.retire()
    this.retiredForLogout = old
    const cleanupEpoch = this.epoch
    if (mapped.code === 'session-expired') {
      this.cleanupPromise = old ? old.storage.clear() : this.clearStorage()
      try {
        await this.cleanupPromise
      } catch {
        if (cleanupEpoch === this.epoch) {
          this.publish('storage-error', failure('storage').message)
          this.busy = false
        }
        return
      }
      if (cleanupEpoch !== this.epoch) return
      this.publish('signed-out', mapped.message)
    } else if (mapped.code === 'storage') this.publish('storage-error', mapped.message)
    else if (mapped.code === 'configuration' && !this.config)
      this.publish('configuration-error', mapped.message)
    else if (restoring) this.publish('connection-error', mapped.message)
    this.busy = false
  }

  private async operation(
    action: (runtime: AuthRuntime, epoch: number) => Promise<AuthResult>
  ): Promise<AuthResult> {
    if (this.busy) return { ok: false, error: failure('busy') }
    if (this.state.status === 'signed-in') return { ok: false, error: failure('busy') }
    this.busy = true
    const epoch = this.epoch
    try {
      const runtime = await this.ensureRuntime(epoch)
      const result = await deadline(action(runtime, epoch))
      return epoch === this.epoch ? result : { ok: false, error: failure('cancelled') }
    } catch (error) {
      if (epoch !== this.epoch) return { ok: false, error: failure('cancelled') }
      const mapped = mapAuthError(error)
      await this.handleFailure(error, false)
      return { ok: false, error: mapped }
    } finally {
      if (epoch === this.epoch) this.busy = false
    }
  }

  signIn(credentials: Credentials): Promise<AuthResult> {
    return this.operation(async (runtime, epoch) => {
      const { data, error } = await runtime.client.auth.signInWithPassword(credentials)
      if (error) throw error
      if (!data.session) throw new LocalAuthError('unknown')
      const signedIn = await this.verify(runtime, epoch)
      if (!signedIn) throw new LocalAuthError('session-expired')
      return { ok: true, outcome: 'signed-in' }
    })
  }

  signUp(credentials: Credentials): Promise<AuthResult> {
    return this.operation(async (runtime, epoch) => {
      if (!this.config?.confirmUrl) throw new LocalAuthError('configuration')
      const { data, error } = await runtime.client.auth.signUp({
        ...credentials,
        options: { emailRedirectTo: this.config.confirmUrl }
      })
      if (error) throw error
      if (epoch !== this.epoch) throw new LocalAuthError('cancelled')
      if (data.session) {
        if (!(await this.verify(runtime, epoch))) throw new LocalAuthError('session-expired')
        return { ok: true, outcome: 'signed-in' }
      }
      return { ok: true, outcome: 'check-email' }
    })
  }

  resendConfirmation(email: string): Promise<AuthResult> {
    return this.operation(async (runtime) => {
      if (!this.config?.confirmUrl) throw new LocalAuthError('configuration')
      const { error } = await runtime.client.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: this.config.confirmUrl }
      })
      if (error) throw error
      return {
        ok: true,
        outcome: 'check-email',
        message: '已请求发送确认邮件，请检查收件箱和垃圾邮件。'
      }
    })
  }

  requestPasswordReset(email: string): Promise<AuthResult> {
    return this.operation(async (runtime) => {
      if (!this.config?.recoveryUrl) throw new LocalAuthError('configuration')
      const { error } = await runtime.client.auth.resetPasswordForEmail(email, {
        redirectTo: this.config.recoveryUrl
      })
      if (error) throw error
      return { ok: true, outcome: 'check-email' }
    })
  }

  signOut(): Promise<AuthResult> {
    if (this.logoutPromise) return this.logoutPromise
    this.logoutPromise = this.performSignOut().finally(() => {
      this.logoutPromise = null
    })
    return this.logoutPromise
  }

  // Main-only capability. Neither sessions nor this callback cross the preload boundary.
  async authenticated<T>(
    action: (
      identity: { userId: string; token: string; signal: AbortSignal; epoch: number },
      runtime: AuthRuntime
    ) => Promise<T>
  ): Promise<T> {
    if (this.state.status !== 'signed-in' || !this.state.profile || !this.runtime)
      throw new MeError('unauthorized')
    const epoch = this.epoch,
      runtime = this.runtime,
      userId = this.state.profile.id
    const controller = new AbortController()
    this.authenticatedRequests.add(controller)
    try {
      const { data, error } = await deadline(runtime.client.auth.getSession())
      if (error)
        throw new MeError(
          mapAuthError(error).code === 'session-expired' ? 'unauthorized' : 'provider_unavailable'
        )
      if (!data.session || data.session.user.id !== userId) throw new MeError('unauthorized')
      const current = await deadline(runtime.client.auth.getUser())
      if (current.error) {
        if (mapAuthError(current.error).code !== 'session-expired')
          throw new MeError('provider_unavailable')
        await this.confirmRemoval(runtime, userId, epoch, data.session.access_token)
        throw new MeError('unauthorized')
      }
      if (current.data.user?.id !== userId) throw new MeError('unauthorized')
      const gate = await deadline(Promise.resolve(runtime.client.rpc('mix_account_available')))
      if (gate.error)
        throw new MeError(gate.error.code === 'PGRST202' ? 'not_ready' : 'provider_unavailable')
      if (gate.data !== true) {
        await this.confirmRemoval(runtime, userId, epoch, data.session.access_token)
        throw new MeError('unauthorized')
      }
      if (epoch !== this.epoch || controller.signal.aborted) throw new MeError('cancelled')
      const result = await action(
        { userId, token: data.session.access_token, signal: controller.signal, epoch },
        runtime
      )
      if (epoch !== this.epoch || controller.signal.aborted) throw new MeError('cancelled')
      return result
    } catch (error) {
      if (epoch === this.epoch && error instanceof MeError && error.code === 'unauthorized')
        await this.handleFailure(new LocalAuthError('session-expired'), true)
      throw error
    } finally {
      this.authenticatedRequests.delete(controller)
    }
  }

  async refreshProfile(): Promise<MeResult<AccountProfile>> {
    try {
      const profile = await this.authenticated(async (_identity, runtime) => {
        const { data, error } = await deadline(runtime.client.auth.getUser())
        if (error)
          throw new MeError(
            mapAuthError(error).code === 'session-expired' ? 'unauthorized' : 'provider_unavailable'
          )
        if (!data.user) throw new MeError('unauthorized')
        return normalizeAccountProfile(data.user)
      })
      this.publish('signed-in', null, profile)
      return { ok: true, data: profile }
    } catch (error) {
      return meFailed(error)
    }
  }

  async reauthenticateForDeletion(password: string): Promise<MeResult<{ verified: true }>> {
    try {
      if (!password || Buffer.byteLength(password) > 4096) throw new MeError('invalid_input')
      if (!this.config || !this.state.profile?.email) throw new MeError('unauthorized')
      const config = this.config,
        email = this.state.profile.email
      await this.authenticated(async (identity) => {
        await verifyDeletionPassword(config, email, password, identity.userId, identity.signal)
      })
      return { ok: true, data: { verified: true } }
    } catch (error) {
      return meFailed(error)
    }
  }

  updateNickname(value: unknown): Promise<MeResult<ProfileWriteResult>> {
    try {
      return this.updateProfileField('nickname', normalizeName(value))
    } catch (error) {
      return Promise.resolve(meFailed(error))
    }
  }
  updateAvatar(value: unknown): Promise<MeResult<ProfileWriteResult>> {
    try {
      return this.updateProfileField('avatar', parseAvatar(value))
    } catch (error) {
      return Promise.resolve(meFailed(error))
    }
  }
  private updateProfileField(
    field: 'nickname' | 'avatar',
    value: string | NonNullable<AccountProfile['avatar']>
  ): Promise<MeResult<ProfileWriteResult>> {
    const queuedEpoch = this.epoch
    const work = this.profileQueue
      .catch(() => {})
      .then(async (): Promise<MeResult<ProfileWriteResult>> => {
        if (queuedEpoch !== this.epoch) return meFailed(new MeError('cancelled'))
        const old = this.state.profile
        if (!old) return meFailed(new MeError('unauthorized'))
        if (JSON.stringify(old[field]) === JSON.stringify(value))
          return { ok: true, data: { outcome: 'unchanged', profile: old } }
        try {
          const saved = await this.authenticated(async (_identity, runtime) => {
            // Only the changed field is sent; stale metadata must not overwrite another device.
            const { data, error } = await deadline(
              runtime.client.auth.updateUser({ data: { [field]: value } })
            )
            if (error || !data.user) throw error ?? new MeError('unknown')
            const profile = normalizeAccountProfile(data.user)
            try {
              const fresh = await deadline(runtime.client.auth.getUser())
              if (!fresh.error && fresh.data.user)
                return {
                  outcome: 'saved' as const,
                  profile: normalizeAccountProfile(fresh.data.user)
                }
            } catch {
              /* A confirmed write and a failed refresh are different outcomes. */
            }
            return { outcome: 'syncing' as const, profile }
          })
          this.publish('signed-in', null, saved.profile)
          return { ok: true, data: saved }
        } catch (error) {
          if (queuedEpoch !== this.epoch) return meFailed(new MeError('cancelled'))
          // A transport/persistence failure may occur after Auth committed. Read before retrying.
          const refreshed = await this.refreshProfile()
          if (refreshed.ok && JSON.stringify(refreshed.data[field]) === JSON.stringify(value))
            return { ok: true, data: { outcome: 'saved', profile: refreshed.data } }
          const mapped = mapAuthError(error)
          if (mapped.code === 'session-expired') {
            await this.handleFailure(error, true)
            return meFailed(new MeError('unauthorized'))
          }
          if (mapped.code === 'rate-limit') return meFailed(new MeError('rate_limited'))
          return meFailed(error instanceof MeError ? error : new MeError('unknown'))
        }
      })
    this.profileQueue = work
    return work
  }

  private async performSignOut(): Promise<AuthResult> {
    // This operation may interrupt verification/sign-in. It owns a new lifetime.
    const old = this.retire() ?? this.retiredForLogout
    this.retiredForLogout = null
    const epoch = this.epoch
    this.busy = true
    this.publish('starting')
    let revoked = false
    try {
      await this.cleanupPromise.catch(() => {})
      if (old) {
        try {
          const { error } = await deadline(old.client.auth.signOut({ scope: 'local' }), 5000)
          revoked = !error
        } catch {
          revoked = false
        } finally {
          old.abortRequests()
          await old.client.auth.dispose()
        }
        await old.storage.clear()
      } else await this.clearStorage()
      if (epoch !== this.epoch) return { ok: false, error: failure('cancelled') }
      const message = revoked ? '已退出当前设备。' : '本机已退出，未能确认远端会话撤销。'
      this.publish('signed-out', message)
      return { ok: true, outcome: 'signed-out', message }
    } catch {
      this.publish('storage-error', failure('storage').message)
      return { ok: false, error: failure('storage') }
    } finally {
      if (epoch === this.epoch) this.busy = false
    }
  }

  dispose(): void {
    this.retire()
    this.listeners.clear()
  }
}
