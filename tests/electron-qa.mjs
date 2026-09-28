import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executable =
  process.env.MIX_QA_EXECUTABLE || join(root, 'dist/mac-arm64/Mix.app/Contents/MacOS/Mix')
const evidence = process.env.MIX_EVIDENCE_DIR || '/private/tmp/mix-auth-final-qa-20260928'
await mkdir(evidence, { recursive: true })
const profile = await mkdtemp(join(evidence, 'isolated-profile-'))
const fixture = join(root, 'tests/fixtures/qa-auth-server.cjs')
const results = []
const screenshots = []
let application
let page
let window
let storageFile

const visible = (title) => page.getByRole('heading', { name: title, exact: true }).waitFor()
const configure = (values) =>
  application.evaluate((_, values) => Object.assign(globalThis.__mixQA, values), values)
const requests = () => application.evaluate(() => globalThis.__mixQA.requests)
const release = () =>
  application.evaluate(() => {
    const state = globalThis.__mixQA
    state.hold = null
    state.release?.()
    state.release = null
  })
const record = (id, tc, observation) => results.push({ id, tc, result: 'PASS', observation })
const capture = async (name) => {
  // Native capture preserves the entire client area when Electron page zoom is active.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  const png = await window.evaluate(async (w) =>
    (await w.webContents.capturePage()).toPNG().toString('base64')
  )
  await writeFile(join(evidence, name), Buffer.from(png, 'base64'))
  screenshots.push(name)
}
const noOverflow = async () => {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true
  )
}
const login = async (password = ' a ') => {
  await page.getByLabel('邮箱地址', { exact: true }).fill('demo@example.com')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}
const launch = async () => {
  application = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    timeout: 25000
  })
  assert.deepEqual(
    await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      path: app.getPath('userData')
    })),
    { packaged: true, path: profile }
  )
  // Every launch starts with empty or intentionally corrupt QA storage, never a live session.
  await application.evaluate((_, path) => {
    const mock = process.mainModule.require(path)
    globalThis.__mixQA = mock.state
    globalThis.fetch = mock.fakeFetch
  }, fixture)
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  window = await application.browserWindow(page)
}

try {
  await launch()
  await visible('欢迎回来')
  assert.equal((await requests()).length, 0)
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  assert.deepEqual(
    await application.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { sandbox: p.sandbox, isolation: p.contextIsolation, node: p.nodeIntegration }
    }),
    { sandbox: true, isolation: true, node: false }
  )
  const layout = await page.locator('section').evaluate((column) => {
    const style = getComputedStyle(column)
    const positions = [
      column.querySelector('.mix-wordmark'),
      column.querySelector('h1'),
      column.querySelector('label')
    ].map((node) => node.getBoundingClientRect().left)
    return {
      width: column.getBoundingClientRect().width,
      fill: style.backgroundColor,
      shadow: style.boxShadow,
      leftAligned: positions.every((value) => Math.abs(value - positions[0]) < 1),
      background: getComputedStyle(document.documentElement).backgroundColor
    }
  })
  assert.deepEqual(layout, {
    width: 380,
    fill: 'rgba(0, 0, 0, 0)',
    shadow: 'none',
    leftAligned: true,
    background: 'rgb(255, 255, 255)'
  })
  await capture('01-packaged-login.png')
  record(
    'QA-01',
    ['TC-21', 'TC-22', 'TC-26', 'TC-29'],
    'Production .app, isolated userData, real sandbox and monochrome layout'
  )

  const initial = (await requests()).length
  await page.getByRole('button', { name: '登录', exact: true }).click()
  assert.equal(await page.getByLabel('邮箱地址').getAttribute('aria-invalid'), 'true')
  await page.getByLabel('邮箱地址').fill('bad-address')
  await page.getByLabel('密码', { exact: true }).fill('placeholder')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByText('请输入有效的邮箱地址。', { exact: true }).waitFor()
  assert.equal((await requests()).length, initial)
  await page.getByLabel('邮箱地址').fill('demo@example.com')
  await page.getByLabel('密码', { exact: true }).fill(' a ')
  await page.getByLabel('邮箱地址').focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'password')
  await page.keyboard.press('Tab')
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute('aria-label')),
    '显示密码'
  )
  await page.keyboard.press('Enter')
  assert.equal(await page.getByLabel('密码', { exact: true }).getAttribute('type'), 'text')
  await page.getByLabel('密码', { exact: true }).focus()
  await page.locator('form').dispatchEvent('compositionstart')
  await page.keyboard.press('Enter')
  assert.equal((await requests()).length, initial)
  await page.locator('form').dispatchEvent('compositionend')
  await page.keyboard.press('Enter')
  await visible('已登录 Mix')
  assert.equal(
    (await requests()).some((r) => r.operation === 'token' && r.passwordUnchanged),
    true
  )
  await page.getByRole('button', { name: '退出当前设备', exact: true }).click()
  await visible('欢迎回来')
  assert.equal((await requests()).filter((r) => r.operation === 'logout').at(-1).scope, 'local')
  record(
    'QA-02',
    ['TC-03', 'TC-13', 'TC-23'],
    'Invalid forms stay local; Tab/Enter, password visibility, IME guard and untrimmed old password'
  )

  await configure({ badCredentials: true })
  await login()
  await page.getByText('邮箱或密码不正确。', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'alert')
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.activeElement).outlineColor),
    'rgb(23, 23, 23)'
  )
  assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '')
  assert.equal(await page.getByLabel('邮箱地址').inputValue(), 'demo@example.com')
  assert.equal(await page.getByText('Private backend fixture detail').count(), 0)
  await capture('02-packaged-error.png')
  await configure({ badCredentials: false })
  record(
    'QA-03',
    ['TC-02', 'TC-21', 'TC-23'],
    'Generic credential error, alert focus, cleared password and no raw backend details'
  )

  await page.getByRole('button', { name: '没有账号？创建账号', exact: true }).click()
  await page.getByLabel('密码', { exact: true }).fill('QaFixture!2026')
  await page.getByLabel('确认密码', { exact: true }).fill('mismatch')
  const signupBefore = (await requests()).filter((r) => r.operation === 'signup').length
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await page.getByText('两次输入的密码不一致。', { exact: true }).waitFor()
  assert.equal((await requests()).filter((r) => r.operation === 'signup').length, signupBefore)
  await page.getByLabel('确认密码', { exact: true }).fill('QaFixture!2026')
  await configure({ hold: 'signup' })
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await page.getByRole('button', { name: '处理中…', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '处理中…', exact: true }).isDisabled(), true)
  await page.keyboard.press('Enter')
  assert.equal((await requests()).filter((r) => r.operation === 'signup').length, signupBefore + 1)
  await capture('03-packaged-registration-loading.png')
  await release()
  await visible('检查你的邮箱')
  assert.equal((await page.evaluate(() => window.mix.auth.getState())).profile, null)
  await capture('04-packaged-confirm-email.png')
  await configure({ hold: 'resend' })
  const resendBefore = (await requests()).filter((r) => r.operation === 'resend').length
  await page.getByRole('button', { name: '重新发送确认邮件', exact: true }).click()
  await page.getByRole('button', { name: '请求中…', exact: true }).waitFor()
  await page.keyboard.press('Enter')
  assert.equal((await requests()).filter((r) => r.operation === 'resend').length, resendBefore + 1)
  await release()
  await page.getByRole('button', { name: '重新发送确认邮件', exact: true }).waitFor()
  await configure({ rateLimit: true })
  await page.getByRole('button', { name: '重新发送确认邮件', exact: true }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByText('Private backend fixture detail').count(), 0)
  await capture('05-packaged-confirm-rate-limit.png')
  await configure({ rateLimit: false })
  await page.getByRole('button', { name: '我已确认，去登录', exact: true }).click()
  await visible('欢迎回来')
  await configure({ unconfirmed: true })
  await login()
  await visible('检查你的邮箱')
  await configure({ unconfirmed: false })
  await page.getByRole('button', { name: '我已确认，去登录', exact: true }).click()
  record(
    'QA-04',
    ['TC-03', 'TC-04', 'TC-05', 'TC-08', 'TC-23'],
    'Synthetic registration confirmation, unconfirmed rejection, loading guards and resend rate limit'
  )

  await page.getByRole('button', { name: '忘记密码？', exact: true }).click()
  await visible('找回密码')
  await configure({ hold: 'recover' })
  const recoverBefore = (await requests()).filter((r) => r.operation === 'recover').length
  await page.getByRole('button', { name: '发送重置指引', exact: true }).click()
  await page.getByRole('button', { name: '处理中…', exact: true }).waitFor()
  await page.keyboard.press('Enter')
  assert.equal(
    (await requests()).filter((r) => r.operation === 'recover').length,
    recoverBefore + 1
  )
  await release()
  await visible('检查你的邮箱')
  await page.getByText('已请求发送重置指引', { exact: true }).waitFor()
  await capture('06-packaged-recovery-request.png')
  await page.getByRole('button', { name: '返回登录', exact: true }).click()
  record(
    'QA-05',
    ['TC-06', 'TC-07', 'TC-08', 'TC-23'],
    'Synthetic recovery request has one in-flight operation and states request acceptance, not delivery'
  )

  await page.getByRole('button', { name: '没有账号？创建账号', exact: true }).click()
  await window.evaluate((w) => w.setSize(640, 480))
  for (const factor of [1, 1.25, 1.5]) {
    await window.evaluate((w, factor) => w.webContents.setZoomFactor(factor), factor)
    const bounds = await window.evaluate((w) => w.getContentBounds())
    await page.waitForFunction(({ width, factor }) => Math.abs(innerWidth - width / factor) < 2, {
      width: bounds.width,
      factor
    })
    await page.getByRole('button', { name: '创建账号', exact: true }).scrollIntoViewIfNeeded()
    await noOverflow()
    assert.equal(
      await page.getByRole('button', { name: '创建账号', exact: true }).evaluate((button) => {
        const r = button.getBoundingClientRect()
        return (
          r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1
        )
      }),
      true
    )
    await capture(`07-packaged-register-${Math.round(factor * 100)}.png`)
  }
  await window.evaluate((w) => {
    w.webContents.setZoomFactor(1)
    w.setSize(1100, 760)
  })
  await page.getByRole('button', { name: '已有账号？登录', exact: true }).click()
  record(
    'QA-06',
    ['TC-22', 'TC-23', 'TC-26'],
    'Mac package registration remains scrollable at 640×480 and 100/125/150 percent zoom'
  )

  for (const [name, metadata] of [
    ['normal', { nickname: '示例用户', avatar: { emoji: '🐼', bg: '#E3F2FD' } }],
    ['missing', null],
    [
      'unsafe',
      {
        nickname: '<img src=x onerror=alert(1)>',
        avatar: { emoji: '<svg>', bg: 'url(https://example.com)' }
      }
    ],
    ['long', { nickname: '长'.repeat(10000), avatar: { emoji: '🐼', bg: 'red' } }]
  ]) {
    await configure({ metadata })
    await login()
    await visible('已登录 Mix')
    const snapshot = await page.evaluate(() => window.mix.auth.getState())
    assert.equal(/access_token|refresh_token|user_metadata/.test(JSON.stringify(snapshot)), false)
    if (name === 'missing') {
      assert.equal(snapshot.profile.displayName, 'demo@example.com')
      assert.equal(snapshot.profile.avatar, null)
    }
    if (name === 'unsafe') {
      assert.equal(await page.locator('img, svg').count(), 0)
      assert.equal(snapshot.profile.avatar, null)
      await page.getByText(metadata.nickname, { exact: true }).waitFor()
    }
    if (name === 'long') {
      assert.equal(snapshot.profile.displayName.length, 10000)
      assert.equal(snapshot.profile.avatar.bg, '#E3F2FD')
      await window.evaluate((w) => w.setSize(640, 480))
    }
    await noOverflow()
    await capture(`08-packaged-profile-${name}.png`)
    await page.getByRole('button', { name: '退出当前设备', exact: true }).click()
    await visible('欢迎回来')
    await window.evaluate((w) => w.setSize(1100, 760))
  }
  record(
    'QA-07',
    ['TC-17', 'TC-18', 'TC-19', 'TC-26', 'TC-38'],
    'Real package normalizes valid, missing, malicious and 10000-character metadata without HTML execution or overflow'
  )

  await configure({ metadata: { nickname: '示例用户', avatar: { emoji: '🐼', bg: '#E3F2FD' } } })
  await login()
  await visible('已登录 Mix')
  const authDir = join(profile, 'auth')
  const files = await readdir(authDir)
  storageFile = join(
    authDir,
    files.find((name) => name.endsWith('.enc'))
  )
  assert.equal((await stat(storageFile)).mode & 0o777, 0o600)
  const ciphertext = await readFile(storageFile)
  assert.equal(ciphertext.includes('fixture-refresh-token'), false)
  assert.equal(ciphertext.includes('demo@example.com'), false)
  await configure({ offline: true })
  await page.evaluate(() => window.mix.auth.retry())
  await visible('暂时无法连接')
  assert.equal((await readFile(storageFile)).equals(ciphertext), true)
  await capture('09-packaged-offline.png')
  await configure({ offline: false })
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await visible('已登录 Mix')
  await configure({ offline: true })
  await page.getByRole('button', { name: '退出当前设备', exact: true }).click()
  await visible('欢迎回来')
  await page.getByText('本机已退出，未能确认远端会话撤销。', { exact: true }).waitFor()
  assert.equal(
    (await readdir(authDir)).some((name) => name.endsWith('.enc')),
    false
  )
  await application.close()
  application = null
  await launch()
  await visible('欢迎回来')
  assert.equal((await requests()).length, 0)
  record(
    'QA-08',
    ['TC-09', 'TC-11', 'TC-14', 'TC-21', 'TC-22'],
    'Real OS encryption, 0600 file, offline preservation/retry and local logout surviving package restart'
  )

  const second = spawn(executable, [`--user-data-dir=${profile}`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: 'ignore'
  })
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      second.kill()
      reject(Error('Second package instance did not exit'))
    }, 10000)
    second.once('error', reject)
    second.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  assert.equal(exit, 0)
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    1
  )
  record(
    'QA-09',
    ['TC-35'],
    'Second actual package instance exits and preserves the original window'
  )

  await application.close()
  application = null
  await writeFile(storageFile, 'deliberately-corrupt-qa-ciphertext', { mode: 0o600 })
  await launch()
  await visible('无法读取本机登录信息')
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.activeElement).outlineColor),
    'rgb(23, 23, 23)'
  )
  assert.equal(await readFile(storageFile, 'utf8'), 'deliberately-corrupt-qa-ciphertext')
  assert.equal((await requests()).length, 0)
  await capture('10-packaged-storage-error.png')
  await page.getByRole('button', { name: '清除本机登录信息', exact: true }).click()
  await visible('欢迎回来')
  assert.equal(
    (await readdir(join(profile, 'auth'))).some((name) => name.endsWith('.enc')),
    false
  )
  record(
    'QA-10',
    ['TC-30', 'TC-31', 'TC-38'],
    'Corrupt OS ciphertext is retained, recoverable UI is shown, explicit local cleanup succeeds'
  )

  const asarPath = join(dirname(dirname(executable)), 'Resources/app.asar')
  const report = {
    result: 'PASS',
    executedAt: new Date().toISOString(),
    executor: 'Codex',
    platform: `${process.platform}/${process.arch}`,
    scope: 'Unmodified macOS arm64 production .app; synthetic Auth HTTP and isolated userData',
    executable,
    appAsarSha256: createHash('sha256')
      .update(await readFile(asarPath))
      .digest('hex'),
    results,
    screenshots,
    limitations: [
      'No live accounts, email delivery or shared cloud changes',
      'No Windows, Intel Mac or screen-reader evidence',
      'Packaged encrypted-session restoration is not tested; restart evidence covers cleared-session logout'
    ]
  }
  await writeFile(join(evidence, 'packaged-result.json'), JSON.stringify(report, null, 2))
  await rm(join(evidence, 'packaged-failure.json'), { force: true })
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  await writeFile(
    join(evidence, 'packaged-failure.json'),
    JSON.stringify({ result: 'FAIL', passed: results, message: error.message }, null, 2)
  )
  throw error
} finally {
  if (application) await application.close().catch(() => {})
  await rm(profile, { recursive: true, force: true })
}
