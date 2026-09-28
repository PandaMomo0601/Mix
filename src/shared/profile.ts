import type { User } from '@supabase/supabase-js'
import type { AccountProfile } from './auth'

const AVATARS = new Set([
  '🤖',
  '🧠',
  '🦊',
  '🐱',
  '🐶',
  '🦉',
  '🐼',
  '🦁',
  '🐸',
  '🐙',
  '🦋',
  '🌸',
  '🔮',
  '⚡',
  '🎯',
  '🎭',
  '🧙',
  '👾',
  '🦄',
  '🐲',
  '🌟',
  '💎',
  '🧊',
  '🌈',
  '🍀',
  '🔥',
  '🌊',
  '🎨'
])

export function normalizeAccountProfile(user: User): AccountProfile {
  const metadata: unknown = user.user_metadata
  const values =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {}
  const nickname = typeof values.nickname === 'string' ? values.nickname.trim() : ''
  const raw = values.avatar
  let avatar: AccountProfile['avatar'] = null
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const { emoji, bg } = raw as Record<string, unknown>
    if (typeof emoji === 'string' && AVATARS.has(emoji)) {
      avatar = { emoji, bg: typeof bg === 'string' && /^#[a-f\d]{6}$/i.test(bg) ? bg : '#E3F2FD' }
    }
  }
  return {
    id: user.id,
    email: user.email ?? '',
    displayName: nickname || user.email || 'Mix 用户',
    avatar,
    emailConfirmedAt: user.email_confirmed_at ?? null
  }
}
