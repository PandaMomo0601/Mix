import { describe, expect, it } from 'vitest'
import type { User } from '@supabase/supabase-js'
import { normalizeAccountProfile } from '../src/shared/profile'
import { parseCredentials } from '../src/shared/validation'
import { mapAuthError } from '../src/shared/auth-errors'
import { parseMailCallback } from '../src/shared/mail-callback'
import { isPublicKey, readAuthConfig } from '../src/main/auth/config'

const profile = (metadata: unknown): ReturnType<typeof normalizeAccountProfile> =>
  normalizeAccountProfile({
    id: '00000000-0000-4000-8000-000000000001',
    email: 'test@example.com',
    user_metadata: metadata
  } as User)

describe('account contracts', () => {
  it('trims email only, accepts old passwords and rejects unknown bridge fields', () => {
    expect(parseCredentials({ email: ' test@example.com ', password: ' a ' })).toEqual({
      email: 'test@example.com',
      password: ' a '
    })
    expect(
      parseCredentials({ email: 'test@example.com', password: 'a', user_id: 'other' })
    ).toBeNull()
    for (const email of ['', 'hello', 'a@b', 'a @b.co', {}, null])
      expect(parseCredentials({ email, password: 'p' })).toBeNull()
  })
  it('normalizes display data without mutating or granting metadata roles', () => {
    const metadata = { nickname: ' 示例 ', avatar: { emoji: '🐼', bg: '#aBcDeF' }, role: 'admin' }
    const before = JSON.stringify(metadata)
    expect(profile(metadata)).toMatchObject({
      displayName: '示例',
      avatar: { emoji: '🐼', bg: '#aBcDeF' }
    })
    expect(profile(metadata)).not.toHaveProperty('role')
    expect(JSON.stringify(metadata)).toBe(before)
  })
  it.each([undefined, null, [], 42, {}, { nickname: [] }, { nickname: ' ' }])(
    'falls back for malformed profile %j',
    (metadata) => {
      expect(profile(metadata)).toMatchObject({ displayName: 'test@example.com', avatar: null })
    }
  )
  it('rejects avatar HTML, arbitrary CSS and unlisted emoji without truncating text', () => {
    expect(
      profile({ avatar: { emoji: '<img src=x>', bg: 'url(https://example.com)' } }).avatar
    ).toBeNull()
    expect(profile({ avatar: { emoji: '🐼', bg: 'red' } }).avatar?.bg).toBe('#E3F2FD')
    const longName = '<script>' + '长'.repeat(10000)
    expect(profile({ nickname: longName }).displayName).toBe(longName)
  })
  it('distinguishes transient and explicitly invalid sessions, never echoing raw messages', () => {
    expect(mapAuthError({ status: 503, message: 'sensitive' }).code).toBe('connection')
    expect(mapAuthError({ code: 'refresh_token_not_found' }).code).toBe('session-expired')
    expect(mapAuthError({ status: 403, code: 'unrecognized', message: 'private' }).code).toBe(
      'unknown'
    )
    expect(mapAuthError({ code: 'invalid_credentials', message: 'private' }).message).toBe(
      '邮箱或密码不正确。'
    )
    expect(mapAuthError({ status: 429 }).code).toBe('rate-limit')
  })
})

describe('public configuration and mail callback', () => {
  it('rejects privileged keys and unsafe redirect destinations', () => {
    const jwt = (role: string): string =>
      `e30.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`
    expect(isPublicKey(jwt('service_role'))).toBe(false)
    expect(isPublicKey('sb_secret_example')).toBe(false)
    expect(isPublicKey(jwt('anon'))).toBe(true)
    const cfg = readAuthConfig({
      MAIN_VITE_SUPABASE_URL: 'https://example.supabase.co',
      MAIN_VITE_SUPABASE_PUBLISHABLE_KEY: jwt('anon'),
      MAIN_VITE_AUTH_RECOVERY_URL: 'javascript:alert(1)'
    })
    expect(cfg?.recoveryUrl).toBeNull()
    expect(
      readAuthConfig({
        MAIN_VITE_SUPABASE_URL: 'http://example.com',
        MAIN_VITE_SUPABASE_PUBLISHABLE_KEY: jwt('anon')
      })
    ).toBeNull()
  })
  it('requires a complete callback for the exact page, not a recovery marker or an old web session', () => {
    expect(parseMailCallback('#type=recovery', '/recovery.html')).toBeNull()
    expect(
      parseMailCallback('#type=recovery&access_token=a&refresh_token=b', '/confirm.html')
    ).toBeNull()
    expect(
      parseMailCallback(
        '#type=recovery&type=signup&access_token=a&refresh_token=b',
        '/recovery.html'
      )
    ).toBeNull()
    expect(
      parseMailCallback(
        '#type=recovery&access_token=a&refresh_token=b&error=expired',
        '/recovery.html'
      )
    ).toBeNull()
    expect(
      parseMailCallback('#type=recovery&access_token=a&refresh_token=b', '/recovery.html')
    ).toEqual({ type: 'recovery', accessToken: 'a', refreshToken: 'b' })
  })
})
