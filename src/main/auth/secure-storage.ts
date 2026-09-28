import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { LocalAuthError } from '../../shared/auth-errors'

export interface Cipher {
  available: () => Promise<boolean>
  encrypt: (value: string) => Promise<Buffer>
  decrypt: (value: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>
}

// One store per client lifetime. A retired SDK must never write into its replacement.
const queues = new Map<string, Promise<void>>()

export class SecureSessionStorage {
  private values: Record<string, string> = Object.create(null)
  private writable = true

  constructor(
    private readonly path: string,
    private readonly cipher: Cipher
  ) {}

  async load(): Promise<void> {
    try {
      await queues.get(this.path)?.catch(() => {})
      let encrypted: Buffer
      try {
        encrypted = await readFile(this.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (encrypted.length > 2 * 1024 * 1024 || !(await this.cipher.available()))
        throw new LocalAuthError('storage')
      const { result, shouldReEncrypt } = await this.cipher.decrypt(encrypted)
      const data: unknown = JSON.parse(result)
      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        Object.values(data).some((value) => typeof value !== 'string')
      )
        throw new LocalAuthError('storage')
      this.values = Object.assign(Object.create(null), data)
      if (shouldReEncrypt) await this.persist()
    } catch {
      throw new LocalAuthError('storage')
    }
  }

  getItem(key: string): string | null {
    return this.values[key] ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    if (!this.writable) return
    this.values[key] = value
    await this.persist()
  }

  async removeItem(key: string): Promise<void> {
    if (!this.writable) return
    delete this.values[key]
    await this.persist()
  }

  freeze(): void {
    this.writable = false
  }

  private serial(action: () => Promise<void>): Promise<void> {
    const next = (queues.get(this.path) ?? Promise.resolve()).catch(() => {}).then(action)
    queues.set(this.path, next)
    return next
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.values)
    return this.serial(async () => {
      if (!this.writable) return
      try {
        if (snapshot.length > 1024 * 1024 || !(await this.cipher.available()))
          throw new LocalAuthError('storage')
        const encrypted = await this.cipher.encrypt(snapshot)
        if (!this.writable) return
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(this.path + '.tmp', encrypted, { mode: 0o600 })
        // clear() is in this same queue, so it always runs after a preceding rename.
        if (this.writable) await rename(this.path + '.tmp', this.path)
      } catch {
        throw new LocalAuthError('storage')
      }
    })
  }

  async clear(): Promise<void> {
    this.freeze()
    await this.serial(async () => {
      try {
        await rm(this.path, { force: true })
        await rm(this.path + '.tmp', { force: true })
        this.values = Object.create(null)
      } catch {
        throw new LocalAuthError('storage')
      }
    })
  }
}
