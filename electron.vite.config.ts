import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { isPublicKey } from './src/main/auth/config'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['MAIN_VITE_'])
  const key = env.MAIN_VITE_SUPABASE_PUBLISHABLE_KEY
  if (key && !isPublicKey(key)) throw new Error('Auth build requires a publishable or anon key')
  return {
    main: {
      resolve: {
        alias: { '@main': resolve(__dirname, 'src/main') }
      }
    },
    preload: {
      resolve: {
        alias: { '@preload': resolve(__dirname, 'src/preload') }
      }
    },
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve(__dirname, 'src/renderer/src')
        }
      },
      plugins: [react(), tailwindcss()]
    }
  }
})
