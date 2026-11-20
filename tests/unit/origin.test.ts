import { describe, expect, it } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { trustedSender } from '../../src/main/security/origin'

function fixture(actual = 'http://127.0.0.1:5173/') {
  const frame = { url: actual }
  const contents = { mainFrame: frame }
  return {
    event: { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    window: { webContents: contents } as unknown as BrowserWindow,
  }
}
describe('IPC origin boundary', () => {
  it('accepts the owned main frame at the normalized development URL', () => {
    const { event, window } = fixture()
    expect(trustedSender(event, window, new URL('http://127.0.0.1:5173').href)).toBe(true)
  })
  it.each([
    'http://localhost:5173/',
    'http://127.0.0.1:5174/',
    'http://127.0.0.1:5173/other',
    'https://attacker.example/',
    'file:///C:/other/index.html',
  ])('rejects another address or document: %s', (actual) => {
    const { event, window } = fixture(actual)
    expect(trustedSender(event, window, 'http://127.0.0.1:5173/')).toBe(false)
  })
  it('rejects another window even when its URL matches', () => {
    const { event, window } = fixture()
    expect(
      trustedSender(
        { ...event, sender: {} } as IpcMainInvokeEvent,
        window,
        'http://127.0.0.1:5173/',
      ),
    ).toBe(false)
  })
  it('rejects child frames and missing frames', () => {
    const { event, window } = fixture()
    expect(
      trustedSender(
        { ...event, senderFrame: { url: event.senderFrame!.url } } as IpcMainInvokeEvent,
        window,
        'http://127.0.0.1:5173/',
      ),
    ).toBe(false)
    expect(trustedSender({ ...event, senderFrame: null }, window, 'http://127.0.0.1:5173/')).toBe(
      false,
    )
  })
})
