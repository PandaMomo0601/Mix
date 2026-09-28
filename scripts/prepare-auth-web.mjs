import { cp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const staging = resolve(root, 'dist/auth-web-deploy')
const publicDir = resolve(staging, 'public')

// Only compiled browser assets are uploaded. Preserve the separate Vercel project link.
await mkdir(staging, { recursive: true })
await rm(publicDir, { recursive: true, force: true })
await cp(resolve(root, 'out/auth-web'), publicDir, { recursive: true })
await cp(resolve(root, 'deployment/auth-web/vercel.json'), resolve(staging, 'vercel.json'))
await cp(resolve(root, 'deployment/auth-web/.vercelignore'), resolve(staging, '.vercelignore'))
console.log(`Auth web deployment prepared: ${staging}`)
