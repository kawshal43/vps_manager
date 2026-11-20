import { _electron as electron, expect, test } from '@playwright/test'
import { cp, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { removeTestDirectory } from '../../scripts/test-temp'

test('IPC accepts the application in Windows paths containing spaces and URL characters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vps-origin-test-'))
  const root = join(directory, "VPS Manager #1 ü's app")
  await mkdir(root)
  await cp(resolve('out'), join(root, 'out'), { recursive: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'junction')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'vps-manager', version: '0.1.0', main: 'out/main/index.js' }),
  )
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        name !== 'ELECTRON_RUN_AS_NODE' && name !== 'ELECTRON_RENDERER_URL' && value !== undefined,
    ),
  ) as Record<string, string>
  const app = await electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron.exe'),
    args: [root],
    env: { ...environment, VPS_MANAGER_TEST_DATA: join(directory, 'data') },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Connect to your server' })).toBeVisible()
    const result = await page.evaluate(() => window.vps.invoke('app.bootstrap', {}))
    expect(
      result,
      JSON.stringify({
        actual: await app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.mainFrame.url,
        ),
        expected: pathToFileURL(join(root, 'out/renderer/index.html')).href,
      }),
    ).toMatchObject({ ok: true })
    await expect(page.getByRole('button', { name: 'Connect to server', exact: true })).toBeEnabled()
    await page.reload()
    expect(await page.evaluate(() => window.vps.invoke('app.bootstrap', {}))).toMatchObject({
      ok: true,
    })
  } finally {
    await app.close()
    // Remove the test junction first so cleanup never traverses the shared dependencies.
    await (await import('node:fs/promises')).unlink(join(root, 'node_modules'))
    await removeTestDirectory(directory, 'vps-origin-test-')
  }
})
