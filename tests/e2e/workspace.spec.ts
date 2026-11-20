import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTestDirectory } from '../../scripts/test-temp'
import { defaultPreferences, type ServerSession } from '../../src/domain/connection/types'
import { defaultWorkspace } from '../../src/shared/workspace'
import { prepareDrop, dropOn } from './fixtures/native-drop'
import { preserveClipboard, restoreClipboard } from './fixtures/clipboard'

const sessions: ServerSession[] = ['Atlas', 'Orion'].map((name, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`,
  state: 'CONNECTED',
  home: '/home/demo',
  hostname: name.toLowerCase(),
  distribution: 'Ubuntu 24.04 LTS',
  architecture: 'x86_64',
  sftp: true,
  profile: {
    id: `00000000-0000-4000-8000-00000000001${i + 1}`,
    displayName: name,
    host: `${name.toLowerCase()}.example.test`,
    port: 22,
    username: 'demo',
    authenticationMethod: 'password',
  },
}))

async function launch(directory: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        key !== 'ELECTRON_RUN_AS_NODE' && key !== 'ELECTRON_RENDERER_URL' && value !== undefined,
    ),
  ) as Record<string, string>
  const app = await electron.launch({
    executablePath:
      process.env.VPS_TEST_EXECUTABLE || resolve('node_modules/electron/dist/electron.exe'),
    args: process.env.VPS_TEST_EXECUTABLE ? [] : [resolve('.')],
    env: { ...env, VPS_MANAGER_TEST_DATA: directory },
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: 'Connect to server', exact: true })).toBeEnabled()
  // Offline presentation fixtures only. The native preload and file-drop grant handler remain real.
  await app.evaluate(
    ({ ipcMain, clipboard }, values) => {
      const fixture = {
        ...values,
        calls: [] as { route: string; input: Record<string, unknown> }[],
        shells: 0,
      }
      Reflect.set(globalThis, '__desktopFixture', fixture)
      ipcMain.removeHandler('vps:invoke')
      ipcMain.handle(
        'vps:invoke',
        async (_event, route: string, input: Record<string, unknown>) => {
          fixture.calls.push({ route, input })
          let value: unknown
          if (route === 'clipboard.readText') value = await clipboard.readText()
          else if (route === 'clipboard.writeText') await clipboard.writeText(input.text as string)
          else if (route === 'app.bootstrap')
            value = {
              profiles: [],
              preferences: fixture.preferences,
              trustedHosts: [],
              sessions: fixture.sessions,
              transfers: [],
              secureStorage: false,
              version: 'fixture',
            }
          else if (route === 'workspace.load') value = { layout: fixture.layout }
          else if (route === 'workspace.save') fixture.layout = input as typeof fixture.layout
          else if (route === 'files.list') {
            const path = input.path as string
            value = {
              path,
              entries: [
                { name: 'projects', type: 'directory', size: 0, mode: 16877 },
                { name: 'notes.txt', type: 'file', size: 17, mode: 33188 },
                { name: 'config.json', type: 'file', size: 26, mode: 33188 },
              ].map((entry) => ({
                ...entry,
                path: `${path}/${entry.name}`,
                mtime: 1780000000,
                uid: 1000,
                gid: 1000,
              })),
            }
          } else if (route === 'files.read' || route === 'files.save')
            value = {
              path: input.path,
              content: route === 'files.save' ? input.content : 'Workspace notes\n',
              identity: { size: 16, mtime: 1, mode: 33188, uid: 1000, gid: 1000, hash: 'fixture' },
              lineEnding: 'LF',
              bom: false,
            }
          else if (route === 'terminal.open') {
            fixture.shells++
            value = `00000000-0000-4000-8000-${String(fixture.shells).padStart(12, '0')}`
          } else if (route === 'monitoring.get')
            value = {
              at: Date.now(),
              cpuPercent: 8.6,
              cpuCount: 4,
              memoryTotal: 8589934592,
              memoryAvailable: 6442450944,
              swapTotal: 0,
              swapFree: 0,
              diskTotal: 107374182400,
              diskUsed: 21474836480,
              uptime: 259200,
              load: [0.12, 0.08, 0.05],
            }
          else if (route === 'services.list')
            value = [
              {
                name: 'ssh.service',
                description: 'OpenSSH server',
                load: 'loaded',
                active: 'active',
                sub: 'running',
              },
            ]
          else if (route === 'logs.read') value = 'Offline UI fixture: journal output'
          else if (route === 'applications.packages') value = { packages: [], at: Date.now() }
          else if (route === 'applications.deployments') value = []
          return { ok: true, value }
        },
      )
    },
    { sessions, preferences: defaultPreferences, layout: defaultWorkspace() },
  )
  await page.reload()
  await expect(page.getByRole('main', { name: 'Server desktop' })).toBeVisible()
  return { app, page }
}
async function switchServer(page: Page, name: string) {
  await page.getByRole('button', { name: 'Server connections', exact: true }).click()
  await page.getByRole('menuitem', { name: new RegExp(name) }).click()
}
async function shellCount(app: ElectronApplication) {
  return app.evaluate(
    () => (Reflect.get(globalThis, '__desktopFixture') as { shells: number }).shells,
  )
}
async function calls(app: ElectronApplication, route: string) {
  return app.evaluate(
    (_electron, name) =>
      (
        Reflect.get(globalThis, '__desktopFixture') as {
          calls: { route: string; input: Record<string, unknown> }[]
        }
      ).calls.filter((call) => call.route === name),
    route,
  )
}

test('desktop windows preserve server state, editor drafts and terminal lifetimes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vps-workspace-ui-'))
  const { app, page } = await launch(directory)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.screenshot({ path: 'test-results/desktop-workspace.png' })
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const files = page.getByRole('region', { name: 'Files window', exact: true })
    await expect(files.getByRole('grid', { name: 'Remote files' })).toBeVisible()
    const initial = (await files.boundingBox())!
    const title = files.getByLabel('Move Files window', { exact: true })
    await title.focus()
    await page.keyboard.press('Control+ArrowRight')
    expect((await files.boundingBox())!.x).toBeGreaterThan(initial.x)
    const box = (await title.boundingBox())!
    await page.mouse.move(box.x + 150, box.y + 18)
    await page.mouse.down()
    await page.mouse.move(box.x + 190, box.y + 45, { steps: 5 })
    await page.mouse.up()
    expect((await files.boundingBox())!.y).toBeGreaterThan(initial.y)
    const resize = (await files.locator('.resize-se').boundingBox())!
    const beforeResize = (await files.boundingBox())!
    await page.mouse.move(resize.x + 5, resize.y + 5)
    await page.mouse.down()
    await page.mouse.move(
      resize.x + 5 + 560 - beforeResize.width,
      resize.y + 5 + 430 - beforeResize.height,
      { steps: 6 },
    )
    await page.mouse.up()
    await expect.poll(async () => Math.round((await files.boundingBox())!.width)).toBe(560)
    const more = (await files
      .getByRole('button', { name: 'More file actions', exact: true })
      .boundingBox())!
    const compact = (await files.boundingBox())!
    expect(more.x + more.width).toBeLessThan(compact.x + compact.width)
    await page.screenshot({ path: 'test-results/desktop-compact-window.png' })
    await files.getByRole('button', { name: 'Maximize Files', exact: true }).click()
    await expect(files).toHaveClass(/is-maximized/)
    await files.getByRole('button', { name: 'Minimize Files', exact: true }).click()
    await expect(files).toBeHidden()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(files).toHaveClass(/is-maximized/)
    await files.getByRole('button', { name: 'Restore Files', exact: true }).click()

    await files.getByRole('row').filter({ hasText: 'projects' }).dblclick()
    await expect(page.getByRole('textbox', { name: 'Remote path', exact: true })).toHaveValue(
      '/home/demo/projects',
    )
    await switchServer(page, 'Orion')
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Remote path', exact: true })).toHaveValue(
      '/home/demo',
    )
    await switchServer(page, 'Atlas')
    await expect(page.getByRole('textbox', { name: 'Remote path', exact: true })).toHaveValue(
      '/home/demo/projects',
    )

    await page.getByRole('row').filter({ hasText: 'notes.txt' }).dblclick()
    const editor = page.getByRole('region', { name: 'notes.txt window', exact: true })
    await editor.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('Unsaved draft')
    await expect(editor).toContainText('Unsaved changes')
    await editor.getByRole('button', { name: 'Minimize notes.txt', exact: true }).click()
    await switchServer(page, 'Orion')
    await switchServer(page, 'Atlas')
    await page
      .getByRole('button', { name: 'Editor /home/demo/projects/notes.txt', exact: true })
      .click()
    await expect(editor.locator('.cm-content')).toContainText('Unsaved draft')
    await page.evaluate(() => {
      window.confirm = () => false
    })
    await editor.getByRole('button', { name: 'Close notes.txt', exact: true }).click()
    await expect(editor).toBeVisible()
    await page.evaluate(() => {
      window.confirm = () => true
    })
    await editor.getByRole('button', { name: 'Close notes.txt', exact: true }).click()
    await expect(editor).toHaveCount(0)

    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    const terminal = page.getByRole('region', { name: 'Terminal window', exact: true })
    await expect(terminal).toContainText('Interactive SSH shell')
    const count = await shellCount(app)
    await terminal.getByRole('button', { name: 'Minimize Terminal', exact: true }).click()
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(terminal).toBeVisible()
    expect(await shellCount(app)).toBe(count)
    await switchServer(page, 'Orion')
    await switchServer(page, 'Atlas')
    expect(await shellCount(app)).toBe(count)
    await page.reload()
    await expect(page.getByRole('region', { name: 'Files window', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Terminal window', exact: true })).toBeHidden()
    expect(await shellCount(app)).toBe(count)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
    await expect
      .poll(
        async () =>
          (await page.getByRole('region', { name: 'Files window', exact: true }).boundingBox())!
            .width,
      )
      .toBeLessThanOrEqual(960)
    const small = (await page
      .getByRole('region', { name: 'Files window', exact: true })
      .boundingBox())!
    expect(small.y + small.height).toBeLessThanOrEqual(575)
    await page.screenshot({ path: 'test-results/desktop-960.png' })
    await page.getByRole('button', { name: 'Open launcher', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Your workspace', exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/desktop-launcher.png' })
    await page.getByLabel('Search apps', { exact: true }).fill('settings')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Settings Make yourself/ })
      .click()
    await expect(page.getByRole('region', { name: 'Settings window', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await app.close()
    await removeTestDirectory(directory, 'vps-workspace-ui-')
  }
})

test('native-backed file drops retain their original server and folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vps-workspace-ui-'))
  const localFile = join(directory, 'upload.txt')
  await writeFile(localFile, 'native drop fixture')
  const { app, page } = await launch(directory)
  try {
    await prepareDrop(page, localFile)
    await dropOn(page, '.desktop-canvas')
    await expect(page.getByRole('dialog', { name: 'Upload to server', exact: true })).toContainText(
      'Atlas',
    )
    await expect(page.getByLabel('Upload destination')).toHaveValue('/home/demo/Uploads')
    await page.getByRole('button', { name: 'Upload to Atlas', exact: true }).click()
    await expect.poll(async () => (await calls(app, 'transfers.desktopDrop')).length).toBe(1)
    expect((await calls(app, 'transfers.desktopDrop'))[0].input).toMatchObject({
      sessionId: sessions[0].id,
      path: '/home/demo/Uploads',
      conflict: 'ask',
    })
    expect(((await calls(app, 'transfers.desktopDrop'))[0].input.tokens as string[])[0]).toMatch(
      /^[0-9a-f-]{36}$/,
    )
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await page
      .getByRole('textbox', { name: 'Remote path', exact: true })
      .fill('/home/demo/projects')
    await page.getByRole('textbox', { name: 'Remote path', exact: true }).press('Enter')
    await expect(page.getByRole('textbox', { name: 'Remote path', exact: true })).toHaveValue(
      '/home/demo/projects',
    )
    await dropOn(page, '.os-window[data-app="files"] .explorer-page')
    await switchServer(page, 'Orion')
    await expect.poll(async () => (await calls(app, 'transfers.drop')).length).toBe(1)
    expect((await calls(app, 'transfers.drop'))[0].input).toMatchObject({
      sessionId: sessions[0].id,
      path: '/home/demo/projects',
    })
    expect(await calls(app, 'transfers.desktopDrop')).toHaveLength(1)
  } finally {
    await app.close()
    await removeTestDirectory(directory, 'vps-workspace-ui-')
  }
})

test('terminal right-click and shortcuts copy and paste through the system clipboard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vps-workspace-ui-'))
  const { app, page } = await launch(directory)
  await preserveClipboard(app)
  const writeClipboard = (text: string) =>
    app.evaluate(async ({ clipboard }, value) => clipboard.writeText(value), text)
  const readClipboard = () => app.evaluate(async ({ clipboard }) => clipboard.readText())
  const input = async () => (await calls(app, 'terminal.input')).map((call) => call.input.data)
  const output = async (data: string) => {
    const before = (await calls(app, 'terminal.ack')).length
    await app.evaluate(({ BrowserWindow }, text) => {
      BrowserWindow.getAllWindows()[0].webContents.send('vps:event', {
        type: 'terminal-data',
        id: '00000000-0000-4000-8000-000000000001',
        data: text,
        bytes: Buffer.byteLength(text),
      })
    }, data)
    await expect.poll(async () => (await calls(app, 'terminal.ack')).length).toBeGreaterThan(before)
  }
  try {
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(page.getByText('Interactive SSH shell', { exact: true })).toBeVisible()
    await output('COPY_FROM_SHELL\r\n')
    const word = page.locator('.xterm-rows').getByText('COPY_FROM_SHELL', { exact: true })
    const selectWord = async () => {
      await expect(word).toBeVisible()
      const box = (await word.boundingBox())!
      // xterm's screen overlay receives pointer events for the rendered text.
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
    }
    const canvas = page.locator('.terminal-canvas')
    const rightClick = () => canvas.click({ button: 'right', position: { x: 35, y: 50 } })

    await writeClipboard('old clipboard')
    await selectWord()
    await rightClick()
    await expect.poll(readClipboard).toBe('COPY_FROM_SHELL')
    expect(await input()).toEqual([])
    // Successful copy clears selection, so the next right-click pastes exactly once.
    await rightClick()
    await expect.poll(input).toEqual(['COPY_FROM_SHELL'])

    await output('\x1b[?2004h')
    const multiline = 'printf "hello world"\r\nprintf "second line"'
    await writeClipboard(multiline)
    await rightClick()
    await expect
      .poll(input)
      .toEqual(['COPY_FROM_SHELL', `\x1b[200~${multiline.replace(/\r\n/g, '\r')}\x1b[201~`])

    for (const shortcut of ['Control+v', 'Control+Shift+v', 'Shift+Insert']) {
      const before = await input()
      await writeClipboard(`PASTE_${shortcut}`)
      await page.locator('.xterm-helper-textarea').focus()
      await page.keyboard.press(shortcut)
      await expect.poll(input).toEqual([...before, `\x1b[200~PASTE_${shortcut}\x1b[201~`])
    }
    for (const shortcut of ['Control+Shift+c', 'Control+c', 'Control+Insert']) {
      const before = await input()
      await writeClipboard('replace me')
      await selectWord()
      await page.keyboard.press(shortcut)
      await expect.poll(readClipboard).toBe('COPY_FROM_SHELL')
      expect(await input()).toEqual(before)
    }
    let before = await input()
    await page.keyboard.press('Control+c')
    await expect.poll(input).toEqual([...before, '\x03'])
    before = await input()
    await page.keyboard.press('Control+Shift+c')
    await writeClipboard('')
    await rightClick()
    await expect.poll(async () => (await calls(app, 'clipboard.readText')).length).toBe(6)
    expect(await input()).toEqual(before)

    // Cross the IPC limit at a surrogate pair, and type immediately after the paste.
    const large = `${'x'.repeat(65529)}😀${'y'.repeat(8192)}\r\nlast line`
    await writeClipboard(large)
    await rightClick()
    await page.keyboard.type('z')
    await expect
      .poll(async () => (await input()).slice(before.length).join(''))
      .toBe(`\x1b[200~${large.replace(/\r\n/g, '\r')}\x1b[201~z`)
    const chunks = (await input()).slice(before.length) as string[]
    expect(chunks.every((chunk) => chunk.length <= 65536 && !chunk.endsWith('\ud83d'))).toBe(true)

    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const notes = page.getByRole('row').filter({ hasText: 'notes.txt' })
    await notes.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy full path', exact: true }).click()
    await expect.poll(readClipboard).toBe('/home/demo/notes.txt')
    await notes.dblclick()
    const editor = page.getByRole('region', { name: 'notes.txt window', exact: true })
    await editor.locator('.cm-content').click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+c')
    await expect.poll(readClipboard).toBe('Workspace notes\n')
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    before = await input()
    await rightClick()
    await expect.poll(input).toEqual([...before, '\x1b[200~Workspace notes\r\x1b[201~'])
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    try {
      await restoreClipboard(app)
    } finally {
      await app.close()
      await removeTestDirectory(directory, 'vps-workspace-ui-')
    }
  }
})
