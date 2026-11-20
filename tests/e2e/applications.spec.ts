import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { removeTestDirectory } from '../../scripts/test-temp'

test('application filters and confirmed deployment removal use the real disposable server', async () => {
  const configPath = '.test-data/ubuntu/connection.json'
  test.skip(
    process.env.VPS_TEST_ALLOW_DISPOSABLE !== '1' || !existsSync(configPath),
    'Explicitly enable the disposable loopback fixture.',
  )
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    host: string
    port: number
    username: string
    password: string
    fingerprint: string
  }
  expect([config.host, config.port, config.username]).toEqual(['127.0.0.1', 22222, 'vpstest'])
  const directory = await mkdtemp(join(tmpdir(), 'vps-app-ui-test-'))
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        name !== 'ELECTRON_RUN_AS_NODE' && name !== 'ELECTRON_RENDERER_URL' && value !== undefined,
    ),
  ) as Record<string, string>
  const app = await electron.launch({
    executablePath:
      process.env.VPS_TEST_EXECUTABLE || resolve('node_modules/electron/dist/electron.exe'),
    args: process.env.VPS_TEST_EXECUTABLE ? [] : [resolve('.')],
    env: { ...environment, VPS_MANAGER_TEST_DATA: directory },
  })
  let sessionId = ''
  let root = ''
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByLabel('Server address').fill(config.host)
    await page.getByLabel('SSH port').fill(String(config.port))
    await page.getByLabel('Username', { exact: true }).fill(config.username)
    await page.getByLabel('Password', { exact: true }).fill(config.password)
    await page.getByRole('checkbox', { name: 'Save server profile' }).uncheck()
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click()
    await expect(page.getByText(config.fingerprint, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Trust and connect' }).click()
    await page.getByRole('button', { name: 'Server', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Server overview' })).toBeVisible()
    sessionId = await page.evaluate(async () => {
      const result = await window.vps.invoke('app.bootstrap', {})
      if (!result.ok) throw new Error(result.error.message)
      return result.value.sessions[0].id
    })
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const home = await page.getByLabel('Remote path').inputValue()
    const name = `.vps-app-ui-${randomUUID()}`
    root = `${home}/${name}`
    const created = await page.evaluate(
      async ({ sessionId, home, name }) => {
        const folder = await window.vps.invoke('files.create', {
          sessionId,
          path: home,
          name,
          kind: 'directory',
        })
        if (!folder.ok) return folder
        return window.vps.invoke('files.create', {
          sessionId,
          path: `${home}/${name}`,
          name: 'keep-until-confirmed.txt',
          kind: 'file',
        })
      },
      { sessionId, home, name },
    )
    expect(created.ok).toBe(true)

    await page.getByRole('button', { name: 'Open launcher', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Applications Packages/ })
      .click()
    await page.getByLabel('Package filter').selectOption('optional')
    await page.getByLabel('Search applications').fill('hello')
    const hello = page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: /^hello / }) })
    await expect(hello).toContainText('optional')
    await hello.getByRole('button', { name: 'Uninstall…', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('1 package')
    await expect(
      page.getByRole('button', { name: 'Continue to final confirmation…' }),
    ).toBeDisabled()
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByLabel('Package filter').selectOption('all')
    await page.getByLabel('Hide protected system packages').uncheck()
    await page.getByLabel('Search applications').fill('openssh-server')
    const ssh = page.getByRole('row').filter({ hasText: 'openssh-server' })
    await expect(ssh).toContainText('Protected')
    await expect(ssh.getByRole('button', { name: 'Uninstall…', exact: true })).toBeDisabled()

    const register = async (): Promise<void> => {
      await page.getByRole('button', { name: 'Add deployed app' }).click()
      await page.getByLabel('App name', { exact: true }).fill('Disposable UI deployment')
      await page.getByLabel('Installation directory', { exact: true }).fill(root)
      await page.getByRole('button', { name: 'Save app', exact: true }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.locator('.deployment-row')).toContainText('Disposable UI deployment')
    }
    const folderState = () =>
      page.evaluate(
        async ({ sessionId, root }) => window.vps.invoke('files.list', { sessionId, path: root }),
        { sessionId, root },
      )

    await register()
    await page.screenshot({ path: '.test-data/deployment-card.png' })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    await page.getByRole('button', { name: 'Remove from list', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'No registered deployments' })).toBeVisible()
    expect(await folderState()).toMatchObject({
      ok: true,
      value: { entries: [{ name: 'keep-until-confirmed.txt' }] },
    })

    await register()
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    await page.getByRole('button', { name: 'Remove files…', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText(root)
    await page.getByRole('button', { name: 'Continue to final confirmation…' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Removal cancelled.' })).toBeVisible()
    expect((await folderState()).ok).toBe(true)

    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    await page.getByRole('button', { name: 'Remove files…', exact: true }).click()
    await page.getByRole('button', { name: 'Continue to final confirmation…' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(
      page.getByRole('status').filter({ hasText: 'Deployment directory removal verified.' }),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No registered deployments' })).toBeVisible()
    expect(await folderState()).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } })
    root = ''
    expect(errors).toEqual([])
  } finally {
    if (sessionId && /^\/home\/vpstest\/\.vps-app-ui-[a-f0-9-]+$/.test(root)) {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      })
      const page = await app.firstWindow()
      await page.evaluate(
        async ({ sessionId, root }) =>
          window.vps.invoke('files.delete', { sessionId, paths: [root] }),
        { sessionId, root },
      )
    }
    await app.close()
    await removeTestDirectory(directory, 'vps-app-ui-test-')
  }
})
