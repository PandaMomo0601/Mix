import type { AuthResult, AuthSnapshot, Credentials } from '../../shared/auth'
import { failure, LocalAuthError, mapAuthError } from '../../shared/auth-errors'
import { normalizeAccountProfile } from '../../shared/profile'
import type { AuthConfig } from './config'
import type { AuthRuntime } from './client'

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
            if (epoch === this.epoch && !this.busy) void this.retry()
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
    if (current.error) throw current.error
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
