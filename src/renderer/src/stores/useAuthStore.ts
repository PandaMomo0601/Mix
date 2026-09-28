import { create } from 'zustand'
import type { AuthSnapshot } from '../../../shared/auth'

interface AuthState {
  snapshot: AuthSnapshot | null
  apply: (snapshot: AuthSnapshot) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  snapshot: null,
  apply: (snapshot) =>
    set((state) =>
      !state.snapshot || snapshot.revision > state.snapshot.revision ? { snapshot } : state
    )
}))
