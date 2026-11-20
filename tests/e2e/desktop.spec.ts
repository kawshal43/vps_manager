import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { removeTestDirectory } from '../../scripts/test-temp'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { prepareDrop, dropOn } from './fixtures/native-drop'

test('desktop security and full Ubuntu workflow', async () => {
  const { version } = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
    version: string
  }
  const configPath = process.env.VPS_TEST_CONFIG || '.test-data/ubuntu/connection.json'
  test.skip(
    process.env.VPS_TEST_ALLOW_DISPOSABLE !== '1' || !existsSync(configPath),
    'Explicitly enable a disposable Ubuntu test server first.',
  )
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    host: string
    port: number
    username: string
    password: string
    fingerprint: string
  }
  const dir = await mkdtemp(join(tmpdir(), 'vps-desktop-test-'))
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => name !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>
  const app = await electron.launch({
    executablePath:
      process.env.VPS_TEST_EXECUTABLE || resolve('node_modules/electron/dist/electron.exe'),
    args: process.env.VPS_TEST_EXECUTABLE ? [] : [resolve('.')],
    env: { ...environment, VPS_MANAGER_TEST_DATA: dir },
  })
  let remoteCleanup: { sessionId: string; path: string } | undefined
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await expect(page.getByRole('heading', { name: 'Connect to your server' })).toBeVisible()
    expect(
      await page.evaluate(async () => {
        const result = await window.vps.invoke('app.bootstrap', {})
        return result.ok ? result.value.version : ''
      }),
    ).toBe(version)
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily),
    ).toContain('Segoe UI')
    expect(
      await app.evaluate(({ app }) => app.getAppMetrics().find((p) => p.type === 'Tab')?.sandboxed),
    ).toBe(true)
    expect(
      await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
    ).toBe('undefined')
    expect(
      await page.evaluate(async () =>
        window.vps.invoke('app.bootstrap', { arbitrary: true } as never),
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    await page.screenshot({ path: 'test-results/connection-screen.png' })
    await page.getByLabel('Server name').fill('Ubuntu acceptance')
    await page.getByLabel('Server address').fill(config.host)
    await page.getByLabel('SSH port').fill(String(config.port))
    await page.getByLabel('Username', { exact: true }).fill(config.username)
    await page.getByLabel('Password', { exact: true }).fill(config.password)
    const remember = page.getByRole('checkbox', { name: /Remember credentials/ })
    const secureRemember = await remember.isEnabled()
    if (secureRemember) await remember.check()
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click()
    await expect(page.getByText(config.fingerprint, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Trust and connect' }).click()
    await page.getByRole('button', { name: 'Server', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Server overview' })).toBeVisible()
    await expect(page.getByText('SFTP available', { exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/overview.png' })
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(page.getByRole('grid', { name: 'Remote files' })).toBeVisible()
    await page.getByRole('button', { name: 'New folder', exact: true }).click()
    const folderName = `.vps-manager-e2e-${Date.now()}`
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(folderName)
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click()
    // Dotfiles are hidden by default; navigate explicitly to the new isolated folder.
    const home = await page.getByLabel('Remote path').inputValue()
    const sessionId = await page.evaluate(async () => {
      const result = await window.vps.invoke('app.bootstrap', {})
      if (!result.ok) throw new Error(result.error.message)
      return result.value.sessions[0].id
    })
    remoteCleanup = { sessionId, path: `${home}/${folderName}` }
    await page.getByLabel('Remote path').fill(`${home}/${folderName}`)
    await page.getByLabel('Remote path').press('Enter')
    await expect(page.getByRole('heading', { name: 'This folder is empty' })).toBeVisible()
    await page.getByRole('button', { name: 'New file', exact: true }).click()
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('settings.json')
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click()
    await page.getByRole('row').filter({ hasText: 'settings.json' }).dblclick()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').click()
    await page.keyboard.type('{"desktop":true}')
    await page.getByRole('checkbox', { name: 'Wrap', exact: true }).check()
    await expect(page.locator('.cm-content')).toContainText('{"desktop":true}')
    await page
      .getByRole('region', { name: 'settings.json window', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click()
    await expect(page.getByText('Server version loaded', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close settings.json', exact: true }).click()
    const localFolder = join(dir, 'upload-project')
    await mkdir(localFolder)
    await writeFile(join(localFolder, 'hello.txt'), 'native picker upload\n')
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, localFolder)
    await page.getByRole('button', { name: 'Upload folder', exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: 'upload-project' })).toBeVisible()
    await page.getByRole('button', { name: 'Transfer activity', exact: true }).click()
    await expect(page.getByText('completed', { exact: true })).toBeVisible()
    const droppedPath = join(dir, 'desktop-drop.txt')
    await writeFile(droppedPath, 'real desktop drop over SFTP\n')
    await prepareDrop(page, droppedPath)
    await dropOn(page, '.desktop-canvas')
    await page.getByLabel('Upload destination').fill(remoteCleanup.path)
    await page.getByRole('button', { name: 'Upload to Ubuntu acceptance', exact: true }).click()
    await expect(
      page.locator('.transfer-row').filter({ hasText: 'desktop-drop.txt' }),
    ).toContainText('completed')
    expect(
      await page.evaluate(
        async ({ sessionId, path }) => window.vps.invoke('files.read', { sessionId, path }),
        { sessionId, path: `${remoteCleanup.path}/desktop-drop.txt` },
      ),
    ).toMatchObject({ ok: true, value: { content: 'real desktop drop over SFTP\n' } })
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const directPath = join(dir, 'direct-drop.txt')
    await writeFile(directPath, 'real explorer drop over SFTP\n')
    await prepareDrop(page, directPath)
    await dropOn(page, '.os-window[data-app="files"] .explorer-page')
    await expect
      .poll(async () =>
        page.evaluate(
          async ({ sessionId, path }) => {
            const result = await window.vps.invoke('files.read', { sessionId, path })
            return result.ok ? result.value.content : null
          },
          { sessionId, path: `${remoteCleanup!.path}/direct-drop.txt` },
        ),
      )
      .toBe('real explorer drop over SFTP\n')
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(page.getByText('Interactive SSH shell', { exact: true })).toBeVisible()
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type("printf 'DESKTOP_%s\\n' PTY_OK")
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm-rows')).toContainText('DESKTOP_PTY_OK')
    await page.screenshot({ path: 'test-results/terminal.png' })
    await page.getByRole('button', { name: 'Server', exact: true }).click()
    await page.getByRole('button', { name: 'Services', exact: true }).click()
    await expect(page.getByRole('button', { name: 'ssh.service', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await page.screenshot({ path: 'test-results/files.png' })
    // Only the test-created folder is removed. No production paths are touched.
    await page.getByLabel('Remote path').fill(home)
    await page.getByLabel('Remote path').press('Enter')
    await page.getByRole('button', { name: 'Show hidden files', exact: true }).click()
    const row = page.getByRole('row').filter({ hasText: folderName })
    await expect(row).toBeVisible()
    await row.click()
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    await page.getByRole('button', { name: 'Delete permanently', exact: true }).click()
    await expect(row).not.toBeVisible()
    remoteCleanup = undefined
    await page.evaluate(() => {
      window.confirm = () => true
    })
    await page.getByRole('button', { name: 'Server connections', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click()
    await expect(page.locator('.desktop-connection-label')).toHaveText('Offline')
    expect(errors).toEqual([])
    const settings = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(settings).not.toContain(config.password)
    if (secureRemember) {
      expect(Object.keys(JSON.parse(settings).credentials)).toHaveLength(1)
      await page.getByRole('button', { name: 'Server connections', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Add connection', exact: true }).click()
      await expect(page.getByLabel('Server address')).toHaveValue(config.host)
      await page.getByRole('button', { name: 'Connect to server', exact: true }).click()
      await expect(page.locator('.desktop-connection-label')).toHaveText('SSH connected')
    }
  } finally {
    if (remoteCleanup && /\/\.vps-manager-e2e-\d+$/.test(remoteCleanup.path)) {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      })
      const page = await app.firstWindow()
      await page.evaluate(
        async ({ sessionId, path }) =>
          window.vps.invoke('files.delete', { sessionId, paths: [path] }),
        remoteCleanup,
      )
    }
    await app.close()
    await removeTestDirectory(dir, 'vps-desktop-test-')
  }
})
