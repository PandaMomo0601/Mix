import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const mainEntry = process.env.MIX_ME_MAIN || join(root, 'out/main/index.js')
const temp = await mkdtemp(join(tmpdir(), 'mix-me-electron-'))
const evidence = process.env.MIX_EVIDENCE_DIR || join(temp, 'evidence')
await mkdir(evidence, { recursive: true })
const boot = join(temp, 'launch.cjs')
await writeFile(
  boot,
  `const {app}=require('electron');app.setPath('appData',${JSON.stringify(temp)});const f=require(${JSON.stringify(join(root, 'tests/fixtures/me-server.cjs'))});globalThis.__meFixture=f.state;globalThis.__meRestoreServerReceipt=async()=>{const fs=require('node:fs/promises'),path=require('node:path'),{safeStorage}=require('electron');const encrypted=await fs.readFile(path.join(app.getPath('userData'),'me-credentials','deletion-receipt.enc'));const receipt=JSON.parse((await safeStorage.decryptStringAsync(encrypted)).result);f.state.deletion={requestId:receipt.requestId,secret:receipt.secret,data:{operationId:receipt.operationId,phase:'processing',nextPollAfter:10}};};globalThis.fetch=f.fakeFetch;require(${JSON.stringify(mainEntry)});`
)
const passed = [],
  errors = []
let application, page
async function launch() {
  application = await _electron.launch({
    args: [boot],
    timeout: 90000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
  })
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (e) => errors.push(e.message))
}
const heading = (name) => page.getByRole('heading', { name, exact: true }).waitFor()
const feedback = (name) =>
  page.locator('.mix-feedback').getByText(name, { exact: true }).first().waitFor()
const button = (name) => page.getByRole('button', { name, exact: true })
const dialogButton = (name) => page.getByRole('dialog').getByRole('button', { name, exact: true })
const screenshot = async (name) => {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  const window = await application.browserWindow(page)
  const png = await window.evaluate(async (w) =>
    (await w.webContents.capturePage()).toPNG().toString('base64')
  )
  await writeFile(join(evidence, name + '.png'), Buffer.from(png, 'base64'))
}
const fixture = (fn) => application.evaluate(fn)
async function finishKey() {
  if (await page.getByRole('dialog').isVisible()) {
    const complete = dialogButton('完成')
    await ((await complete.count()) ? complete : dialogButton('取消')).click()
  }
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
}
async function add(key, provider = 'deepseek') {
  await button('添加接入').click()
  await button('服务商').click()
  await dialogButton(
    { deepseek: 'DeepSeek', openai: 'OpenAI', openrouter: 'OpenRouter' }[provider]
  ).click()
  await page.getByLabel('API Key', { exact: true }).fill(key)
  await dialogButton('验证并保存').click()
  if (provider === 'openai') await dialogButton('同意并验证').click()
}
async function resize(width, height, zoom = 1) {
  const window = await application.browserWindow(page)
  await window.evaluate(
    (w, args) => {
      w.setSize(args.width, args.height)
      w.webContents.setZoomFactor(args.zoom)
    },
    { width, height, zoom }
  )
  await page.waitForFunction(
    (args) => Math.round(innerWidth) === Math.round(args.width / args.zoom),
    { width, zoom }
  )
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth)
}
try {
  await launch()
  await heading('欢迎回来')
  await page.getByLabel('邮箱地址', { exact: true }).fill('demo@example.com')
  await page.getByLabel('密码', { exact: true }).fill('FixtureOnly!2026')
  await button('登录').click()
  await heading('账号信息')
  await resize(1100, 760)
  const geometry = await page.locator('.me-profile-summary').evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    avatar: el.querySelector('.mix-avatar').getBoundingClientRect().width,
    text: getComputedStyle(el.querySelector('.me-name-text')).fontSize
  }))
  assert.deepEqual(geometry, { height: 98, avatar: 44, text: '18px' })
  assert.equal(
    await page.locator('.me-avatar-overlay').evaluate((el) => getComputedStyle(el).opacity),
    '0'
  )
  await button('更换头像').hover()
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.me-avatar-overlay')).opacity === '1'
  )
  assert.equal(
    await page.locator('.me-avatar-overlay').evaluate((el) => getComputedStyle(el).opacity),
    '1'
  )
  await screenshot('01-account-hover')
  await button('修改昵称').click()
  await heading('修改昵称')
  await page.getByLabel('昵称', { exact: true }).fill('取消的草稿')
  await dialogButton('取消').click()
  assert.equal(await page.locator('.me-name-text').textContent(), '示例用户')
  await button('修改昵称').click()
  await page.getByLabel('昵称', { exact: true }).fill('独立昵称')
  await dialogButton('保存昵称').click()
  await feedback('昵称已更新')
  assert.equal(await page.getByRole('dialog').isVisible(), true)
  await dialogButton('完成').click()
  assert.equal(await page.locator('.me-name-text').textContent(), '独立昵称')
  const fields = await fixture(() =>
    globalThis.__meFixture.requests
      .filter((r) => r.action === 'user' && r.method === 'PUT')
      .map((r) => r.profileFields)
  )
  assert.deepEqual(fields, [['nickname']])
  await button('更换头像').click()
  await heading('更换头像')
  assert.equal(await page.getByRole('group', { name: '预设头像' }).getByRole('button').count(), 28)
  await button('选择头像 🦊').click()
  await dialogButton('保存头像').click()
  await feedback('头像已更新')
  await screenshot('02-avatar-saved')
  await dialogButton('完成').click()
  assert.equal(await page.locator('.me-avatar-edit > span').first().textContent(), '🦊')
  assert.equal(await page.locator('.me-name-text').textContent(), '独立昵称')
  passed.push(
    'Compact accepted profile geometry, avatar hover, 28 presets, separate edits, cancel and persistent saved feedback'
  )

  for (const [width, height, zoom] of [
    [640, 480, 1],
    [800, 600, 1],
    [1100, 480, 1],
    [1440, 900, 1],
    [640, 480, 2]
  ]) {
    await resize(width, height, zoom)
    await button('更换头像').click()
    const geometry = await page.getByRole('dialog').evaluate((el) => {
      const footer = el.querySelector('footer').getBoundingClientRect(),
        r = el.getBoundingClientRect()
      return {
        fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
        footerVisible: footer.bottom <= innerHeight,
        noHorizontalOverflow: el.scrollWidth <= el.clientWidth
      }
    })
    assert.deepEqual(geometry, { fits: true, footerVisible: true, noHorizontalOverflow: true })
    await screenshot(`03-avatar-${width}x${height}-zoom${zoom}`)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
  }
  await resize(640, 480)
  await fixture(() => {
    globalThis.__meFixture.user.user_metadata.nickname = '旧昵称很长'.repeat(60)
  })
  await page.evaluate(() => window.mix.me.refreshProfile())
  assert.equal((await page.locator('.me-name-text').textContent()).length, 300)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await screenshot('04-long-legacy-name')
  await fixture(() => {
    globalThis.__meFixture.user.user_metadata.nickname = '独立昵称'
  })
  await page.evaluate(() => window.mix.me.refreshProfile())
  await resize(1100, 760)
  passed.push(
    '640×480, 800×600, short and large windows, 200% zoom, scrollable dialog with fixed footer, readable legacy name'
  )

  await fixture(() => {
    globalThis.__meFixture.listError = true
  })
  await button('API Key').click()
  await feedback('接入列表暂时无法读取')
  assert.equal(await page.getByText('还没有模型接入', { exact: true }).count(), 0)
  await fixture(() => {
    globalThis.__meFixture.listError = false
  })
  await button('重新读取').click()
  await heading('还没有模型接入')
  await button('添加接入').click()
  await dialogButton('验证并保存').click()
  await page.getByText('请输入 API Key。', { exact: true }).waitFor()
  assert.equal(
    await fixture(
      () => globalThis.__meFixture.requests.filter((r) => r.action === 'create').length
    ),
    0
  )
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-invalid')
  await dialogButton('验证并保存').click()
  await page.getByText('服务商鉴权未通过，请检查 Key 后重试。', { exact: true }).waitFor()
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-first-1234')
  await dialogButton('验证并保存').click()
  await page.getByText('现在可以在创建机器人时选择这个接入带来的模型。', { exact: true }).waitFor()
  await finishKey()
  await add('synthetic-second-5678')
  await page.getByText('现在可以在创建机器人时选择这个接入带来的模型。', { exact: true }).waitFor()
  await finishKey()
  assert.equal(await button('管理 DeepSeek1').isEnabled(), true)
  await add('synthetic-first-1234', 'openrouter')
  await page.getByText('不能重复添加同一个 Key，请更换后再试。', { exact: true }).waitFor()
  await finishKey()
  assert.equal(await page.locator('.me-key-row').count(), 2)
  passed.push(
    'Error versus empty state, empty/invalid Key, cross-provider dedupe and distinct automatic connection names'
  )

  await button('管理 DeepSeek').click()
  await page.getByLabel('接入名称', { exact: true }).fill('工作接入')
  await dialogButton('保存名称').click()
  await page.getByText('已关联的机器人继续使用同一个接入。', { exact: true }).waitFor()
  await button('管理 工作接入').click()
  await fixture(() => {
    globalThis.__meFixture.hold = 'revalidate'
  })
  await dialogButton('重新验证').click()
  await feedback('正在验证…')
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').isVisible(), true)
  await fixture(() => {
    globalThis.__meFixture.hold = null
    globalThis.__meFixture.release()
  })
  await page.getByText('API Key 当前可用。\n最近验证：刚刚。', { exact: true }).waitFor()
  await screenshot('05-revalidation-persistent')
  assert.equal(await page.getByRole('dialog').isVisible(), true)
  await dialogButton('返回管理').click()
  await dialogButton('取消').click()
  const modelOptions = await page.evaluate(async () => {
    const list = await window.mix.me.listConnections()
    if (!list.ok) throw Error('list')
    const c = list.data.connections[0]
    return window.mix.me.getModelOptions({ id: c.id, credentialVersion: c.credentialVersion })
  })
  assert.equal(modelOptions.ok, true)
  assert.equal(modelOptions.data[0].connectionName, '工作接入')
  const serialization = await page.evaluate(async () =>
    JSON.stringify(await window.mix.me.listConnections())
  )
  assert.equal(serialization.includes('synthetic-first-1234'), false)
  passed.push(
    'Inline rename, model source identity, pending Escape guard and revalidation result remains until manual return'
  )

  await fixture(() => {
    globalThis.__meFixture.dropNextCommit = true
  })
  await add('synthetic-third-9012')
  await feedback('结果待核对')
  await dialogButton('核对操作结果').click()
  await feedback('本机保存已恢复')
  await finishKey()
  assert.equal(await page.locator('.me-key-row').count(), 3)
  const cloudCreates = await fixture(
    () => globalThis.__meFixture.requests.filter((r) => r.action === 'create').length
  )
  assert.equal(cloudCreates, 5)
  await screenshot('06-connections')
  const vaultRoot = join(temp, 'Mix Development', 'me-credentials')
  const accountDir = (await readdir(vaultRoot)).find((s) => /^[a-f0-9]{64}$/.test(s))
  const firstId = await fixture(() => globalThis.__meFixture.connections[0].id)
  await button('管理 工作接入').click()
  await dialogButton('替换 API Key').click()
  await page.getByLabel('新的 API Key', { exact: true }).fill('synthetic-replacement-8888')
  await dialogButton('验证并替换').click()
  await page.getByText('已关联的机器人继续使用这个接入。', { exact: true }).waitFor()
  assert.equal(await fixture(() => globalThis.__meFixture.connections[0].credentialVersion), 2)
  assert.equal(await fixture(() => globalThis.__meFixture.connections[0].id), firstId)
  await rm(join(vaultRoot, accountDir, createHash('sha256').update(firstId).digest('hex') + '.enc'))
  await button('账号信息').click()
  await button('API Key').click()
  await button('补填 Key 工作接入').click()
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-wrong-0000')
  await dialogButton('验证并保存到本机').click()
  await page.getByText('与此接入当前的 Key 不匹配', { exact: true }).waitFor()
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-replacement-8888')
  await dialogButton('验证并保存到本机').click()
  await page
    .getByText('这台设备现在可以使用此接入。没有新增接入，也没有改变机器人绑定。', { exact: true })
    .waitFor()
  await dialogButton('完成').click()
  assert.equal(await page.locator('.me-key-row').count(), 3)
  await button('调整顺序').click()
  await dialogButton('下移 1').click()
  await dialogButton('保存顺序').click()
  await page.getByText('模型调用仍按机器人选择的接入进行。', { exact: true }).waitFor()
  await finishKey()
  assert.equal(await page.locator('.me-key-row .me-label').first().textContent(), 'DeepSeek1')
  await button('管理 DeepSeek1').click()
  await dialogButton('删除接入').click()
  await dialogButton('删除接入').click()
  await page.getByText('使用该接入的机器人需要重新选择模型接入。', { exact: true }).waitFor()
  await finishKey()
  assert.equal(await page.locator('.me-key-row').count(), 2)
  await button('添加接入').click()
  await button('服务商').click()
  await dialogButton('OpenAI').click()
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-openai-4444')
  await dialogButton('验证并保存').click()
  await heading('需要调用模型验证')
  await dialogButton('取消').click()
  assert.equal(
    await page.getByLabel('API Key', { exact: true }).inputValue(),
    'synthetic-openai-4444'
  )
  await dialogButton('取消').click()
  await fixture(() => {
    const f = globalThis.__meFixture
    f.beforeCap = f.connections.slice()
    for (let n = f.connections.length; n < 20; n++)
      f.connections.push({
        ...f.connections[0],
        id: crypto.randomUUID(),
        displayName: '隔离接入' + n,
        displayOrder: n
      })
  })
  await button('账号信息').click()
  await button('API Key').click()
  await page.locator('.me-key-row').nth(19).waitFor()
  await add('synthetic-over-cap-7777')
  await page.getByText('请先删除不再使用的接入后重试。', { exact: true }).waitFor()
  await finishKey()
  await fixture(() => {
    globalThis.__meFixture.connections = globalThis.__meFixture.beforeCap
  })
  await button('账号信息').click()
  await button('API Key').click()
  await page.locator('.me-key-row').nth(1).waitFor()
  await resize(640, 480, 2)
  await button('管理 工作接入').click()
  assert.equal(
    await page
      .getByRole('dialog')
      .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight),
    true
  )
  await screenshot('06a-management-small-zoom2')
  await dialogButton('取消').click()
  await resize(1100, 760)
  passed.push(
    'Stable ID on replacement, local refill without new connection, wrong-Key rejection, cosmetic sort, delete, paid-consent reset and cap feedback'
  )
  const encryptedFiles = await readdir(join(vaultRoot, accountDir))
  assert.equal(encryptedFiles.filter((s) => s.endsWith('.enc')).length, 2)
  for (const name of encryptedFiles) {
    const encrypted = await readFile(join(vaultRoot, accountDir, name))
    for (const secret of [
      'synthetic-first-1234',
      'synthetic-second-5678',
      'synthetic-third-9012',
      'synthetic-replacement-8888'
    ])
      assert.equal(encrypted.includes(secret), false)
  }
  await button('账号信息').click()
  await button('退出当前设备').click()
  await heading('已退出当前设备')
  await button('前往登录').click()
  await heading('欢迎回来')
  assert.equal(
    (await readdir(join(vaultRoot, accountDir))).filter((s) => s.endsWith('.enc')).length,
    2
  )
  await resize(800, 600)
  await application.close()
  application = null
  await launch()
  await heading('欢迎回来')
  const restored = await (
    await application.browserWindow(page)
  ).evaluate((w) => w.getNormalBounds())
  assert.equal(restored.width, 800)
  assert.equal(restored.height, 600)
  passed.push(
    'Lost commit response recovered without another probe; actual OS-encrypted Keys retained on logout; window size survives restart'
  )

  await page.getByLabel('邮箱地址', { exact: true }).fill('demo@example.com')
  await page.getByLabel('密码', { exact: true }).fill('FixtureOnly!2026')
  await button('登录').click()
  await heading('账号信息')
  const malformed = await page.evaluate(() =>
    window.mix.me.createVerifiedConnection({
      apiKey: 'synthetic',
      providerId: 'deepseek',
      requestId: crypto.randomUUID(),
      ownerId: 'forged'
    })
  )
  assert.equal(malformed.ok, false)
  assert.equal(malformed.error.code, 'invalid_input')
  await button('注销账号').click()
  await page.getByLabel('当前密码', { exact: true }).fill('wrong')
  await dialogButton('验证身份并继续').click()
  await page.getByText('请检查当前密码后重试。账号和数据尚未删除。', { exact: true }).waitFor()
  assert.equal(await fixture(() => globalThis.__meFixture.deleting), false)
  await page.getByLabel('当前密码', { exact: true }).fill('FixtureOnly!2026')
  await dialogButton('验证身份并继续').click()
  await dialogButton('注销账号').click()
  await heading('正在注销账号')
  assert.equal(await page.getByText('账号已注销', { exact: true }).count(), 0)
  assert.equal(
    (await readdir(vaultRoot)).some((s) => /^[a-f0-9]{64}$/.test(s)),
    false
  )
  await screenshot('07-deletion-processing')
  await application.close()
  application = null
  await launch()
  // The server fixture resets at process start. Rehydrate only its synthetic receipt
  // response from the encrypted local receipt; this is not a real worker completion.
  await fixture(() => globalThis.__meRestoreServerReceipt())
  await page.reload()
  await heading('正在注销账号')
  assert.equal(errors.length, 0, errors.join('\n'))
  passed.push(
    'Strict IPC rejects owner injection; shared-account scope, password failure, accepted processing and encrypted receipt recovery'
  )
  console.log(
    JSON.stringify(
      {
        passed,
        checks: passed.length,
        errors,
        evidence,
        temp,
        boundary:
          'Synthetic Auth/functions/provider responses; actual Electron, SDK, IPC, OS safeStorage and DOM. Shared SQL/worker tested separately; no production or real deletion evidence.'
      },
      null,
      2
    )
  )
} finally {
  if (application) await application.close()
}
