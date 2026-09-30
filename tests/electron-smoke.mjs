import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, extname, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const fixture = require('./fixtures/auth-server.cjs')
const temp = await mkdtemp(join(tmpdir(), 'mix-auth-smoke-'))
const evidence = process.env.MIX_EVIDENCE_DIR || join(temp, 'evidence')
await mkdir(evidence, { recursive: true })
const boot = join(temp, 'launch.cjs')
await writeFile(
  boot,
  `
const { app } = require('electron')
app.setPath('appData', ${JSON.stringify(temp)})
const fixture = require(${JSON.stringify(join(root, 'tests/fixtures/auth-server.cjs'))})
globalThis.__authMock = fixture.state
globalThis.fetch = fixture.fakeFetch
require(${JSON.stringify(join(root, 'out/main/index.js'))})
`
)
const passed = []
let app
let chrome
let server
const launch = async () => {
  app = await _electron.launch({
    args: [boot],
    timeout: 25000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  return page
}
const visible = (page, name) => page.getByRole('heading', { name, exact: true }).waitFor()
const login = async (page) => {
  await page.getByLabel('邮箱地址', { exact: true }).fill('demo@example.com')
  await page.getByLabel('密码', { exact: true }).fill('FixtureOnly!2026')
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

try {
  let page = await launch()
  await visible(page, '欢迎回来')
  await page.screenshot({ path: join(evidence, '01-login.png') })
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { isolation: p.contextIsolation, sandbox: p.sandbox, node: p.nodeIntegration }
  })
  assert.deepEqual(preferences, { isolation: true, sandbox: true, node: false })
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  passed.push('Electron isolation, sandbox and narrow preload')

  await page.getByRole('button', { name: '登录', exact: true }).click()
  assert.equal(await page.getByLabel('邮箱地址').getAttribute('aria-invalid'), 'true')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'email')
  await page.getByLabel('邮箱地址').fill('demo@example.com')
  await page.getByLabel('密码', { exact: true }).fill('NeverPersistThisPassword')
  await page.getByRole('button', { name: '显示密码', exact: true }).click()
  assert.equal(await page.getByLabel('密码', { exact: true }).getAttribute('type'), 'text')
  await page.getByRole('button', { name: '没有账号？创建账号' }).click()
  assert.equal(await page.getByLabel('邮箱地址').inputValue(), 'demo@example.com')
  assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '')
  const window = await app.browserWindow(page)
  await window.evaluate((w) => w.setSize(640, 480))
  await page.getByRole('button', { name: '创建账号', exact: true }).scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(evidence, '02-register-small.png') })
  passed.push(
    'Empty validation, focus, password visibility, clear-on-navigation and 640×480 scroll'
  )
  await page.getByRole('button', { name: '已有账号？登录' }).click()
  await window.evaluate((w) => w.setSize(1100, 760))

  await app.evaluate(() => {
    globalThis.__authMock.badCredentials = true
  })
  await login(page)
  await page.getByText('邮箱或密码不正确。', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'alert')
  await app.evaluate(() => {
    globalThis.__authMock.badCredentials = false
  })
  await login(page)
  await visible(page, '账号信息')
  await page.getByText('示例用户', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.length), 0)
  const publicState = await page.evaluate(() => window.mix.auth.getState())
  assert.equal(publicState.profile.id, fixture.user.id)
  assert.equal(/access_token|refresh_token|user_metadata/.test(JSON.stringify(publicState)), false)
  await page.screenshot({ path: join(evidence, '03-signed-in.png') })
  const authDir = join(temp, 'Mix Development', 'auth')
  const files = await readdir(authDir)
  assert.equal(files.filter((name) => name.endsWith('.enc')).length, 1)
  const encrypted = await readFile(
    join(
      authDir,
      files.find((name) => name.endsWith('.enc'))
    )
  )
  for (const secret of [
    'NeverPersistThisPassword',
    'FixtureOnly!2026',
    'fixture-refresh-token',
    'demo@example.com'
  ])
    assert.equal(encrypted.includes(secret), false)
  passed.push('Real SDK password login through main, sanitized state and actual OS-encrypted file')

  await app.close()
  page = await launch()
  await visible(page, '账号信息')
  passed.push('Process restart restores encrypted session and revalidates via mocked Auth')

  const rejected = await app.evaluate(
    async ({ BrowserWindow }, { preload, url }) => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      try {
        await other.loadURL(url)
        return await other.webContents.executeJavaScript(
          'window.mix.auth.getState().then(() => false, () => true)'
        )
      } finally {
        other.destroy()
      }
    },
    { preload: join(root, 'out/preload/index.js'), url: page.url() }
  )
  assert.equal(rejected, true)
  passed.push('IPC rejects a second window even when it loads the same application URL')

  await app.evaluate(() => {
    globalThis.__authMock.offline = true
  })
  await page.evaluate(() => window.mix.auth.retry())
  await visible(page, '暂时无法连接')
  await page.getByRole('button', { name: '退出当前设备' }).click()
  await visible(page, '欢迎回来')
  await page.getByText('本机已退出，未能确认远端会话撤销。', { exact: true }).waitFor()
  assert.deepEqual(
    (await readdir(authDir)).filter((name) => name.endsWith('.enc')),
    []
  )
  await app.close()
  page = await launch()
  await visible(page, '欢迎回来')
  assert.equal((await page.evaluate(() => window.mix.auth.getState())).profile, null)
  passed.push('Offline recovery keeps credentials; offline logout removes them across restart')
  await app.close()
  app = null

  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const base = join(root, 'out/auth-web')
    const file = resolve(base, '.' + path)
    if (!file.startsWith(base + '/')) {
      res.writeHead(403).end()
      return
    }
    try {
      const content = await readFile(file)
      const mime =
        { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ||
        'application/octet-stream'
      res
        .writeHead(200, {
          'content-type': mime,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer'
        })
        .end(content)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  chrome = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await chrome.newContext()
  let authRequests = 0
  let updatedPassword = false
  await context.route('https://**.supabase.co/**', async (route) => {
    authRequests++
    const request = route.request()
    if (request.method() === 'PUT') updatedPassword = Boolean(request.postDataJSON().password)
    const response = await fixture.fakeFetch(request.url(), { method: request.method() })
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text()
    })
  })
  const browserPage = await context.newPage()
  await browserPage.addInitScript(() =>
    localStorage.setItem('ordinary-web-session', 'must-not-be-used')
  )
  await browserPage.goto(origin + '/recovery.html#type=recovery')
  await visible(browserPage, '链接无效或已过期')
  assert.equal(authRequests, 0)
  assert.equal(new URL(browserPage.url()).hash, '')
  const hash = `#type=recovery&access_token=${fixture.token()}&refresh_token=fixture-refresh-token`
  // A new email click navigates through Auth. Avoid a same-document hash-only jump.
  await browserPage.goto('about:blank')
  await browserPage.goto(origin + '/recovery.html' + hash)
  await visible(browserPage, '设置新密码')
  const layout = await browserPage.locator('main').evaluate((main) => {
    const column = main.querySelector('section').getBoundingClientRect()
    return {
      fillsViewport: main.getBoundingClientRect().height >= innerHeight,
      centered: Math.abs(column.y + column.height / 2 - innerHeight / 2) < 2,
      noOverflow: document.documentElement.scrollWidth <= innerWidth
    }
  })
  assert.deepEqual(layout, { fillsViewport: true, centered: true, noOverflow: true })
  passed.push('Separate mail build includes shared layout styles and centers the recovery form')
  assert.equal(new URL(browserPage.url()).hash, '')
  await browserPage.getByLabel('新密码', { exact: true }).fill('DifferentFixture!2026')
  await browserPage.getByLabel('确认密码', { exact: true }).fill('mismatch')
  await browserPage.getByRole('button', { name: '保存新密码' }).click()
  await browserPage.getByText('两次输入的密码不一致。', { exact: true }).waitFor()
  assert.equal(updatedPassword, false)
  await browserPage.getByLabel('确认密码', { exact: true }).fill('DifferentFixture!2026')
  await browserPage.getByRole('button', { name: '保存新密码' }).click()
  await visible(browserPage, '密码已更新')
  assert.equal(updatedPassword, true)
  assert.equal(await browserPage.evaluate(() => localStorage.length), 1)
  await browserPage.screenshot({ path: join(evidence, '04-browser-recovery.png') })
  await browserPage.reload()
  await visible(browserPage, '链接无效或已过期')
  passed.push(
    'Independent browser refuses marker-only callback; valid fixture session resets and is not persisted'
  )
  await browserPage.goto(
    origin +
      `/confirm.html#type=signup&access_token=${fixture.token()}&refresh_token=fixture-refresh-token`
  )
  await visible(browserPage, '邮箱已确认')
  passed.push('Independent browser confirmation with fresh fixture callback')
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        scope: 'Real Electron/Chrome with synthetic Auth HTTP; no live accounts or emails',
        passed,
        evidence
      },
      null,
      2
    )
  )
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify({ result: 'PASS', passed, evidence }, null, 2)
  )
} finally {
  if (app) await app.close().catch(() => {})
  if (chrome) await chrome.close()
  if (server) await new Promise((resolve) => server.close(resolve))
}
