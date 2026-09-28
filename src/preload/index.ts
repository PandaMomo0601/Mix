import { contextBridge, ipcRenderer } from 'electron'
import { AUTH_CHANNELS, type AuthBridge, type AuthSnapshot } from '../shared/auth'

const auth: AuthBridge = {
  getState: () => ipcRenderer.invoke(AUTH_CHANNELS.state),
  signIn: (credentials) => ipcRenderer.invoke(AUTH_CHANNELS.signIn, credentials),
  signUp: (credentials) => ipcRenderer.invoke(AUTH_CHANNELS.signUp, credentials),
  resendConfirmation: (email) => ipcRenderer.invoke(AUTH_CHANNELS.resend, email),
  requestPasswordReset: (email) => ipcRenderer.invoke(AUTH_CHANNELS.recover, email),
  retry: () => ipcRenderer.invoke(AUTH_CHANNELS.retry),
  signOut: () => ipcRenderer.invoke(AUTH_CHANNELS.signOut),
  onStateChange: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AuthSnapshot): void =>
      listener(snapshot)
    ipcRenderer.on(AUTH_CHANNELS.changed, handler)
    return () => ipcRenderer.removeListener(AUTH_CHANNELS.changed, handler)
  }
}

contextBridge.exposeInMainWorld('mix', Object.freeze({ auth }))
