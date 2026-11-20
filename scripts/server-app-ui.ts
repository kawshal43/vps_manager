import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsRepository } from '../src/infrastructure/persistence/store'
import { removeTestDirectory } from './test-temp'

export async function inspectApplicationUi(input: {
  host: string
  secret: string
  settingsDirectory: string
  progress?: (message: string) => void
}): Promise<object> {
  const original = new SettingsRepository(input.settingsDirectory)
  await original.load()
  const profile = original.profiles().find((value) => value.host === input.host)
  const host = original
    .hosts()
    .filter((value) => value.host === input.host && value.port === profile?.port)
    .at(-1)
  if (!profile || !host) throw new Error('A saved profile and trusted host are required')
  const temporary = await mkdtemp(join(tmpdir(), 'vps-app-ui-'))
  const local = new SettingsRepository(temporary)
  await local.load()
  await local.trust(host)
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'DEBUG'].includes(name) &&
        value !== undefined,
    ),
  ) as Record<string, string>
  const application = await electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron.exe'),
    args: [resolve('.')],
    env: { ...environment, VPS_MANAGER_TEST_DATA: temporary },
  })
  try {
    const page = await application.firstWindow()
    await page.getByLabel('Server name').fill('Ubuntu server')
    await page.getByLabel('Server address').fill(profile.host)
    await page.getByLabel('SSH port').fill(String(profile.port))
    await page.getByLabel('Username', { exact: true }).fill(profile.username)
    await page.getByLabel('Password', { exact: true }).fill(input.secret)
    await page.getByRole('checkbox', { name: 'Save server profile' }).uncheck()
    await page.getByRole('button', { name: 'Connect to server', exact: true }).click()
    await page.getByRole('button', { name: 'Server', exact: true }).click({ timeout: 30000 })
    await expect(page.getByRole('heading', { name: 'Server overview' })).toBeVisible({
      timeout: 30000,
    })
    input.secret = ''
    await page.getByRole('button', { name: 'Open launcher', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Applications Packages/ })
      .click()
    await expect(page.getByRole('tab', { name: 'Ubuntu packages' })).toBeVisible()
    await page.getByLabel('Package filter', { exact: true }).selectOption('all')
    await page.getByLabel('Search applications').fill('xrdp')
    const row = page.locator('tbody tr').filter({ has: page.getByText('xrdp', { exact: true }) })
    await expect(row).toBeVisible({ timeout: 30000 })
    await mkdir(resolve('.test-data'), { recursive: true })
    await page.screenshot({ path: '.test-data/application-inventory.png' })
    input.progress?.(
      'Actual package table, search and filters verified in the new Electron interface',
    )
    await row.getByRole('button', { name: 'Uninstall…', exact: true }).click()
    await expect(
      page.getByRole('dialog').getByRole('heading', { name: 'Uninstall xrdp' }),
    ).toBeVisible({ timeout: 30000 })
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Continue to final confirmation…' }),
    ).toBeDisabled()
    await page.screenshot({ path: '.test-data/application-removal-preview.png' })
    input.progress?.('Live APT removal preview rendered; no uninstall execution requested')
    await page.getByRole('button', { name: 'Close dialog' }).click()
    await page.getByRole('tab', { name: 'My deployments' }).click()
    await expect(page.getByRole('heading', { name: 'No registered deployments' })).toBeVisible()
    await page.getByRole('button', { name: 'Add deployed app' }).click()
    await expect(page.getByRole('dialog').getByLabel('Installation directory')).toBeVisible()
    await page.screenshot({ path: '.test-data/deployment-registration.png' })
    return {
      serverChanges: false,
      isolatedUserData: true,
      packageSearchAndFilters: true,
      removalPreview: true,
      noImplicitElevation: true,
      deploymentRegistrationForm: true,
    }
  } finally {
    input.secret = ''
    await application.close()
    await removeTestDirectory(temporary, 'vps-app-ui-')
  }
}
