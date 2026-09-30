import type {
  ConnectionSummary,
  ConnectionList,
  DeletionStatus,
  ProviderId,
  ProbeConfig
} from '../../shared/me'
import { MeError } from '../../shared/me-errors'
import { UUID, positiveInteger } from '../../shared/me-validation'

const bad = (): never => {
  throw new MeError('unknown')
}
function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad()
}
function text(v: unknown, max = 1000): string {
  return typeof v === 'string' && v.length <= max ? v : bad()
}
function date(v: unknown): string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : bad()
}
function id(v: unknown): string {
  return typeof v === 'string' && UUID.test(v) ? v : bad()
}
export function parseSummary(value: unknown): ConnectionSummary {
  const v = record(value)
  if (
    !['deepseek', 'openai', 'openrouter'].includes(String(v.providerId)) ||
    !['verified', 'invalid', 'unavailable', 'unknown'].includes(String(v.status)) ||
    !Number.isSafeInteger(v.displayOrder) ||
    (v.displayOrder as number) < 0
  )
    bad()
  const hint = text(v.keyHint, 20)
  if (!/^•{4}(?: [^\s]{4})?$/.test(hint)) bad()
  return {
    id: id(v.id),
    providerId: v.providerId as ProviderId,
    displayName: text(v.displayName, 1000),
    keyHint: hint,
    status: v.status as ConnectionSummary['status'],
    lastVerifiedAt: v.lastVerifiedAt === null ? null : date(v.lastVerifiedAt),
    displayOrder: v.displayOrder as number,
    revision: positiveInteger(v.revision),
    credentialVersion: positiveInteger(v.credentialVersion),
    createdAt: date(v.createdAt),
    updatedAt: date(v.updatedAt),
    localCredentialState: 'missing'
  }
}
export function parseList(value: unknown): ConnectionList {
  const v = record(value)
  if (
    !Array.isArray(v.connections) ||
    v.connections.length > 20 ||
    !Array.isArray(v.providers) ||
    v.providers.length > 3 ||
    !Number.isSafeInteger(v.listRevision) ||
    (v.listRevision as number) < 0
  )
    bad()
  const connections = (v.connections as unknown[]).map(parseSummary)
  if (new Set(connections.map((c) => c.id)).size !== connections.length) bad()
  const providers = (v.providers as unknown[]).map((p) => {
    const r = record(p)
    if (
      !['deepseek', 'openai', 'openrouter'].includes(String(r.id)) ||
      typeof r.enabled !== 'boolean'
    )
      bad()
    let probe: ProbeConfig | null = null
    if (r.probe) {
      const q = record(r.probe)
      if (typeof q.paid !== 'boolean') bad()
      probe = {
        version: text(q.version, 80),
        model: text(q.model, 200),
        paid: q.paid as boolean,
        description: text(q.description, 1000)
      }
    }
    return {
      id: r.id as ProviderId,
      label: text(r.label, 40),
      enabled: r.enabled as boolean,
      probe
    }
  })
  return { connections, listRevision: v.listRevision as number, providers }
}
export function parseDeletion(value: unknown): DeletionStatus {
  const v = record(value)
  if (!['processing', 'completed', 'needs_attention', 'expired'].includes(String(v.phase))) bad()
  return {
    operationId: id(v.operationId),
    phase: v.phase as DeletionStatus['phase'],
    nextPollAfter:
      typeof v.nextPollAfter === 'number' ? Math.max(5, Math.min(3600, v.nextPollAfter)) : 15
  }
}
