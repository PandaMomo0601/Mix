// UI-only contract responses. Normal requests still use the real trusted IPC,
// SDK and local vault. Overrides render difficult-to-trigger states without
// contacting a real service or manipulating anyone's account.
exports.install = (ipcMain, state) => {
  state.uiResponses = {}
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) =>
    handle(channel, async (event, ...args) => {
      const override = state.uiResponses[channel]
      if (!override) return listener(event, ...args)
      if (override.hold)
        await new Promise((resolve) => {
          state.release = resolve
        })
      if (override.once) delete state.uiResponses[channel]
      return structuredClone(override.result)
    })
}
