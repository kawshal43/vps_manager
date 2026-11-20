import { ipcRenderer, webUtils } from 'electron'
import type { AppEvent, DesktopApi } from '../shared/contracts/api'
export const api: DesktopApi = {
  invoke: (route, input) => ipcRenderer.invoke('vps:invoke', route, input),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AppEvent): void =>
      listener(payload)
    ipcRenderer.on('vps:event', handler)
    return () => ipcRenderer.removeListener('vps:event', handler)
  },
  droppedFiles: (files) =>
    ipcRenderer.invoke(
      'vps:drop',
      files.map((file) => webUtils.getPathForFile(file)),
    ),
}
