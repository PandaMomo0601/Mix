import type { Credentials } from './auth'

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim()
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

export function parseCredentials(value: unknown): Credentials | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (Object.keys(data).some((key) => key !== 'email' && key !== 'password')) return null
  const email = normalizeEmail(data.email)
  // A transport bound, not a new password-strength policy. Passwords are never trimmed.
  if (!email || typeof data.password !== 'string' || !data.password || data.password.length > 4096)
    return null
  return { email, password: data.password }
}
