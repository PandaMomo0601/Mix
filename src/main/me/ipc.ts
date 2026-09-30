import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ME_CHANNELS } from '../../shared/me'
import { isTrustedSender } from '../auth/ipc'
import { MeError, meFailed } from '../../shared/me-errors'
import {
  object,
  parseConnectionInput,
  parseCreate,
  parseCredential,
  requestId,
  positiveInteger,
  normalizeKey,
  normalizeName,
  parseProbe
} from '../../shared/me-validation'
import type { AuthService } from '../auth/service'
import type { MeService } from './service'

export function registerMeIpc(
  service: MeService,
  auth: AuthService,
  getWindow: () => BrowserWindow | null,
  rendererUrl: string
): () => void {
  const handlers: Record<string, (value: unknown) => unknown> = {
    [ME_CHANNELS.listConnections]: () => service.listConnections(),
    [ME_CHANNELS.createVerifiedConnection]: (value) =>
      service.createVerifiedConnection(parseCreate(value)),
    [ME_CHANNELS.attachLocalCredential]: (value) =>
      service.attachLocalCredential(parseCredential(value)),
    [ME_CHANNELS.updateConnection]: (value) => {
      const v = object(value, [
        'id',
        'requestId',
        'expectedRevision',
        'displayName',
        'apiKey',
        'confirmedProbeVersion'
      ])
      if ('displayName' in v === 'apiKey' in v) throw new MeError('invalid_input')
      const c = parseConnectionInput(v)
      return service.updateConnection(
        'apiKey' in v
          ? {
              ...c,
              apiKey: normalizeKey(v.apiKey),
              confirmedProbeVersion: parseProbe(v.confirmedProbeVersion)
            }
          : { ...c, displayName: normalizeName(v.displayName) }
      )
    },
    [ME_CHANNELS.revalidateConnection]: (value) => {
      const v = object(value, [
        'id',
        'requestId',
        'expectedRevision',
        'credentialVersion',
        'confirmedProbeVersion'
      ])
      return service.revalidateConnection({
        ...parseConnectionInput(v),
        credentialVersion: positiveInteger(v.credentialVersion),
        confirmedProbeVersion: parseProbe(v.confirmedProbeVersion)
      })
    },
    [ME_CHANNELS.deleteConnection]: (value) =>
      service.deleteConnection(
        parseConnectionInput(object(value, ['id', 'requestId', 'expectedRevision']))
      ),
    [ME_CHANNELS.reorderConnections]: (value) => {
      const v = object(value, ['requestId', 'ids', 'listRevision'])
      if (
        !Array.isArray(v.ids) ||
        v.ids.length > 20 ||
        new Set(v.ids).size !== v.ids.length ||
        typeof v.listRevision !== 'number' ||
        !Number.isSafeInteger(v.listRevision) ||
        v.listRevision < 0
      )
        throw new MeError('invalid_input')
      return service.reorderConnections({
        requestId: requestId(v.requestId),
        ids: v.ids.map(requestId),
        listRevision: v.listRevision
      })
    },
    [ME_CHANNELS.recoverOperation]: (value) => {
      const v = object(value, ['requestId'])
      return service.recoverOperation({ requestId: requestId(v.requestId) })
    },
    [ME_CHANNELS.getModelOptions]: (value) => {
      const v = object(value, ['id', 'credentialVersion'])
      return service.getModelOptions({
        id: requestId(v.id),
        credentialVersion: positiveInteger(v.credentialVersion)
      })
    },
    [ME_CHANNELS.updateNickname]: (value) => auth.updateNickname(value),
    [ME_CHANNELS.updateAvatar]: (value) => auth.updateAvatar(value),
    [ME_CHANNELS.refreshProfile]: () => auth.refreshProfile(),
    [ME_CHANNELS.reauthenticateForDeletion]: (value) => {
      if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096)
        throw new MeError('invalid_input')
      return auth.reauthenticateForDeletion(value)
    },
    [ME_CHANNELS.requestAccountDeletion]: (value) => {
      const v = object(value, ['requestId', 'password', 'confirmed', 'scopeVersion'])
      if (
        v.confirmed !== true ||
        v.scopeVersion !== 'shared-account-v1' ||
        typeof v.password !== 'string' ||
        !v.password ||
        Buffer.byteLength(v.password) > 4096
      )
        throw new MeError('invalid_input')
      return service.requestAccountDeletion({
        requestId: requestId(v.requestId),
        password: v.password,
        confirmed: true,
        scopeVersion: 'shared-account-v1'
      })
    },
    [ME_CHANNELS.getDeletionStatus]: () => service.getDeletionStatus()
  }
  for (const [channel, handler] of Object.entries(handlers))
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, value: unknown) => {
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
        throw new Error('Unauthorized ME request')
      try {
        return await handler(value)
      } catch (e) {
        return meFailed(e)
      }
    })
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
