import type { MeErrorCode, MeFailure, MeResult } from './me'

const messages: Record<MeErrorCode, string> = {
  invalid_input: '请检查填写内容。',
  duplicate_key: '这个 Key 已经接入，不能重复添加。',
  duplicate_name: '接入名称已存在，请换一个名称。',
  limit_reached: '接入数量已达到上限，请先删除不用的接入。',
  rate_limited: '操作过于频繁，请稍后重试。',
  invalid_key: 'Key 无效或已被撤销，请检查后替换。',
  permission_denied: '这个 Key 没有所需的模型权限。',
  quota_unavailable: '这个 Key 当前没有可用额度。',
  provider_unavailable: '暂时无法连接服务商，请稍后重试。',
  validation_timeout: '验证超时，尚未确认结果。',
  unauthorized: '登录已失效，请重新登录。',
  not_found: '接入已不存在，请刷新列表。',
  conflict: '接入已在其他地方更新，请刷新后再操作。',
  idempotency_conflict: '操作内容已变化，请重新提交。',
  storage_error: '暂时无法保存，请稍后重试。',
  local_key_missing: '这台设备还没有这个 Key，请在原接入补填。',
  local_key_locked: '本机安全存储暂时不可用，请解锁后重试。',
  local_storage_error: '本机 Key 保存失败，请重试恢复或在原接入补填。',
  credential_stale: '这个接入已更换 Key，请补填最新 Key。',
  credential_mismatch: '填入的 Key 与这个接入不一致。',
  cancelled: '操作已结束，请核对当前状态。',
  unknown: '尚未确认操作结果，请先核对，再决定是否重试。',
  not_ready: '这项服务暂未开放，请稍后重试。',
  probe_confirmation_required: '继续验证前，请确认本次探测说明。',
  probe_unknown: '本次模型探测结果不明，可能已产生费用。请先核对，不会自动再次探测。',
  reauthentication_failed: '密码核验未通过，账号尚未受理注销。请检查当前账号密码。'
}

export class MeError extends Error {
  constructor(
    readonly code: MeErrorCode,
    readonly retryAfter?: number
  ) {
    super(messages[code])
  }
}
export function meFailure(code: MeErrorCode, retryAfter?: number): MeFailure {
  return { code, message: messages[code], ...(retryAfter ? { retryAfter } : {}) }
}
export function meFailed<T = never>(error: unknown): MeResult<T> {
  return {
    ok: false,
    error: error instanceof MeError ? meFailure(error.code, error.retryAfter) : meFailure('unknown')
  }
}
export function isMeErrorCode(code: unknown): code is MeErrorCode {
  return typeof code === 'string' && Object.hasOwn(messages, code)
}
