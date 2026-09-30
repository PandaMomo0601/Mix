import type { AccountProfile } from './auth'

export type ProviderId = 'deepseek' | 'openai' | 'openrouter'
export type VerificationStatus = 'verified' | 'invalid' | 'unavailable' | 'unknown'
export type LocalCredentialState = 'ready' | 'missing' | 'locked' | 'stale' | 'error'

export interface ConnectionSummary {
  id: string
  providerId: ProviderId
  displayName: string
  keyHint: string
  status: VerificationStatus
  lastVerifiedAt: string | null
  displayOrder: number
  revision: number
  credentialVersion: number
  createdAt: string
  updatedAt: string
  localCredentialState: LocalCredentialState
}

export interface ConnectionList {
  connections: ConnectionSummary[]
  listRevision: number
  providers: { id: ProviderId; label: string; enabled: boolean; probe: ProbeConfig | null }[]
}

export interface ProbeConfig {
  version: string
  model: string
  paid: boolean
  description: string
}

export type MeErrorCode =
  | 'invalid_input'
  | 'duplicate_key'
  | 'duplicate_name'
  | 'limit_reached'
  | 'rate_limited'
  | 'invalid_key'
  | 'permission_denied'
  | 'quota_unavailable'
  | 'provider_unavailable'
  | 'validation_timeout'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'storage_error'
  | 'local_key_missing'
  | 'local_key_locked'
  | 'local_storage_error'
  | 'credential_stale'
  | 'credential_mismatch'
  | 'cancelled'
  | 'unknown'
  | 'not_ready'
  | 'probe_confirmation_required'
  | 'probe_unknown'
  | 'reauthentication_failed'

export interface MeFailure {
  code: MeErrorCode
  message: string
  retryAfter?: number
}
export type MeResult<T> = { ok: true; data: T } | { ok: false; error: MeFailure }
export interface ProfileWriteResult {
  outcome: 'saved' | 'unchanged' | 'syncing'
  profile: AccountProfile
}
export interface ConnectionWriteResult {
  connection: ConnectionSummary
  outcome: 'saved' | 'partial'
  requestId: string
}
export interface OperationInput {
  requestId: string
}
export interface ConnectionInput extends OperationInput {
  id: string
  expectedRevision: number
}
export interface KeyInput {
  apiKey: string
  confirmedProbeVersion?: string
}
export interface CreateConnectionInput extends OperationInput, KeyInput {
  providerId: ProviderId
  displayName?: string
}
export interface CredentialInput extends ConnectionInput, KeyInput {
  credentialVersion: number
}
export interface ModelOption {
  connectionId: string
  providerModelId: string
  modelLabel: string
  connectionName: string
  status: VerificationStatus
  localCredentialState: LocalCredentialState
}
export interface DeletionStatus {
  operationId: string
  phase: 'processing' | 'completed' | 'needs_attention' | 'expired'
  nextPollAfter: number
  localCleanup?: 'done' | 'failed'
}

export interface MeBridge {
  listConnections: () => Promise<MeResult<ConnectionList>>
  createVerifiedConnection: (
    input: CreateConnectionInput
  ) => Promise<MeResult<ConnectionWriteResult>>
  updateConnection: (
    input: ConnectionInput & ({ displayName: string } | KeyInput)
  ) => Promise<MeResult<ConnectionWriteResult>>
  revalidateConnection: (
    input: ConnectionInput & { credentialVersion: number; confirmedProbeVersion?: string }
  ) => Promise<MeResult<ConnectionWriteResult>>
  attachLocalCredential: (input: CredentialInput) => Promise<MeResult<ConnectionWriteResult>>
  deleteConnection: (
    input: ConnectionInput
  ) => Promise<MeResult<{ localCleanup: 'done' | 'failed' }>>
  reorderConnections: (
    input: OperationInput & { ids: string[]; listRevision: number }
  ) => Promise<MeResult<ConnectionList>>
  recoverOperation: (input: OperationInput) => Promise<MeResult<ConnectionWriteResult>>
  getModelOptions: (input: {
    id: string
    credentialVersion: number
  }) => Promise<MeResult<ModelOption[]>>
  updateAvatar: (
    avatar: NonNullable<AccountProfile['avatar']>
  ) => Promise<MeResult<ProfileWriteResult>>
  updateNickname: (nickname: string) => Promise<MeResult<ProfileWriteResult>>
  refreshProfile: () => Promise<MeResult<AccountProfile>>
  reauthenticateForDeletion: (password: string) => Promise<MeResult<{ verified: true }>>
  requestAccountDeletion: (
    input: OperationInput & { password: string; confirmed: true; scopeVersion: 'shared-account-v1' }
  ) => Promise<MeResult<DeletionStatus>>
  getDeletionStatus: () => Promise<MeResult<DeletionStatus | null>>
}

export const ME_CHANNELS = {
  listConnections: 'me:list',
  createVerifiedConnection: 'me:create',
  updateConnection: 'me:update',
  revalidateConnection: 'me:revalidate',
  attachLocalCredential: 'me:attach',
  deleteConnection: 'me:delete',
  reorderConnections: 'me:reorder',
  recoverOperation: 'me:recover',
  getModelOptions: 'me:models',
  updateAvatar: 'me:avatar',
  updateNickname: 'me:nickname',
  refreshProfile: 'me:profile',
  reauthenticateForDeletion: 'me:reauthenticate-deletion',
  requestAccountDeletion: 'me:delete-account',
  getDeletionStatus: 'me:deletion-status'
} as const
