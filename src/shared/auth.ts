export interface AccountProfile {
  id: string
  email: string
  displayName: string
  avatar: { emoji: string; bg: string } | null
  emailConfirmedAt: string | null
}

export type AuthStatus =
  | 'starting'
  | 'signed-out'
  | 'signed-in'
  | 'connection-error'
  | 'storage-error'
  | 'configuration-error'

export type AuthErrorCode =
  | 'invalid-input'
  | 'invalid-credentials'
  | 'email-unconfirmed'
  | 'weak-password'
  | 'rate-limit'
  | 'connection'
  | 'session-expired'
  | 'storage'
  | 'configuration'
  | 'busy'
  | 'cancelled'
  | 'unknown'

export interface AuthFailure {
  code: AuthErrorCode
  message: string
}

export interface AuthSnapshot {
  revision: number
  status: AuthStatus
  profile: AccountProfile | null
  message: string | null
  capabilities: { registration: boolean; recovery: boolean; passwordHint: string }
}

export type AuthResult =
  | { ok: true; outcome: 'signed-in' | 'check-email' | 'signed-out'; message?: string }
  | { ok: false; error: AuthFailure }

export interface Credentials {
  email: string
  password: string
}

export interface AuthBridge {
  getState: () => Promise<AuthSnapshot>
  signIn: (credentials: Credentials) => Promise<AuthResult>
  signUp: (credentials: Credentials) => Promise<AuthResult>
  resendConfirmation: (email: string) => Promise<AuthResult>
  requestPasswordReset: (email: string) => Promise<AuthResult>
  retry: () => Promise<void>
  signOut: () => Promise<AuthResult>
  onStateChange: (listener: (snapshot: AuthSnapshot) => void) => () => void
}

export const AUTH_CHANNELS = {
  state: 'auth:state',
  changed: 'auth:changed',
  signIn: 'auth:sign-in',
  signUp: 'auth:sign-up',
  resend: 'auth:resend',
  recover: 'auth:recover',
  retry: 'auth:retry',
  signOut: 'auth:sign-out'
} as const
