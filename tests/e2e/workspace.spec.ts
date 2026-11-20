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
import type {
  WebsiteRecord,
  WebsiteInput,
  DeploymentHistory,
  DeploymentProgress,
} from '../../src/domain/websites/types'

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
    ({ ipcMain, clipboard, BrowserWindow }, values) => {
      const fixture = {
        ...values,
        calls: [] as { route: string; input: Record<string, unknown> }[],
        shells: 0,
        websites: [] as WebsiteRecord[],
        websiteHistory: [] as DeploymentHistory[],
        websitePlans: new Map<string, string>(),
        websiteOperations: [] as DeploymentProgress[],
        websiteFailNext: false,
      }
      Reflect.set(globalThis, '__desktopFixture', fixture)
      ipcMain.removeHandler('vps:invoke')
      ipcMain.handle(
        'vps:invoke',
        async (_event, route: string, input: Record<string, unknown>) => {
          fixture.calls.push({ route, input })
          let value: unknown
          if (route === 'websites.discover') {
            const records = fixture.websites.filter((r) => r.scope === input.sessionId)
            value = {
              at: new Date().toISOString(),
              warnings: ['Offline website presentation fixture'],
              websites: records.length
                ? records.map((r) => ({
                    id: r.id,
                    name: r.config.name,
                    domain: r.config.domain,
                    aliases: [],
                    webServer: 'Registered',
                    technology: r.config.strategy === 'static' ? 'Static assets' : 'Docker Compose',
                    support: 'supported',
                    https: true,
                    projectPath: r.config.projectPath,
                    record: r,
                    services: [],
                  }))
                : [
                    {
                      id: 'discovered',
                      name: 'Discovered website',
                      domain: 'example.test',
                      aliases: ['www.example.test'],
                      webServer: 'Nginx',
                      technology: 'Reverse proxy',
                      support: 'import',
                      https: true,
                      services: [],
                      configPath: '/etc/nginx/sites-available/example',
                    },
                  ],
            }
          } else if (route === 'websites.save') {
            const record: WebsiteRecord = {
              id: crypto.randomUUID(),
              scope: input.sessionId as string,
              config: input.config as WebsiteInput,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
            fixture.websites.push(record)
            value = record
          } else if (route === 'websites.operations')
            value = fixture.websiteOperations.filter((o) => o.sessionId === input.sessionId)
          else if (route === 'websites.pickSource')
            value = { token: crypto.randomUUID(), name: 'fixture-project' }
          else if (route === 'websites.prepare') {
            const token = crypto.randomUUID()
            fixture.websitePlans.set(token, input.websiteId as string)
            const source = input.source as { kind: string; path?: string }
            value = {
              token,
              websiteId: input.websiteId,
              expiresAt: Date.now() + 600000,
              method: input.method,
              changes: { added: ['new.html'], changed: ['index.html'], removed: [], unchanged: 1 },
              bytes: 42,
              fileCount: 2,
              services: [],
              protected: ['uploads', '.env'],
              blocked: source.path?.includes('unsafe') ? ['Unsafe source fixture'] : [],
              warnings: ['Application rollback does not restore databases or media.'],
              freeBytes: 1024 ** 3,
            }
          } else if (route === 'websites.history')
            value = fixture.websiteHistory.filter(
              (h) => h.scope === input.sessionId && h.websiteId === input.websiteId,
            )
          else if (route === 'websites.deploy' || route === 'websites.restore') {
            const websiteId =
              route === 'websites.deploy'
                ? fixture.websitePlans.get(input.token as string)!
                : (input.websiteId as string)
            const id = crypto.randomUUID(),
              now = new Date().toISOString()
            const history: DeploymentHistory = {
              id,
              websiteId,
              scope: input.sessionId as string,
              action: route === 'websites.deploy' ? 'deploy' : 'restore',
              startedAt: now,
              status: 'running',
              message: 'Preparing fixture deployment',
              backupVerified: true,
              backupBytes: 10,
              backupHash: 'fixture',
              previousImages: {},
              configHash: 'fixture',
              log: ['Verified source backup'],
            }
            fixture.websiteHistory.push(history)
            const progress: DeploymentProgress = {
              id,
              websiteId,
              sessionId: input.sessionId as string,
              state: 'running',
              stage: 'Staging release',
              startedAt: now,
              transferred: 0,
              total: 42,
              log: ['Verified source backup'],
              cancellable: true,
            }
            fixture.websiteOperations.push(progress)
            BrowserWindow.getAllWindows()[0].webContents.send('vps:event', {
              type: 'website-deployment',
              operation: progress,
            })
            setTimeout(() => {
              history.status = fixture.websiteFailNext
                ? 'failed'
                : route === 'websites.deploy'
                  ? 'completed'
                  : 'restored'
              fixture.websiteFailNext = false
              history.endedAt = new Date().toISOString()
              history.message =
                history.status === 'failed'
                  ? 'Build failed; verified backup retained'
                  : 'Application and routing verified'
              progress.state = history.status
              progress.stage = history.status
              progress.transferred = 42
              progress.cancellable = false
              progress.finishedAt = history.endedAt
              BrowserWindow.getAllWindows()[0].webContents.send('vps:event', {
                type: 'website-deployment',
                operation: progress,
              })
            }, 150)
            value = id
          } else if (route === 'websites.health')
            value = {
              at: new Date().toISOString(),
              url: 'https://example.test',
              code: 200,
              state: 'healthy',
              detail: 'HTTP 200 from the server.',
            }
          else if (route === 'websites.logs') value = 'Bounded fixture application output'
          else if (route === 'websites.nginx') value = 'Nginx configuration test passed.'
          else if (route === 'clipboard.readText') value = await clipboard.readText()
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
      // Text spans are replaced during selection/cursor repaint; the screen is stable.
      // The fixture word is on the first row, and this position is inside that word.
      await page.locator('.xterm-screen').dblclick({ position: { x: 35, y: 8 } })
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

test('websites import, deployment preview, history and restore remain isolated per server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vps-workspace-ui-'))
  const { app, page } = await launch(directory)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const openWebsites = async () => {
    await page.getByRole('button', { name: 'Open launcher', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Websites & Deployments Discover/ })
      .click()
  }
  try {
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'notes.txt' }).click()
    await expect(
      page.getByRole('button', { name: 'Delete permanently', exact: true }),
    ).toBeEnabled()
    await openWebsites()
    const websites = page.getByRole('region', {
      name: 'Websites & Deployments window',
      exact: true,
    })
    await expect(
      websites.getByText('Deployment source not identified — Import or configure website.', {
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      websites.getByRole('button', { name: 'Update website', exact: true }),
    ).toBeDisabled()
    await websites.getByRole('button', { name: 'Configure website', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Import website', exact: true })
    await form.getByLabel('Website name', { exact: true }).fill('Atlas website')
    await form.getByLabel('Project directory', { exact: true }).fill('/home/demo/project')
    await form.getByLabel('Deployment adapter', { exact: true }).selectOption('static')
    await form.getByRole('button', { name: 'Save website', exact: true }).click()
    await expect(
      websites.getByRole('heading', { name: 'Atlas website', exact: true }),
    ).toBeVisible()
    await websites.getByRole('button', { name: 'Check application health', exact: true }).click()
    await expect(websites.getByText('healthy · HTTP 200', { exact: true })).toBeVisible()
    await websites.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Remote path', exact: true })).toHaveValue(
      '/home/demo/project',
    )
    await expect(
      page.getByRole('button', { name: 'Delete permanently', exact: true }),
    ).toBeDisabled()
    await page.getByRole('button', { name: 'Websites & Deployments', exact: true }).click()
    await websites.getByRole('button', { name: 'Update website', exact: true }).click()
    const wizard = page.getByRole('dialog', { name: 'Update Atlas website', exact: true })
    await wizard.getByLabel('Update source', { exact: true }).selectOption('remote')
    await wizard
      .getByLabel('Source directory on this server', { exact: true })
      .fill('/home/demo/unsafe')
    await wizard.getByRole('button', { name: 'Inspect deployment', exact: true }).click()
    await expect(wizard.getByText('Deployment blocked', { exact: true })).toBeVisible()
    await expect(
      wizard.getByRole('button', { name: 'Back up & deploy', exact: true }),
    ).toBeDisabled()
    await wizard.getByRole('button', { name: 'Back', exact: true }).click()
    await wizard
      .getByLabel('Source directory on this server', { exact: true })
      .fill('/home/demo/new-source')
    await wizard.getByRole('button', { name: 'Inspect deployment', exact: true }).click()
    await expect(
      wizard.getByRole('button', { name: 'Back up & deploy', exact: true }),
    ).toBeDisabled()
    await wizard.getByRole('checkbox').check()
    await wizard.getByRole('button', { name: 'Back up & deploy', exact: true }).click()
    await expect(wizard).toBeHidden()
    await expect(websites.getByText('Deployment · completed', { exact: true })).toBeVisible()
    await expect(
      websites.getByRole('button', { name: 'Restore previous version…', exact: true }),
    ).toBeEnabled()
    await websites.getByRole('button', { name: 'Restore previous version…', exact: true }).click()
    const restore = page.getByRole('dialog', { name: 'Restore application backup', exact: true })
    await expect(
      restore.getByRole('button', { name: 'Verify backup & restore…', exact: true }),
    ).toBeDisabled()
    await restore.getByRole('checkbox').check()
    await restore.getByRole('button', { name: 'Verify backup & restore…', exact: true }).click()
    await expect(restore).toBeHidden()
    await expect(
      websites.getByText('Application restore · restored', { exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: 'test-results/websites-deployments.png' })
    await app.evaluate(() => {
      ;(
        Reflect.get(globalThis, '__desktopFixture') as { websiteFailNext: boolean }
      ).websiteFailNext = true
    })
    await websites.getByRole('button', { name: 'Update website', exact: true }).click()
    const rebuild = page.getByRole('dialog', { name: 'Update Atlas website', exact: true })
    await rebuild.getByLabel('Update method', { exact: true }).selectOption('rebuild')
    await rebuild.getByRole('button', { name: 'Inspect deployment', exact: true }).click()
    await rebuild.getByRole('checkbox').check()
    await rebuild.getByRole('button', { name: 'Back up & deploy', exact: true }).click()
    await expect(websites.getByText('Deployment · failed', { exact: true })).toBeVisible()
    await expect(
      websites.getByRole('button', { name: 'Review backups and recovery', exact: true }),
    ).toBeVisible()
    const title = websites.getByLabel('Move Websites & Deployments window', { exact: true })
    await title.focus()
    for (let i = 0; i < 28; i++) await page.keyboard.press('Control+Shift+ArrowLeft')
    await expect.poll(async () => Math.round((await websites.boundingBox())!.width)).toBe(560)
    expect(
      await websites
        .locator('.websites-page')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true)
    await page.screenshot({ path: 'test-results/websites-compact.png' })
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await page.screenshot({ path: 'test-results/websites-dark.png' })
    await websites
      .getByRole('button', { name: 'Minimize Websites & Deployments', exact: true })
      .click()
    await page.getByRole('button', { name: 'Websites & Deployments', exact: true }).click()
    await expect(
      websites.getByRole('heading', { name: 'Atlas website', exact: true }),
    ).toBeVisible()
    await switchServer(page, 'Orion')
    await openWebsites()
    const orion = page
      .getByRole('region', { name: 'Websites & Deployments window', exact: true })
      .filter({ visible: true })
    await expect(
      orion.getByRole('heading', { name: 'Discovered website', exact: true }),
    ).toBeVisible()
    await expect(orion.getByText('Atlas website', { exact: true })).toHaveCount(0)
    await switchServer(page, 'Atlas')
    await expect(
      websites.getByRole('heading', { name: 'Atlas website', exact: true }),
    ).toBeVisible()
    const deployCalls = await calls(app, 'websites.deploy')
    expect(deployCalls).toHaveLength(2)
    expect(deployCalls[0].input).toMatchObject({ sessionId: sessions[0].id, acknowledged: true })
    expect(errors).toEqual([])
  } finally {
    await app.close()
    await removeTestDirectory(directory, 'vps-workspace-ui-')
  }
})
