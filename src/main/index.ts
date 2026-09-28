import { app, BrowserWindow, Menu, powerMonitor, safeStorage, session } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readAuthConfig } from './auth/config'
import { SecureSessionStorage } from './auth/secure-storage'
import { createAuthRuntime } from './auth/client'
import { AuthService } from './auth/service'
import { registerAuthIpc } from './auth/ipc'

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
const rendererUrl =
  !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).href
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'Mix',
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
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

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  let lastFocusCheck = Date.now()
  mainWindow.on('focus', () => {
    if (Date.now() - lastFocusCheck > 60000) {
      lastFocusCheck = Date.now()
      void service.retry(true)
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
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.on('before-quit', () => {
    removeIpc()
    service.dispose()
  })
  powerMonitor.on('resume', () => {
    void service.retry()
  })
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
