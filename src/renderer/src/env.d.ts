/// <reference types="vite/client" />
import type { AuthBridge } from '../../shared/auth'
import type { MeBridge } from '../../shared/me'

declare global {
  interface Window {
    mix: { auth: AuthBridge; me: MeBridge }
  }
}
