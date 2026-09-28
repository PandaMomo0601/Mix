import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { AUTH_CHANNELS } from '../../shared/auth'
import { failure } from '../../shared/auth-errors'
import { normalizeEmail, parseCredentials } from '../../shared/validation'
import type { AuthService } from './service'

export function isTrustedSender(
  sender: { windowId: number; frameIsMain: boolean; url: string },
  expected: { windowId: number; url: string }
): boolean {
  return sender.windowId === expected.windowId && sender.frameIsMain && sender.url === expected.url
}

export function registerAuthIpc(
  service: AuthService,
  getWindow: () => BrowserWindow | null,
  rendererUrl: string
): () => void {
  function trusted(event: IpcMainInvokeEvent): void {
    const window = getWindow()
    if (
      !window ||
      window.isDestroyed() ||
      !isTrustedSender(
        {
          windowId: event.sender.id,
          frameIsMain: event.senderFrame === window.webContents.mainFrame,
          url: event.senderFrame?.url ?? ''
        },
        { windowId: window.webContents.id, url: rendererUrl }
      )
    )
      throw new Error('Unauthorized auth request')
  }
  const invalid = { ok: false, error: failure('invalid-input') }
  const handlers: Record<string, (value: unknown) => unknown> = {
    [AUTH_CHANNELS.state]: () => service.getState(),
    [AUTH_CHANNELS.signIn]: (value) => {
      const c = parseCredentials(value)
      return c ? service.signIn(c) : invalid
    },
    [AUTH_CHANNELS.signUp]: (value) => {
      const c = parseCredentials(value)
      return c ? service.signUp(c) : invalid
    },
    [AUTH_CHANNELS.resend]: (value) => {
      const e = normalizeEmail(value)
      return e ? service.resendConfirmation(e) : invalid
    },
    [AUTH_CHANNELS.recover]: (value) => {
      const e = normalizeEmail(value)
      return e ? service.requestPasswordReset(e) : invalid
    },
    [AUTH_CHANNELS.retry]: () => service.retry(),
    [AUTH_CHANNELS.signOut]: () => service.signOut()
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, value) => {
      trusted(event)
      return handler(value)
    })
  }
  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed() && window.webContents.getURL() === rendererUrl)
      window.webContents.send(AUTH_CHANNELS.changed, snapshot)
  })
  return () => {
    unsubscribe()
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
