import { app, BrowserWindow, Menu, powerMonitor, safeStorage, session, screen } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readAuthConfig } from './auth/config'
import { SecureSessionStorage } from './auth/secure-storage'
import { createAuthRuntime } from './auth/client'
import { AuthService } from './auth/service'
import { registerAuthIpc } from './auth/ipc'
import { WindowStateFile, restoreWindowPreference } from './window-state'
import { CredentialStore } from './me/credential-store'
import { MeService } from './me/service'
import { registerMeIpc } from './me/ipc'

app.setName('Mix')
if (!app.isPackaged) {
  const dataPath = join(app.getPath('appData'), 'Mix Development')
  mkdirSync(dataPath, { recursive: true, mode: 0o700 })
  app.setPath('userData', dataPath)
}
const ownsLock = app.requestSingleInstanceLock()
if (!ownsLock) app.quit()

let mainWindow: BrowserWindow | null = null
let service: AuthService
let meService: MeService
let windowState: WindowStateFile
const rendererUrl =
  !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).href
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href

function createWindow(): void {
  const restored = restoreWindowPreference(
    windowState.read(),
    screen.getAllDisplays(),
    screen.getPrimaryDisplay().id
  )
  mainWindow = new BrowserWindow({
    title: 'Mix',
    ...restored.bounds,
    minWidth: restored.minWidth,
    minHeight: restored.minHeight,
    show: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  const current = mainWindow
  let maximized = restored.maximized
  let timer: ReturnType<typeof setTimeout> | undefined
  const persist = (): void => {
    if (current.isDestroyed()) return
    const normalBounds = current.getNormalBounds()
    windowState.write({
      schemaVersion: 1,
      normalBounds,
      maximized,
      displayId: screen.getDisplayMatching(normalBounds).id
    })
  }
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(persist, 300)
  }
  current.on('resize', schedule)
  current.on('move', schedule)
  current.on('maximize', () => {
    maximized = true
    schedule()
  })
  current.on('unmaximize', () => {
    maximized = false
    schedule()
  })
  current.on('close', () => {
    clearTimeout(timer)
    persist()
  })
  current.once('ready-to-show', () => {
    if (restored.maximized) current.maximize()
    current.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  let lastFocusCheck = Date.now()
  mainWindow.on('focus', () => {
    if (Date.now() - lastFocusCheck > 60000) {
      lastFocusCheck = Date.now()
      void service.retry(true)
      if (service.getState().status === 'signed-in') void service.refreshProfile()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  void mainWindow.loadURL(rendererUrl)
}

void app.whenReady().then(() => {
  if (!ownsLock) return
  app.setAppUserModelId('com.mix.desktop')
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ])
  )

  const config = readAuthConfig(import.meta.env)
  windowState = new WindowStateFile(join(app.getPath('userData'), 'window-state.v1.json'))
  const projectKey = createHash('sha256')
    .update(config?.url ?? 'unconfigured')
    .digest('hex')
    .slice(0, 16)
  const storagePath = join(app.getPath('userData'), 'auth', `${projectKey}.enc`)
  const makeStorage = (): SecureSessionStorage =>
    new SecureSessionStorage(storagePath, {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptStringAsync(value),
      decrypt: (value) => safeStorage.decryptStringAsync(value)
    })
  service = new AuthService(
    config,
    async () => {
      const storage = makeStorage()
      await storage.load()
      return createAuthRuntime(config!, storage)
    },
    () => makeStorage().clear()
  )
  const removeIpc = registerAuthIpc(service, () => mainWindow, rendererUrl)
  const vault = new CredentialStore(join(app.getPath('userData'), 'me-credentials'), projectKey, {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: (value) => safeStorage.decryptStringAsync(value)
  })
  meService = new MeService(service, config, vault)
  const removeMeIpc = registerMeIpc(meService, service, () => mainWindow, rendererUrl)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.on('before-quit', () => {
    removeIpc()
    removeMeIpc()
    meService.dispose()
    service.dispose()
  })
  powerMonitor.on('resume', () => {
    void service.retry(true)
  })
  const fitWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const window = mainWindow
    const current = window.getNormalBounds()
    const fitted = restoreWindowPreference(
      { schemaVersion: 1, normalBounds: current, maximized: window.isMaximized() },
      screen.getAllDisplays(),
      screen.getPrimaryDisplay().id
    )
    window.setMinimumSize(fitted.minWidth, fitted.minHeight)
    if (JSON.stringify(fitted.bounds) !== JSON.stringify(current)) {
      const wasMaximized = window.isMaximized()
      if (wasMaximized) window.unmaximize()
      window.setBounds(fitted.bounds)
      if (wasMaximized) window.maximize()
    }
  }
  screen.on('display-removed', fitWindow)
  screen.on('display-metrics-changed', fitWindow)
  createWindow()
  void service.retry()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
