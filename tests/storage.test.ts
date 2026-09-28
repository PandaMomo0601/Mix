import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecureSessionStorage, type Cipher } from '../src/main/auth/secure-storage'

// Deterministic cipher fixture. Real OS encryption is verified separately in Electron.
const cipher: Cipher = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(`fixture:${Buffer.from(value).toString('base64')}`),
  decrypt: async (value) => {
    if (!value.toString().startsWith('fixture:')) throw Error('Corrupt fixture')
    return {
      result: Buffer.from(value.toString().slice(8), 'base64').toString(),
      shouldReEncrypt: false
    }
  }
}
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mix-auth-unit-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('session persistence', () => {
  it('persists, restores, clears and rejects writes from a retired lifetime', async () => {
    const path = join(dir, 'session.enc')
    const first = new SecureSessionStorage(path, cipher)
    await first.setItem('session', 'fake-token')
    expect((await readFile(path)).toString()).not.toContain('fake-token')
    const second = new SecureSessionStorage(path, cipher)
    await second.load()
    expect(second.getItem('session')).toBe('fake-token')
    await first.clear()
    await first.setItem('session', 'late-token')
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('freezes a pending encrypted write before clearing', async () => {
    let release!: () => void
    let started!: () => void
    const inProgress = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const storage = new SecureSessionStorage(join(dir, 'session.enc'), {
      ...cipher,
      encrypt: async (value) => {
        started()
        await gate
        return cipher.encrypt(value)
      }
    })
    const writing = storage.setItem('session', 'late-token')
    await inProgress
    const clearing = storage.clear()
    release()
    await Promise.all([writing, clearing])
    await expect(readFile(join(dir, 'session.enc'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not downgrade to plaintext or erase an unreadable existing session', async () => {
    const path = join(dir, 'session.enc')
    await writeFile(path, 'damaged-ciphertext')
    const unavailable = new SecureSessionStorage(path, { ...cipher, available: async () => false })
    await expect(unavailable.load()).rejects.toMatchObject({ kind: 'storage' })
    await expect(unavailable.setItem('session', 'sensitive')).rejects.toMatchObject({
      kind: 'storage'
    })
    expect(await readFile(path, 'utf8')).toBe('damaged-ciphertext')
    const corrupt = new SecureSessionStorage(path, cipher)
    await expect(corrupt.load()).rejects.toMatchObject({ kind: 'storage' })
    expect(await readFile(path, 'utf8')).toBe('damaged-ciphertext')
  })
  it('reports deletion failure instead of claiming cleanup', async () => {
    const path = join(dir, 'session.enc')
    await mkdir(path)
    await writeFile(join(path, 'keep'), 'test')
    await expect(new SecureSessionStorage(path, cipher).clear()).rejects.toMatchObject({
      kind: 'storage'
    })
  })
})
