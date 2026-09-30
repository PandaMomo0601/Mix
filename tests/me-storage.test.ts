import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore } from '../src/main/me/credential-store'
import type { Cipher } from '../src/main/auth/secure-storage'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function setup(): Promise<{
  root: string
  cipher: Cipher
  store: CredentialStore
  slot: () => Promise<string>
}> {
  const root = await mkdtemp(join(tmpdir(), 'mix-vault-unit-'))
  roots.push(root)
  const secret = randomBytes(32)
  const cipher: Cipher = {
    available: vi.fn(async () => true),
    encrypt: vi.fn(async (text) => {
      const iv = randomBytes(12),
        c = createCipheriv('aes-256-gcm', secret, iv)
      return Buffer.concat([iv, c.update(text), c.final(), c.getAuthTag()])
    }),
    decrypt: vi.fn(async (data) => {
      const d = createDecipheriv('aes-256-gcm', secret, data.subarray(0, 12))
      d.setAuthTag(data.subarray(-16))
      return {
        result: Buffer.concat([d.update(data.subarray(12, -16)), d.final()]).toString(),
        shouldReEncrypt: false
      }
    })
  }
  const store = new CredentialStore(root, 'project-A', cipher)
  async function slot(): Promise<string> {
    const dir = (await readdir(root)).find((s) => /^[a-f0-9]{64}$/.test(s))!
    const base = join(root, dir)
    return join(
      base,
      (await readdir(base)).find((s) => /^[a-f0-9]{64}\.enc$/.test(s))!
    )
  }
  return { root, cipher, store, slot }
}
describe('personal credential persistence', () => {
  it('encrypts full Keys and isolates accounts and projects', async () => {
    const { root, cipher, store, slot } = await setup()
    await store.save('A', 'connection', 1, ' Synthetic-Secret-Only ')
    const path = await slot(),
      data = await readFile(path)
    expect(data.includes('Synthetic-Secret-Only')).toBe(false)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700)
    expect(await store.key('A', 'connection', 1)).toBe('Synthetic-Secret-Only')
    expect(await store.state('B', 'connection', 1)).toBe('missing')
    expect(await new CredentialStore(root, 'project-B', cipher).state('A', 'connection', 1)).toBe(
      'missing'
    )
  })
  it('distinguishes absent, stale, locked and corrupt credentials without erasing them', async () => {
    const { store, cipher, slot } = await setup()
    expect(await store.state('A', 'connection', 1)).toBe('missing')
    await store.save('A', 'connection', 2, 'Synthetic-Key')
    expect(await store.state('A', 'connection', 1)).toBe('stale')
    await expect(store.key('A', 'connection', 1)).rejects.toMatchObject({
      code: 'credential_stale'
    })
    vi.mocked(cipher.available).mockResolvedValueOnce(false)
    expect(await store.state('A', 'connection', 2)).toBe('locked')
    expect(await store.key('A', 'connection', 2)).toBe('Synthetic-Key')
    await writeFile(await slot(), await cipher.encrypt('{broken'))
    expect(await store.state('A', 'connection', 2)).toBe('error')
  })
  it('bounds recovery candidates and rejects changing the Key under one request ID', async () => {
    const { store } = await setup(),
      createdAt = Date.now()
    await store.stage('A', { requestId: 'one', apiKey: 'Synthetic-one', createdAt })
    await store.stage('A', { requestId: 'one', apiKey: ' Synthetic-one ', createdAt })
    await expect(
      store.stage('A', { requestId: 'one', apiKey: 'Synthetic-other', createdAt })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await store.stage('A', { requestId: 'two', apiKey: 'Synthetic-two', createdAt })
    await expect(
      store.stage('A', { requestId: 'three', apiKey: 'Synthetic-three', createdAt })
    ).rejects.toMatchObject({ code: 'rate_limited' })
    vi.spyOn(Date, 'now').mockReturnValue(createdAt + 86400001)
    expect(await store.candidate('A', 'one')).toBeNull()
    await store.stage('A', { requestId: 'three', apiKey: 'Synthetic-three', createdAt: Date.now() })
    expect((await store.candidate('A', 'three'))?.apiKey).toBe('Synthetic-three')
  })
  it('reconciles only confirmed connection IDs and preserves recovery and another account', async () => {
    const { store } = await setup()
    await store.save('A', 'keep', 1, 'Synthetic-keep')
    await store.save('A', 'remove', 1, 'Synthetic-remove')
    await store.save('B', 'other', 1, 'Synthetic-other')
    await store.stage('A', {
      requestId: 'pending',
      apiKey: 'Synthetic-pending',
      createdAt: Date.now()
    })
    await store.reconcile('A', ['keep'])
    expect(await store.state('A', 'remove', 1)).toBe('missing')
    expect(await store.state('A', 'keep', 1)).toBe('ready')
    expect(await store.state('B', 'other', 1)).toBe('ready')
    expect(await store.candidate('A', 'pending')).not.toBeNull()
    await store.saveReceipt({
      userId: 'A',
      requestId: 'pending',
      secret: 'Synthetic-receipt',
      createdAt: Date.now()
    })
    await store.clearAccount('A')
    expect(await store.state('A', 'keep', 1)).toBe('missing')
    expect(await store.state('B', 'other', 1)).toBe('ready')
    expect((await store.receipt())?.userId).toBe('A')
  })
  it('serializes encryption rotation with a newer Key replacement', async () => {
    const { store, cipher } = await setup()
    await store.save('A', 'connection', 1, 'Synthetic-old')
    const decrypt = cipher.decrypt
    let release!: () => void
    vi.mocked(cipher.decrypt).mockImplementationOnce(async (value) => {
      const result = await decrypt(value)
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { ...result, shouldReEncrypt: true }
    })
    const read = store.state('A', 'connection', 1)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const replace = store.save('A', 'connection', 2, 'Synthetic-new')
    release()
    expect(await read).toBe('ready')
    await replace
    expect(await store.key('A', 'connection', 2)).toBe('Synthetic-new')
    expect(await store.state('A', 'connection', 1)).toBe('stale')
  })
})
