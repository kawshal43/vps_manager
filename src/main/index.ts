import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  session,
  type MenuItemConstructorOptions,
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SettingsRepository } from '../infrastructure/persistence/store'
import { registerApi } from './ipc/register'

// E2E uses a separate data directory; it never reads or writes real connection profiles.
if (process.env.VPS_MANAGER_TEST_DATA) app.setPath('userData', process.env.VPS_MANAGER_TEST_DATA)
let window: BrowserWindow | null = null
let runtime: Awaited<ReturnType<typeof registerApi>> | undefined
let repository: SettingsRepository
let exiting = false
let closingWrites: Promise<void> = Promise.resolve()
app.on('before-quit', (event) => {
  if (!exiting && repository) {
    event.preventDefault()
    void Promise.all([repository.flush(), runtime?.flush(), closingWrites])
      .catch(() => {})
      .finally(() => {
        exiting = true
        app.quit()
      })
  }
})
async function createWindow(): Promise<void> {
  const preferences = repository.preferences()
  window = new BrowserWindow({
    width: preferences.width,
    height: preferences.height,
    minWidth: 960,
    minHeight: 640,
    title: 'VPS Manager',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#142235', symbolColor: '#e8f0fa', height: 38 },
    backgroundColor: '#f7f8fa',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })
  Menu.setApplicationMenu(null)
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable)
      items.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
      )
    items.push({ role: 'copy', enabled: params.editFlags.canCopy })
    if (params.isEditable)
      items.push(
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      )
    Menu.buildFromTemplate(items).popup({ window: window! })
  })
  const url =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL
      : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const allowed = new URL(url)
  if (
    allowed.protocol !== 'file:' &&
    (allowed.protocol !== 'http:' ||
      (allowed.hostname !== '127.0.0.1' && allowed.hostname !== 'localhost'))
  )
    throw new Error('Unsafe renderer origin')
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  // Chromium canonicalizes a bare HTTP origin by adding '/'. Trust the same
  // canonical URL that we load, including when electron-vite omits that slash.
  runtime = await registerApi(window, allowed.href, repository)
  window.once('ready-to-show', () => window?.show())
  let approvedClose = false
  let closingAttempt = false
  window.webContents.on('will-prevent-unload', (event) => {
    if (
      approvedClose ||
      dialog.showMessageBoxSync(window!, {
        type: 'warning',
        message: 'Discard unsaved editor changes?',
        buttons: ['Keep editing', closingAttempt ? 'Discard and close' : 'Discard and reload'],
        defaultId: 0,
        cancelId: 0,
      }) === 1
    )
      event.preventDefault()
    else closingAttempt = false
  })
  window.on('close', (event) => {
    if (
      runtime?.websites.runningCount() &&
      dialog.showMessageBoxSync(window!, {
        type: 'warning',
        message: 'Website deployments are still running.',
        detail:
          'Closing can interrupt builds or activation. Keep the app open until verification finishes, or inspect server state before recovery after closing.',
        buttons: ['Keep open', 'Close application'],
        defaultId: 0,
        cancelId: 0,
      }) === 0
    ) {
      event.preventDefault()
      return
    }
    if (
      !approvedClose &&
      runtime?.dirtyCount() &&
      dialog.showMessageBoxSync(window!, {
        type: 'warning',
        message: 'You have unsaved editor changes.',
        detail: 'Closing VPS Manager discards these changes.',
        buttons: ['Keep editing', 'Discard and close'],
        defaultId: 0,
        cancelId: 0,
      }) === 0
    ) {
      event.preventDefault()
      return
    }
    const active = runtime?.transfers
      .list()
      .some((j) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(j.status))
    if (
      active &&
      dialog.showMessageBoxSync(window!, {
        type: 'warning',
        message: 'Transfers are still running.',
        detail:
          'Closing VPS Manager cancels active transfers. Temporary files may need cleanup after a connection loss.',
        buttons: ['Keep open', 'Cancel transfers and close'],
        defaultId: 0,
        cancelId: 0,
      }) === 0
    ) {
      event.preventDefault()
      return
    }
    // A beforeunload handler can still catch an edit made before its IPC update arrived.
    approvedClose = !!runtime?.dirtyCount()
    closingAttempt = true
    if (window && !window.isMaximized()) {
      const [width, height] = window.getSize()
      void repository
        .updatePreferences({ ...repository.preferences(), width, height })
        .catch(() => {})
    }
  })
  window.on('closed', () => {
    closingWrites = runtime?.flush() ?? Promise.resolve()
    runtime?.dispose()
    runtime = undefined
    window = null
  })
  await window.loadURL(allowed.href)
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  void app
    .whenReady()
    .then(async () => {
      repository = new SettingsRepository(app.getPath('userData'))
      await repository.load()
      await createWindow()
      app.on('activate', () => {
        if (!window) void createWindow()
      })
    })
    .catch(() => {
      dialog.showErrorBox(
        'VPS Manager could not start',
        'Application initialization failed. Local settings were preserved. Check settings.json in the application data directory.',
      )
      app.quit()
    })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
