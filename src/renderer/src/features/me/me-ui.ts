export const providerLabels = { deepseek: 'DeepSeek', openai: 'OpenAI', openrouter: 'OpenRouter' }
export const localLabels = {
  ready: '本机可用',
  missing: '本机待补填',
  locked: '安全存储未解锁',
  stale: '需补填最新 Key',
  error: '本机存储异常'
}
export type KeyMode =
  'add' | 'manage' | 'rename' | 'replace' | 'fill' | 'revalidate' | 'delete' | 'sort'
import type { MeResult } from '../../../../shared/me'
import { meFailed, MeError } from '../../../../shared/me-errors'

export async function meCall<T>(request: Promise<MeResult<T>>): Promise<MeResult<T>> {
  try {
    return await request
  } catch {
    return meFailed(new MeError('unknown'))
  }
}
