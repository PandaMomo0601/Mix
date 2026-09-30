import { mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const temp = await mkdtemp('/private/tmp/mix-me-preview-')
const boot = join(temp, 'preview.cjs')
await writeFile(
  boot,
  `
const {app}=require('electron');
app.setPath('appData',${JSON.stringify(temp)});
app.on('browser-window-created',(_event,window)=>{
 window.setTitle('Mix · 合成数据预览');
 window.on('page-title-updated',event=>event.preventDefault());
});
const fixture=require(${JSON.stringify(join(root, 'tests/fixtures/me-server.cjs'))});
globalThis.fetch=fixture.fakeFetch;
require(${JSON.stringify(join(root, 'out/main/index.js'))});
`
)
console.log('Mix 合成数据预览：所有服务响应来自本机，未连接云端。')
console.log('登录示例 demo@example.com / FixtureOnly!2026；Key 可填 synthetic-demo-1234。')
console.log('隔离数据目录：' + temp)
const child = spawn(require('electron'), [boot], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
})
process.on('SIGINT', () => child.kill('SIGTERM'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
