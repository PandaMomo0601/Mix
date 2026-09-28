import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { isPublicKey, readAuthConfig } from './src/main/auth/config'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'MAIN_VITE_')
  const key = env.MAIN_VITE_SUPABASE_PUBLISHABLE_KEY
  if (key && !isPublicKey(key)) throw new Error('Auth build requires a publishable or anon key')
  const config = readAuthConfig(env)
  return {
    root: resolve('src/auth-web'),
    base: './',
    envPrefix: 'MAIL_PUBLIC_',
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'auth-csp',
        transformIndexHtml: (html) => html.replace('__AUTH_ORIGIN__', config?.url ?? "'none'")
      }
    ],
    define: {
      __AUTH_URL__: JSON.stringify(config?.url ?? ''),
      __AUTH_KEY__: JSON.stringify(config?.publicKey ?? ''),
      __PASSWORD_HINT__: JSON.stringify(config?.passwordHint ?? '请设置不易猜测的密码。')
    },
    build: {
      outDir: resolve('out/auth-web'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          confirm: resolve('src/auth-web/confirm.html'),
          recovery: resolve('src/auth-web/recovery.html')
        }
      }
    }
  }
})
