import type { Terminal } from '@xterm/xterm'
import { rpc } from '../../app/api'

export function attachTerminalClipboard(
  term: Terminal,
  container: HTMLElement,
  onError: (message: string) => void,
): { dispose: () => void } {
  let disposed = false
  let pending = Promise.resolve()
  const run = (action: () => Promise<void>) => {
    // Finish a copy before a following right-click reads the clipboard.
    pending = pending
      .then(async () => {
        if (disposed) return
        onError('')
        await action()
      })
      .catch(() => {
        if (!disposed) onError('Clipboard access failed. Please try copying or pasting again.')
      })
  }
  const copy = async () => {
    const text = term.getSelection()
    if (!text) return
    await rpc('clipboard.writeText', { text })
    if (!disposed && term.getSelection() === text) term.clearSelection()
  }
  const paste = async () => {
    const text = await rpc('clipboard.readText', {})
    // Use xterm's paste path to preserve newline handling and bracketed paste.
    if (!disposed && text) term.paste(text)
  }
  const rightButton = (event: MouseEvent) => {
    if (event.button !== 2) return
    // Keep right-click local, including when a remote app enables mouse reporting.
    event.preventDefault()
    event.stopPropagation()
  }
  const contextMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    term.focus()
    run(() => (term.hasSelection() ? copy() : paste()))
  }
  container.addEventListener('mousedown', rightButton, true)
  container.addEventListener('mouseup', rightButton, true)
  container.addEventListener('contextmenu', contextMenu, true)
  term.attachCustomKeyEventHandler((event) => {
    const key = event.key.toLowerCase()
    const command = (event.ctrlKey || event.metaKey) && !event.altKey
    const copyKey =
      (command && key === 'c' && (event.shiftKey || term.hasSelection())) ||
      (event.ctrlKey && !event.altKey && !event.metaKey && key === 'insert')
    const pasteKey =
      (command && key === 'v') ||
      (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && key === 'insert')
    if (!copyKey && !pasteKey) return true
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'keydown' && !event.repeat) run(copyKey ? copy : paste)
    return false
  })
  return {
    dispose: () => {
      disposed = true
      container.removeEventListener('mousedown', rightButton, true)
      container.removeEventListener('mouseup', rightButton, true)
      container.removeEventListener('contextmenu', contextMenu, true)
    },
  }
}
