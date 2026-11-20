import type { IpcMainInvokeEvent, BrowserWindow } from 'electron'
export function trustedSender(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  expected: string,
): boolean {
  return (
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame?.url === expected
  )
}
