import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Cipher } from '../auth/secure-storage'
import type { LocalCredentialState } from '../../shared/me'
import { MeError } from '../../shared/me-errors'
import { normalizeKey } from '../../shared/me-validation'

export interface Candidate {
  requestId: string
  apiKey: string
  createdAt: number
}
export interface DeletionReceipt {
  userId: string
  requestId: string
  secret: string
  operationId?: string
  createdAt: number
}
interface Credential {
  schema: 1
  project: string
  userId: string
  id: string
  credentialVersion: number
  apiKey: string
}

export class CredentialStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly root: string,
    private readonly project: string,
    private readonly cipher: Cipher
  ) {}
  private accountPath(userId: string): string {
    return join(
      this.root,
      createHash('sha256')
        .update(this.project + '\0' + userId)
        .digest('hex')
    )
  }
  private slot(userId: string, id: string): string {
    return join(this.accountPath(userId), createHash('sha256').update(id).digest('hex') + '.enc')
  }
  private candidatePath(userId: string): string {
    return join(this.accountPath(userId), 'candidates.enc')
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(action)
    this.queue = next
    return next
  }
  private async read(path: string): Promise<unknown | null> {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
        throw new MeError('local_storage_error')
      if (!(await this.cipher.available())) throw new MeError('local_key_locked')
      const encrypted = await readFile(path)
      let decrypted: Awaited<ReturnType<Cipher['decrypt']>>
      try {
        decrypted = await this.cipher.decrypt(encrypted)
      } catch {
        throw new MeError('local_key_locked')
      }
      let value: unknown
      try {
        value = JSON.parse(decrypted.result)
      } catch {
        throw new MeError('local_storage_error')
      }
      // Every read runs in the same queue as saves. Rotation cannot restore an older Key
      // over a replacement committed while decrypting.
      if (decrypted.shouldReEncrypt) await this.write(path, value)
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error instanceof MeError ? error : new MeError('local_storage_error')
    }
  }
  private async write(path: string, value: unknown): Promise<void> {
    let temp: string | undefined
    try {
      if (!(await this.cipher.available())) throw new MeError('local_key_locked')
      const raw = JSON.stringify(value)
      if (Buffer.byteLength(raw) > 32768) throw new MeError('local_storage_error')
      const encrypted = await this.cipher.encrypt(raw)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      temp = path + '.' + randomUUID() + '.tmp'
      await writeFile(temp, encrypted, { mode: 0o600, flag: 'wx' })
      await rename(temp, path)
    } catch (error) {
      throw error instanceof MeError ? error : new MeError('local_storage_error')
    } finally {
      if (temp) await rm(temp, { force: true }).catch(() => {})
    }
  }
  private async credential(userId: string, id: string): Promise<Credential | null> {
    const value = (await this.read(this.slot(userId, id))) as Credential | null
    if (!value) return null
    if (
      value.schema !== 1 ||
      value.project !== this.project ||
      value.userId !== userId ||
      value.id !== id ||
      !Number.isSafeInteger(value.credentialVersion) ||
      value.credentialVersion < 1
    )
      throw new MeError('local_storage_error')
    try {
      normalizeKey(value.apiKey)
    } catch {
      throw new MeError('local_storage_error')
    }
    return value
  }
  state(userId: string, id: string, version: number): Promise<LocalCredentialState> {
    return this.serial(async () => {
      try {
        const value = await this.credential(userId, id)
        return !value ? 'missing' : value.credentialVersion !== version ? 'stale' : 'ready'
      } catch (error) {
        return error instanceof MeError && error.code === 'local_key_locked' ? 'locked' : 'error'
      }
    })
  }
  key(userId: string, id: string, version: number): Promise<string> {
    return this.serial(async () => {
      const value = await this.credential(userId, id)
      if (!value) throw new MeError('local_key_missing')
      if (value.credentialVersion !== version) throw new MeError('credential_stale')
      return value.apiKey
    })
  }
  save(userId: string, id: string, version: number, key: string): Promise<void> {
    return this.serial(() =>
      this.write(this.slot(userId, id), {
        schema: 1,
        project: this.project,
        userId,
        id,
        credentialVersion: version,
        apiKey: normalizeKey(key)
      })
    )
  }
  private async candidates(userId: string): Promise<Candidate[]> {
    const stored = (await this.read(this.candidatePath(userId))) as {
      project: string
      userId: string
      values: Candidate[]
    } | null
    if (!stored) return []
    if (
      stored.project !== this.project ||
      stored.userId !== userId ||
      !Array.isArray(stored.values) ||
      stored.values.length > 2
    )
      throw new MeError('local_storage_error')
    return stored.values.filter(
      (v) =>
        Number.isFinite(v.createdAt) &&
        Date.now() - v.createdAt < 86400000 &&
        typeof v.requestId === 'string' &&
        typeof v.apiKey === 'string'
    )
  }
  stage(userId: string, candidate: Candidate): Promise<void> {
    return this.serial(async () => {
      const current = await this.candidates(userId)
      const old = current.find((v) => v.requestId === candidate.requestId)
      if (old && old.apiKey !== normalizeKey(candidate.apiKey))
        throw new MeError('idempotency_conflict')
      const values = current.filter((v) => v.requestId !== candidate.requestId)
      if (values.length >= 2) throw new MeError('rate_limited', 30)
      values.push({ ...candidate, apiKey: normalizeKey(candidate.apiKey) })
      await this.write(this.candidatePath(userId), { project: this.project, userId, values })
    })
  }
  candidate(userId: string, requestId: string): Promise<Candidate | null> {
    return this.serial(
      async () => (await this.candidates(userId)).find((v) => v.requestId === requestId) ?? null
    )
  }
  discard(userId: string, requestId: string): Promise<void> {
    return this.serial(async () => {
      const values = (await this.candidates(userId)).filter((v) => v.requestId !== requestId)
      if (!values.length) await rm(this.candidatePath(userId), { force: true })
      else await this.write(this.candidatePath(userId), { project: this.project, userId, values })
    })
  }
  discardCandidates(userId: string): Promise<void> {
    return this.serial(() => rm(this.candidatePath(userId), { force: true }))
  }
  remove(userId: string, id: string): Promise<void> {
    return this.serial(() => rm(this.slot(userId, id), { force: true }))
  }
  clearAccount(userId: string): Promise<void> {
    return this.serial(() => rm(this.accountPath(userId), { recursive: true, force: true }))
  }
  reconcile(userId: string, ids: string[]): Promise<void> {
    return this.serial(async () => {
      const allowed = new Set(ids.map((id) => this.slot(userId, id).split('/').pop()))
      let files: string[]
      try {
        files = await readdir(this.accountPath(userId))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw new MeError('local_storage_error')
      }
      for (const file of files)
        if (/^[a-f0-9]{64}\.enc$/.test(file) && !allowed.has(file))
          await rm(join(this.accountPath(userId), file), { force: true })
    })
  }
  receipt(): Promise<DeletionReceipt | null> {
    return this.serial(() => this.readReceipt())
  }
  private async readReceipt(): Promise<DeletionReceipt | null> {
    const v = (await this.read(join(this.root, 'deletion-receipt.enc'))) as
      (DeletionReceipt & { project: string }) | null
    if (!v) return null
    if (
      v.project !== this.project ||
      typeof v.userId !== 'string' ||
      typeof v.secret !== 'string' ||
      typeof v.requestId !== 'string' ||
      !Number.isFinite(v.createdAt)
    )
      throw new MeError('local_storage_error')
    return v
  }
  saveReceipt(value: DeletionReceipt): Promise<void> {
    return this.serial(() =>
      this.write(join(this.root, 'deletion-receipt.enc'), { ...value, project: this.project })
    )
  }
}
