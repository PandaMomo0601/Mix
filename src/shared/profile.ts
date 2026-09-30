import type { User } from '@supabase/supabase-js'
import type { AccountProfile } from './auth'

export const AVATAR_EMOJI = [
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
] as const

const AVATARS = new Set<string>(AVATAR_EMOJI)
const AVATAR_COLORS = [
  '#FFE4E1',
  '#E8F5E9',
  '#E3F2FD',
  '#FFF3E0',
  '#F3E5F5',
  '#E0F7FA',
  '#FFF9C4',
  '#FCE4EC',
  '#E8EAF6',
  '#F1F8E9'
]

export function avatarFor(emoji: string): AccountProfile['avatar'] {
  const index = AVATAR_EMOJI.indexOf(emoji as (typeof AVATAR_EMOJI)[number])
  return index < 0 ? null : { emoji, bg: AVATAR_COLORS[index % AVATAR_COLORS.length] }
}

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
    nickname: nickname || null,
    avatar,
    emailConfirmedAt: user.email_confirmed_at ?? null
  }
}
