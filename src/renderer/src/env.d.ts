/// <reference types="vite/client" />
import type { AuthBridge } from '../../shared/auth'

declare global {
  interface Window {
    mix: { auth: AuthBridge }
  }
}
