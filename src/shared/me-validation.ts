import type { CreateConnectionInput, ConnectionInput, CredentialInput, ProviderId } from './me'
import { avatarFor } from './profile'
import { MeError } from './me-errors'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new MeError('invalid_input')
  return value as Record<string, unknown>
}
export function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value))
    throw new MeError('invalid_input')
  const name = value.trim()
  if (Array.from(name).length < 1 || Array.from(name).length > 40)
    throw new MeError('invalid_input')
  return name
}
export function normalizeKey(value: unknown): string {
  if (typeof value !== 'string') throw new MeError('invalid_input')
  const key = value.trim()
  if (!key || /[\s\p{Cc}]/u.test(key) || new TextEncoder().encode(key).length > 4096)
    throw new MeError('invalid_input')
  return key
}
export function parseAvatar(value: unknown): { emoji: string; bg: string } {
  const v = object(value, ['emoji', 'bg'])
  const avatar = typeof v.emoji === 'string' ? avatarFor(v.emoji) : null
  if (!avatar || v.bg !== avatar.bg) throw new MeError('invalid_input')
  return avatar
}
export function requestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new MeError('invalid_input')
  return value
}
export function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new MeError('invalid_input')
  return value
}
export function parseConnectionInput(value: Record<string, unknown>): ConnectionInput {
  return {
    id: requestId(value.id),
    requestId: requestId(value.requestId),
    expectedRevision: positiveInteger(value.expectedRevision)
  }
}
export function parseProbe(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(value))
    throw new MeError('invalid_input')
  return value
}
export function parseCreate(value: unknown): CreateConnectionInput {
  const v = object(value, [
    'providerId',
    'displayName',
    'apiKey',
    'requestId',
    'confirmedProbeVersion'
  ])
  if (!['deepseek', 'openai', 'openrouter'].includes(String(v.providerId)))
    throw new MeError('invalid_input')
  return {
    providerId: v.providerId as ProviderId,
    requestId: requestId(v.requestId),
    apiKey: normalizeKey(v.apiKey),
    ...(v.displayName !== undefined ? { displayName: normalizeName(v.displayName) } : {}),
    confirmedProbeVersion: parseProbe(v.confirmedProbeVersion)
  }
}
export function parseCredential(value: unknown): CredentialInput {
  const v = object(value, [
    'id',
    'requestId',
    'expectedRevision',
    'credentialVersion',
    'apiKey',
    'confirmedProbeVersion'
  ])
  return {
    ...parseConnectionInput(v),
    credentialVersion: positiveInteger(v.credentialVersion),
    apiKey: normalizeKey(v.apiKey),
    confirmedProbeVersion: parseProbe(v.confirmedProbeVersion)
  }
}
