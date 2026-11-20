import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTestDirectory } from '../../scripts/test-temp'

test('development renderer starts with the secure desktop bridge', async () => {
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const { default: tailwindcss } = await import('@tailwindcss/vite')
  const server = await createServer({
    configFile: false,
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const directory = await mkdtemp(join(tmpdir(), 'vps-dev-test-'))
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => name !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>
  const app = await electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron.exe'),
    args: [resolve('.')],
    env: {
      ...environment,
      VPS_MANAGER_TEST_DATA: directory,
      // electron-vite sets this without a trailing slash; Chromium adds it.
      ELECTRON_RENDERER_URL: server.resolvedUrls!.local[0].replace(/\/$/, ''),
    },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Connect to your server' })).toBeVisible()
    expect(await page.evaluate(async () => (await window.vps.invoke('app.bootstrap', {})).ok)).toBe(
      true,
    )
    await expect(page.getByRole('button', { name: 'Connect to server', exact: true })).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.reload()
    expect(await page.evaluate(async () => (await window.vps.invoke('app.bootstrap', {})).ok)).toBe(
      true,
    )
  } finally {
    await app.close()
    await server.close()
    await removeTestDirectory(directory, 'vps-dev-test-')
  }
})
