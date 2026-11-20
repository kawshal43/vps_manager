import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTestDirectory } from '../../scripts/test-temp'

test('packaged application enables connecting and restores its desktop bridge after reload', async () => {
  test.skip(
    !process.env.VPS_TEST_EXECUTABLE,
    'Set VPS_TEST_EXECUTABLE to test the built application.',
  )
  const directory = await mkdtemp(join(tmpdir(), 'vps-startup-test-'))
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        name !== 'ELECTRON_RUN_AS_NODE' && name !== 'ELECTRON_RENDERER_URL' && value !== undefined,
    ),
  ) as Record<string, string>
  const app = await electron.launch({
    executablePath: process.env.VPS_TEST_EXECUTABLE,
    args: [],
    env: { ...environment, VPS_MANAGER_TEST_DATA: directory },
  })
  try {
    const page = await app.firstWindow()
    const { version } = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
      version: string
    }
    const bootstrap = await page.evaluate(() => window.vps.invoke('app.bootstrap', {}))
    expect(bootstrap).toMatchObject({ ok: true, value: { version } })
    await expect(page.getByRole('button', { name: 'Connect to server', exact: true })).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.reload()
    expect(await page.evaluate(() => window.vps.invoke('app.bootstrap', {}))).toMatchObject({
      ok: true,
    })
    await expect(page.getByRole('button', { name: 'Connect to server', exact: true })).toBeEnabled()
  } finally {
    await app.close()
    await removeTestDirectory(directory, 'vps-startup-test-')
  }
})
