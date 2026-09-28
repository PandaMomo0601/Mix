import { create } from 'zustand'

export type Theme = 'light' | 'dark'

interface AppState {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const useAppStore = create<AppState>()((set) => ({
  theme: 'light',
  setTheme: (theme) => set({ theme })
}))
