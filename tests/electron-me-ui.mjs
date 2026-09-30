import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const mainEntry = process.env.MIX_UI_MAIN || join(root, 'out/main/index.js')
const baseline = JSON.parse(
  await readFile(join(root, 'tests/fixtures/me-ui-baseline.json'), 'utf8')
)
const temp = await mkdtemp(join(tmpdir(), 'mix-me-ui-qa-'))
const evidence =
  process.env.MIX_EVIDENCE_DIR || join(root, 'output/playwright/me-ui-20260929/final')
await mkdir(evidence, { recursive: true })
const boot = join(temp, 'launch.cjs')
await writeFile(
  boot,
  `const {app,ipcMain}=require('electron');app.setPath('appData',${JSON.stringify(temp)});const f=require(${JSON.stringify(join(root, 'tests/fixtures/me-server.cjs'))});f.state.user.email='linmu@example.com';f.state.user.user_metadata.nickname='林沐';f.state.user.user_metadata.avatar={emoji:'🤖',bg:'#FFE4E1'};globalThis.__meFixture=f.state;require(${JSON.stringify(join(root, 'tests/fixtures/me-ui-bridge.cjs'))}).install(ipcMain,f.state);globalThis.fetch=f.fakeFetch;require(${JSON.stringify(mainEntry)});`
)
const app = await _electron.launch({
  args: [boot],
  timeout: 90000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
})
const page = await app.firstWindow()
const win = await app.browserWindow(page)
page.setDefaultTimeout(15000)
const errors = [],
  checks = [],
  dialogs = new Map(baseline.frames.map((f) => [f.id, f]))
page.on('pageerror', (error) => errors.push(error.message))
const b = (name) => page.getByRole('button', { name, exact: true })
const db = (name) => page.getByRole('dialog').getByRole('button', { name, exact: true })
const field = (name) => page.getByLabel(name, { exact: true })
const feedback = (name) =>
  page.locator('.mix-feedback').getByText(name, { exact: true }).first().waitFor()
const fixture = (fn) => app.evaluate(fn)
async function override(channel, result, hold = false) {
  await app.evaluate(
    (_electron, a) => {
      globalThis.__meFixture.uiResponses[a.channel] = { result: a.result, hold: a.hold, once: true }
    },
    { channel, result, hold }
  )
}
async function release() {
  await fixture(() => {
    const f = globalThis.__meFixture
    f.release()
    f.release = null
  })
}
async function resize(w = 1100, h = 728, zoom = 1) {
  await win.evaluate(
    (w, a) => {
      w.setContentSize(a.w, a.h)
      w.webContents.setZoomFactor(a.zoom)
    },
    { w, h, zoom }
  )
  await page.waitForFunction(({ w, zoom }) => Math.abs(innerWidth - w / zoom) < 2, { w, zoom })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)))
}
async function close() {
  if (await page.getByRole('dialog').count()) await db('关闭').click()
}
async function capture(id, skip = []) {
  const spec = dialogs.get(id)
  assert.ok(spec, id)
  const nativeTitlebar = ['31:44', '31:50', '31:51', '31:52', '31:53', '31:54'].includes(id)
  const contentHeight = spec.h - (nativeTitlebar ? 0 : 32)
  if (spec.w >= 640) await resize(spec.w, contentHeight)
  else await resize(spec.w * 2, contentHeight * 2, 2)
  await page.evaluate(() => document.activeElement?.blur())
  await page.mouse.move(0, 0)
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  )
  const d = spec.dialogs[0]
  const geometry = await page.evaluate(() => {
    const el = document.querySelector('dialog[open]'),
      rect = (n) => {
        const r = n.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      }
    const noOverflow = document.documentElement.scrollWidth <= innerWidth
    if (!el) {
      const empty = document.querySelector('.me-empty'),
        list = document.querySelector('.me-key-list'),
        result = document.querySelector('.auth-viewport.me-result .auth-column'),
        main = document.querySelector('.me-main')
      return {
        noOverflow,
        viewport: { w: innerWidth, h: innerHeight },
        dialog: null,
        empty: empty && {
          ...rect(empty),
          background: getComputedStyle(empty).backgroundColor,
          alignment: getComputedStyle(empty).textAlign
        },
        list: list && {
          ...rect(list),
          rows: list.children.length,
          clip: getComputedStyle(list).overflow
        },
        result: result && {
          ...rect(result),
          gap: getComputedStyle(result).gap,
          headingGap: getComputedStyle(result.querySelector('header')).gap
        },
        mainPadding: main && getComputedStyle(main).paddingTop,
        actions: [...document.querySelectorAll('.me-list-retry,.me-read-error-logout')].map(
          (n) => ({ text: n.innerText, ...rect(n) })
        )
      }
    }
    const body = el.querySelector('.me-dialog-body'),
      content = el.querySelector('.me-dialog-content'),
      footer = el.querySelector('footer')
    const s = getComputedStyle(content),
      bs = getComputedStyle(body),
      r = rect(el),
      f = rect(footer)
    return {
      noOverflow,
      viewport: { w: innerWidth, h: innerHeight },
      dialog: r,
      header: rect(el.querySelector('header')),
      footer: f,
      body: rect(body),
      content: rect(content),
      padding: [s.paddingTop, bs.paddingLeft, s.paddingLeft],
      horizontal: el.scrollWidth <= el.clientWidth,
      footerFits: f.bottom <= innerHeight || f.y + f.h <= innerHeight,
      inputHeights: [...el.querySelectorAll('.mix-input')].map((n) => rect(n).h),
      buttons: [...footer.querySelectorAll('button')].map((n) => ({
        text: n.innerText,
        w: rect(n).w,
        h: rect(n).h,
        disabled: n.disabled,
        opacity: getComputedStyle(n).opacity
      })),
      background: getComputedStyle(el).backgroundColor,
      borderRadius: getComputedStyle(el).borderRadius
    }
  })
  assert.equal(geometry.noOverflow, true, `${id}: page horizontal overflow`)
  if (id === '31:5') {
    assert.equal(geometry.empty.h, 190, 'empty list follows Figma 190px layout')
    assert.equal(geometry.empty.background, 'rgb(250, 250, 250)')
    assert.equal(geometry.empty.alignment, 'left')
  }
  if (id === '31:4') {
    assert.equal(geometry.list.h, 293, 'three 96px rows, separators and frame stroke')
    assert.equal(geometry.list.clip, 'visible', 'Figma list does not clip its rows')
  }
  if (id === '31:62') assert.equal(geometry.mainPadding, '48px')
  for (const action of geometry.actions || [])
    assert.equal(action.w, action.text === '退出当前设备' ? 148 : 112)
  if (['31:42', ...['31:44', '31:50', '31:51', '31:52', '31:53', '31:54']].includes(id)) {
    assert.ok(geometry.result, `${id}: account operation result screen`)
    assert.equal(geometry.result.w, 440)
    assert.equal(geometry.result.gap, '24px')
    assert.equal(geometry.result.headingGap, '24px')
    assert.equal(geometry.result.y, (geometry.viewport.h - geometry.result.h) / 2)
  }
  if (d) {
    assert.ok(geometry.dialog, `${id}: missing modal`)
    const r = geometry.dialog
    assert.equal(r.w, d.w, `${id}: modal width`)
    assert.equal(r.h, d.h, `${id}: modal height`)
    assert.equal(r.x, (geometry.viewport.w - d.w) / 2, `${id}: centered x`)
    assert.equal(r.y, (geometry.viewport.h - d.h) / 2, `${id}: centered y`)
    assert.equal(geometry.header.h, 68, `${id}: header`)
    assert.equal(geometry.footer.h, 76, `${id}: footer`)
    assert.equal(geometry.horizontal, true, `${id}: modal horizontal overflow`)
    assert.equal(geometry.footerFits, true, `${id}: footer is visible`)
    for (const height of geometry.inputHeights) assert.equal(height, 44, `${id}: input height`)
    for (const expected of d.buttons || []) {
      const actual = geometry.buttons.find((n) => n.text === expected.text)
      assert.ok(actual, `${id}: footer button ${expected.text}`)
      assert.equal(actual.w, expected.w, `${id}: ${expected.text} width`)
      assert.equal(actual.h, 44, `${id}: ${expected.text} height`)
      if (['Disabled', 'Loading'].includes(expected.state))
        assert.equal(actual.disabled, true, `${id}: ${expected.text} state`)
    }
    assert.equal(geometry.background, 'rgb(255, 255, 255)')
    assert.equal(geometry.borderRadius, '12px')
    const text = await page
      .getByRole('dialog')
      .evaluate(
        (el) =>
          el.innerText +
          '\n' +
          [...el.querySelectorAll('input,textarea')]
            .map((i) =>
              i.type === 'password' && i.value ? '••••••••••••••••' : i.value || i.placeholder
            )
            .join('\n')
      )
    const compact = (s) => s.replace(/\s/g, '')
    for (const expected of d.texts) {
      if (
        !expected ||
        /^•+$/.test(expected) ||
        ['林沐', '🤖', '演示凭据 · 不可用于真实调用'].includes(expected) ||
        skip.includes(expected)
      )
        continue
      assert.ok(compact(text).includes(compact(expected)), `${id}: missing ${expected}`)
    }
  }
  const screenshotPath = join(evidence, id.replace(':', '-') + '.png')
  await page.screenshot({
    path: screenshotPath,
    animations: 'disabled',
    caret: 'hide'
  })
  if (spec.w < 640) {
    // Chromium's CSS screenshot clip omits the page zoom factor. Native capture
    // includes the entire window, which the comparison normalizes to CSS pixels.
    const png = await win.evaluate(async (w) =>
      (await w.webContents.capturePage()).toPNG().toString('base64')
    )
    await writeFile(screenshotPath, Buffer.from(png, 'base64'))
  }
  checks.push({ id, name: spec.name, status: 'passed', geometry })
  console.log(JSON.stringify({ checked: id, total: checks.length }))
}
async function tab(name) {
  await b(name).click()
  if (name === 'API Key')
    await page.locator('.me-key-list,.me-empty,.mix-feedback').first().waitFor()
  else await page.locator('.me-profile-summary').waitFor()
}
async function resetProfile() {
  await fixture(() => {
    const f = globalThis.__meFixture
    f.user.user_metadata.nickname = '林沐'
    f.user.user_metadata.avatar = { emoji: '🤖', bg: '#FFE4E1' }
    f.user.email_confirmed_at = '2026-09-28T00:00:00Z'
  })
  await page.evaluate(() => window.mix.me.refreshProfile())
}
async function keyAdd() {
  await b('添加接入').click()
}
async function manage() {
  await b('管理 DeepSeek').click()
}
function failure(code) {
  return { ok: false, error: { code, message: '仅用于 UI 合约状态验收。' } }
}
async function listResult() {
  return page.evaluate(async () => {
    const r = await window.mix.me.listConnections()
    if (!r.ok) throw Error('list')
    return r.data
  })
}
async function keyResult(outcome = 'saved') {
  const data = await listResult()
  const connection = { ...data.connections[0] }
  if (outcome === 'partial') connection.localCredentialState = 'error'
  return {
    ok: true,
    data: { connection, outcome, requestId: crypto.randomUUID() }
  }
}
async function resetList() {
  await close()
  await resize()
  await fixture(() => {
    const f = globalThis.__meFixture
    f.connections = f.originalConnections.map((c) => ({ ...c }))
    f.keys = { ...f.originalKeys }
  })
  await tab('账号信息')
  await tab('API Key')
  await page.locator('.me-key-row').nth(2).waitFor()
}
async function listOverride(change) {
  const l = await listResult()
  change(l)
  await override('me:list', { ok: true, data: l })
  await tab('账号信息')
  await tab('API Key')
}
try {
  await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor()
  await field('邮箱地址').fill('linmu@example.com')
  await field('密码').fill('FixtureOnly!2026')
  await b('登录').click()
  await page.locator('.me-account-data').waitFor()
  await resize()
  assert.deepEqual(
    await page.locator('.me-profile-summary').evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      avatar: el.querySelector('.mix-avatar').getBoundingClientRect().width
    })),
    { height: 98, avatar: 44 }
  )
  await capture('31:3')
  assert.equal(
    await page.locator('.me-avatar-overlay').evaluate((el) => getComputedStyle(el).opacity),
    '0'
  )
  // Pointer hover and the editing entry are covered by electron-me.mjs. This
  // runner captures the approved default frame without native focus races.
  for (const kind of ['nickname', 'avatar']) {
    const nick = kind === 'nickname',
      label = nick ? '修改昵称' : '更换头像',
      save = nick ? '保存昵称' : '保存头像'
    const ids = nick
      ? ['89:3297', '89:3298', '89:3301', '89:3302', '89:3303', '89:3304', '89:3305']
      : ['89:3307', '89:3308', '89:3309', '89:3310', '89:3311', '89:3312', '89:3313']
    const channel = nick ? 'me:nickname' : 'me:avatar'
    await b(label).click()
    assert.equal(await db(save).isDisabled(), true)
    await capture(ids[0])
    if (nick) {
      await field('昵称').fill('')
      await db(save).click()
      await capture('89:3299')
      const longExample = dialogs
        .get('89:3300')
        .dialogs[0].texts.find((t) => t.startsWith('这是一个用于演示'))
      // The design's illustrative string is 39 code points; exercise the approved >40 boundary.
      await field('昵称').fill(longExample + '示例')
      await db(save).click()
      await page.getByText('昵称不能超过40个字符，请缩短后保存。', { exact: true }).waitFor()
      await capture('89:3300', [longExample])
      await field('昵称').fill('林沐')
    } else {
      assert.equal(
        await page.getByRole('group', { name: '预设头像' }).getByRole('button').count(),
        28
      )
    }
    await capture(ids[1])
    if (nick) await field('昵称').fill('林沐1')
    else await b('选择头像 🦊').click()
    await override(channel, failure('provider_unavailable'))
    await db(save).click()
    await feedback(nick ? '昵称未保存' : '头像未保存')
    // Match the design's unchanged draft and its disabled Save variant. A
    // changed, retryable draft is exercised independently in electron-me.mjs.
    if (nick) await field('昵称').fill('林沐')
    else await b('选择头像 🤖').click()
    await capture(ids[3])
    if (!nick) await capture('89:3316')
    await resize()
    if (nick) await field('昵称').fill('林沐1')
    else await b('选择头像 🦊').click()
    await override(channel, failure('unknown'))
    await db(save).click()
    await feedback(nick ? '暂时无法确认昵称是否已保存' : '暂时无法确认头像是否已保存')
    await capture(ids[4])
    await close()
    await resetProfile()
    await b(label).click()
    await fixture(() => {
      const f = globalThis.__meFixture
      f.user.user_metadata.nickname = '其他设备昵称'
      f.user.user_metadata.avatar = { emoji: '🐼', bg: '#e8f5e9' }
    })
    await page.evaluate(() => window.mix.me.refreshProfile())
    await capture(ids[5])
    await db('使用最新资料').click()
    await close()
    await resetProfile()
    await b(label).click()
    if (nick) await field('昵称').fill('林沐1')
    else await b('选择头像 🦊').click()
    const profile = await page.evaluate(async () => {
      const r = await window.mix.me.refreshProfile()
      if (!r.ok) throw Error('profile')
      return r.data
    })
    if (nick) {
      profile.nickname = '林沐1'
      profile.displayName = '林沐1'
    } else profile.avatar = { emoji: '🦊', bg: '#ffcc80' }
    await override(channel, { ok: true, data: { outcome: 'saved', profile } }, true)
    await db(save).click()
    await feedback(nick ? '正在保存昵称' : '正在保存头像')
    await capture(ids[2])
    await capture(nick ? '94:4831' : '94:4833')
    await release()
    await feedback(nick ? '昵称已更新' : '头像已更新')
    await capture(ids[6])
    await capture(nick ? '94:4832' : '94:4834')
    await db('完成').click()
    await resize()
    await resetProfile()
    await b(label).click()
    await capture(nick ? '89:3314' : '89:3315')
    if (!nick) await capture('89:3317')
    await close()
    await resize()
    if (nick) {
      await b(label).click()
      await field('昵称').fill('林沐1')
      await override(channel, { ok: true, data: { outcome: 'syncing', profile } })
      await db(save).click()
      await feedback('昵称已保存，页面暂未刷新')
      await capture('89:3306')
      await close()
    }
  }
  await resetProfile()
  await capture('31:56')
  await resize()
  await fixture(() => {
    const f = globalThis.__meFixture
    f.user.user_metadata.nickname = 'Mix 用户'
    f.user.user_metadata.avatar = null
    f.user.email_confirmed_at = null
  })
  await page.evaluate(() => window.mix.me.refreshProfile())
  await capture('31:40')
  await resetProfile()
  await fixture(() => {
    const f = globalThis.__meFixture
    f.user.user_metadata.nickname =
      '林沐与机器人一起探索世界记录每一个值得留住的灵感和想法让对话保持清晰简单而自然可读'
    f.user.email = 'linmu.with.a.long.display.name@example-company.test'
  })
  await page.evaluate(() => window.mix.me.refreshProfile())
  await capture('31:41')
  await fixture(() => {
    globalThis.__meFixture.user.email = 'linmu@example.com'
  })
  await resetProfile()
  await override('me:profile', failure('provider_unavailable'), true)
  await page.reload()
  await feedback('正在读取账号信息')
  await capture('31:38')
  await release()
  await feedback('账号信息暂时无法读取')
  await capture('31:39')
  await b('重新读取').click()
  await page.locator('.me-profile-summary').waitFor()
  await override('me:list', failure('provider_unavailable'), true)
  await b('API Key').click()
  await feedback('正在读取接入列表')
  await capture('31:35')
  await release()
  await feedback('接入列表暂时无法读取')
  await capture('31:36')
  await b('重新读取').click()
  await page.locator('.me-empty').waitFor()
  await capture('31:5')
  for (const [provider, key] of [
    ['DeepSeek', 'synthetic-ui-4F2A'],
    ['DeepSeek', 'synthetic-ui-7K9C'],
    ['OpenRouter', 'synthetic-ui-2D8F']
  ]) {
    await keyAdd()
    await b('服务商').click()
    await db(provider).click()
    await field('API Key').fill(key)
    await db('验证并保存').click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
  }
  await fixture(() => {
    const f = globalThis.__meFixture
    f.originalConnections = structuredClone(f.connections)
    f.originalKeys = { ...f.keys }
  })
  await resetList()
  await capture('31:4')
  await keyAdd()
  await capture('31:6')
  await b('服务商').click()
  await capture('31:7')
  await db('取消').click()
  assert.equal(await page.getByRole('dialog').getByRole('heading').innerText(), '添加接入')
  await field('API Key').fill('synthetic-ui-TST')
  await capture('31:8')
  await db('显示API Key').click()
  await field('API Key').fill('演示凭据 · 不可用于真实调用')
  await capture('31:9')
  await field('API Key').fill('synthetic-ui-TST')
  await db('隐藏API Key').click()
  await override('me:create', await keyResult(), true)
  await db('验证并保存').click()
  await capture('31:10')
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').isVisible(), true)
  const createdList = await listResult()
  createdList.connections.push({
    ...createdList.connections[0],
    id: '00000000-0000-4000-8000-000000000004',
    displayName: 'DeepSeek2',
    keyHint: '•••• 9B7E',
    displayOrder: 3
  })
  await override('me:list', { ok: true, data: createdList })
  await release()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.locator('.me-key-row').nth(3).waitFor()
  await capture('31:11')
  await resetList()
  const errorStates = [
    ['duplicate_key', '31:26'],
    ['invalid_key', '31:27'],
    ['provider_unavailable', '31:28'],
    ['rate_limited', '31:29'],
    ['duplicate_name', '31:31'],
    ['permission_denied', '46:2633']
  ]
  await keyAdd()
  await db('验证并保存').click()
  await capture('31:25')
  await close()
  for (const [code, id] of errorStates) {
    await keyAdd()
    await field('API Key').fill('synthetic-ui-TST')
    await override('me:create', failure(code))
    await db('验证并保存').click()
    await page.getByRole('alert').waitFor()
    await capture(id)
    assert.equal(await field('API Key').inputValue(), 'synthetic-ui-TST')
    await close()
  }
  await keyAdd()
  await field('API Key').fill('synthetic-ui-TST')
  await override('me:create', failure('limit_reached'))
  await db('验证并保存').click()
  await capture('31:30')
  await db('管理已有接入').click()
  await keyAdd()
  await b('服务商').click()
  await db('OpenAI').click()
  await field('API Key').fill('synthetic-ui-TST')
  await db('验证并保存').click()
  await capture('31:55')
  await db('取消').click()
  assert.equal(await field('API Key').inputValue(), 'synthetic-ui-TST')
  await close()
  await keyAdd()
  await capture('31:58')
  await close()
  await resize()
  await manage()
  await capture('31:12')
  await field('接入名称').fill('工作接入')
  await override('me:update', failure('conflict'))
  await db('保存名称').click()
  await capture('31:33')
  await db('刷新接入').click()
  await override('me:update', await keyResult())
  await db('保存名称').click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await capture('31:13')
  await manage()
  await db('替换 API Key').click()
  await capture('31:14')
  await field('新的 API Key').fill('synthetic-ui-TST')
  await capture('31:15')
  await override('me:update', failure('invalid_key'))
  await db('验证并替换').click()
  await capture('31:32')
  await close()
  await manage()
  await db('替换 API Key').click()
  await field('新的 API Key').fill('synthetic-ui-TST')
  await override('me:update', await keyResult(), true)
  await db('验证并替换').click()
  await capture('31:16')
  await release()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await capture('31:17')
  await manage()
  await override('me:revalidate', await keyResult(), true)
  await db('重新验证').click()
  await capture('31:18')
  await release()
  await feedback('验证通过')
  await capture('31:19')
  await capture('71:3975')
  await db('完成').click()
  await resize()
  for (const [code, id] of [
    ['invalid_key', '71:3630'],
    ['provider_unavailable', '71:3746'],
    ['permission_denied', '71:3859']
  ]) {
    await manage()
    await override('me:revalidate', failure(code))
    await db('重新验证').click()
    await page.getByRole('alert').waitFor()
    await capture(id)
    await db('返回管理').click()
    await close()
  }
  await manage()
  await db('删除接入').click()
  await capture('31:20')
  await override('me:delete', failure('provider_unavailable'))
  await db('删除接入').click()
  await capture('31:64')
  await close()
  await manage()
  await db('删除接入').click()
  await override('me:delete', { ok: true, data: { localCleanup: 'done' } })
  const deletedList = await listResult()
  deletedList.connections = deletedList.connections.slice(1)
  await override('me:list', { ok: true, data: deletedList })
  await db('删除接入').click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await capture('31:21')
  await resetList()
  await b('调整顺序').click()
  await capture('31:22')
  await db('下移 1').click()
  await capture('31:23')
  await override('me:reorder', failure('provider_unavailable'))
  await db('保存顺序').click()
  await capture('31:65')
  await db('保存顺序').click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await capture('31:24')
  for (const [moves, edit, saved] of [
    [['下移 2'], '61:2694', '61:2830'],
    [['上移 3', '上移 2'], '61:2931', '61:3061'],
    [['下移 1', '下移 2'], '61:3162', '61:3292'],
    [['上移 3', '上移 2', '下移 2'], '61:3393', '61:3523']
  ]) {
    await resetList()
    await b('调整顺序').click()
    for (const move of moves) await db(move).click()
    await capture(edit)
    await db('保存顺序').click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await capture(saved)
  }
  await resetList()
  await listOverride((l) => {
    l.connections[0].status = 'invalid'
  })
  await capture('31:34')
  await resetList()
  await manage()
  await field('接入名称').fill('DeepSeek-work')
  await override('me:update', await keyResult())
  await override('me:list', failure('provider_unavailable'))
  await db('保存名称').click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await feedback('当前离线')
  await capture('31:37')
  await b('重新连接').click()
  await resetList()
  for (const [state, id] of [
    ['missing', '89:3318'],
    ['stale', '89:3319']
  ]) {
    await listOverride((l) => {
      l.connections[0].localCredentialState = state
    })
    await capture(id)
  }
  await capture('89:3330')
  await b('补填 Key DeepSeek').click()
  await capture('89:3320')
  await field('API Key').fill('synthetic-ui-TST')
  await capture('89:3321')
  await override('me:attach', failure('credential_mismatch'))
  await db('验证并保存到本机').click()
  await capture('89:3323')
  await override('me:attach', failure('provider_unavailable'))
  await db('验证并保存到本机').click()
  await capture('89:3324')
  await override('me:attach', await keyResult(), true)
  await db('重试验证').click()
  await capture('89:3322')
  await release()
  await feedback('本机 Key 已保存')
  await capture('89:3325')
  await db('完成').click()
  await resetList()
  await keyAdd()
  await field('API Key').fill('synthetic-ui-TST')
  await override('me:create', failure('local_key_locked'))
  await db('验证并保存').click()
  await capture('89:3326')
  await close()
  await keyAdd()
  await field('API Key').fill('synthetic-ui-TST')
  await override('me:create', await keyResult('partial'))
  await db('验证并保存').click()
  await capture('89:3327')
  await override('me:recover', await keyResult(), true)
  await db('重试本机保存').click()
  await capture('89:3328')
  await release()
  await feedback('本机保存已恢复')
  await capture('89:3329')
  await db('完成').click()
  await resetList()
  for (const id of ['31:57', '31:60', '31:61', '31:62', '31:63']) await capture(id)
  await resize()
  await tab('账号信息')
  await override('auth:sign-out', { ok: false, error: { code: 'connection', message: 'fixture' } })
  await b('退出当前设备').click()
  await feedback('退出未完成')
  await capture('31:43')
  await override(
    'auth:sign-out',
    { ok: false, error: { code: 'connection', message: 'fixture' } },
    true
  )
  await b('退出当前设备').click()
  await capture('31:42')
  await release()
  await b('退出当前设备').click()
  await page.getByRole('heading', { name: '已退出当前设备', exact: true }).waitFor()
  await capture('31:44')
  await b('前往登录').click()
  await field('邮箱地址').fill('linmu@example.com')
  await field('密码').fill('FixtureOnly!2026')
  await b('登录').click()
  await page.locator('.me-account-data').waitFor()
  await fixture(() => {
    globalThis.__meFixture.deleting = true
  })
  await page.evaluate(() => window.mix.me.refreshProfile())
  await page.getByRole('heading', { name: '登录已失效', exact: true }).waitFor()
  await capture('31:54')
  await fixture(() => {
    globalThis.__meFixture.deleting = false
  })
  await b('前往登录').click()
  await field('邮箱地址').fill('linmu@example.com')
  await field('密码').fill('FixtureOnly!2026')
  await b('登录').click()
  await page.locator('.me-account-data').waitFor()
  await b('注销账号').click()
  await capture('31:45')
  await capture('31:59')
  await resize()
  await field('当前密码').fill('wrong')
  await db('验证身份并继续').click()
  await feedback('身份验证未通过')
  await capture('31:47')
  assert.equal(await fixture(() => globalThis.__meFixture.deleting), false)
  await field('当前密码').fill('FixtureOnly!2026')
  await close()
  await b('注销账号').click()
  await field('当前密码').fill('FixtureOnly!2026')
  await capture('31:46')
  await override('me:reauthenticate-deletion', { ok: true, data: { verified: true } }, true)
  await db('验证身份并继续').click()
  await capture('31:48')
  await release()
  await page.getByRole('heading', { name: '确认永久注销？', exact: true }).waitFor()
  await capture('31:49')
  await db('注销账号').click()
  await page.getByRole('heading', { name: '正在注销账号', exact: true }).waitFor()
  await capture('31:50')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await new Promise((r) => setTimeout(r, 200))
  await override('me:deletion-status', failure('provider_unavailable'))
  await page.reload()
  await page.getByRole('heading', { name: '正在核实注销结果', exact: true }).waitFor()
  await capture('31:51')
  const receipt = await fixture(() => globalThis.__meFixture.deletion.data)
  await override('me:deletion-status', { ok: true, data: { ...receipt, phase: 'needs_attention' } })
  await b('查看处理结果').click()
  await page.getByRole('heading', { name: '注销尚未完成', exact: true }).waitFor()
  await capture('31:52')
  await override('me:deletion-status', { ok: true, data: { ...receipt, phase: 'completed' } })
  await b('重试清理').click()
  await page.getByRole('heading', { name: '账号已注销', exact: true }).waitFor()
  await capture('31:53')
  await b('前往登录').click()
  await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor()
  const expected = baseline.frames.filter((f) => f.id !== '31:2').map((f) => f.id)
  const missing = expected.filter((id) => !checks.some((c) => c.id === id))
  assert.deepEqual(missing, [], 'unverified Figma states')
  assert.deepEqual(errors, [], 'runtime renderer errors')
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify(
      {
        fileKey: baseline.fileKey,
        versionId: baseline.versionId,
        platform: process.platform,
        scope:
          'Real macOS Electron renderer with synthetic API/IPC contract states; no production service claims',
        checks,
        total: checks.length,
        unique: new Set(checks.map((c) => c.id)).size,
        missing,
        errors
      },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({
      passed: checks.length,
      unique: new Set(checks.map((c) => c.id)).size,
      evidence
    })
  )
} catch (error) {
  const png = await win
    .evaluate(async (w) => (await w.webContents.capturePage()).toPNG().toString('base64'))
    .catch(() => null)
  if (png) await writeFile(join(evidence, 'failure.png'), Buffer.from(png, 'base64'))
  console.log(
    JSON.stringify({
      failureState: await page
        .locator('body')
        .innerText()
        .catch(() => null)
    })
  )
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify({ checks, total: checks.length, failed: error.message, errors }, null, 2)
  )
  throw error
} finally {
  await app.close()
}
