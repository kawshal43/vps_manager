import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTestDirectory } from '../../scripts/test-temp'

test('website IPC validates input, requires an authenticated session and preserves corrupt feature metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vps-websites-native-'))
  await writeFile(join(directory, 'websites.json'), 'CORRUPT WEBSITE METADATA')
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
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: 'Connect to server', exact: true })).toBeEnabled()
    expect(await page.evaluate(() => window.vps.invoke('app.bootstrap', {}))).toMatchObject({
      ok: true,
    })
    expect(
      await page.evaluate(() =>
        window.vps.invoke('websites.discover', {
          sessionId: '00000000-0000-4000-8000-000000000001',
          elevation: 'none',
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'NETWORK_ERROR' } })
    expect(
      await page.evaluate(() =>
        window.vps.invoke('websites.deploy', {
          sessionId: '00000000-0000-4000-8000-000000000001',
          token: '00000000-0000-4000-8000-000000000002',
          acknowledged: true,
          command: 'unsafe arbitrary command',
        } as never),
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(
      await page.evaluate(() =>
        window.vps.invoke('websites.prepare', {
          sessionId: '00000000-0000-4000-8000-000000000001',
          websiteId: '00000000-0000-4000-8000-000000000002',
          method: 'partial',
          source: { kind: 'remote', path: '/home/demo/../../etc' },
          paths: ['../escape'],
          elevation: 'none',
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(
      await page.evaluate(() =>
        window.vps.invoke('websites.restore', {
          sessionId: '00000000-0000-4000-8000-000000000001',
          websiteId: '00000000-0000-4000-8000-000000000002',
          historyId: '00000000-0000-4000-8000-000000000003',
          elevation: 'none',
          acknowledged: false,
        } as never),
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(await readFile(join(directory, 'websites.json'), 'utf8')).toBe(
      'CORRUPT WEBSITE METADATA',
    )
  } finally {
    await app.close()
    expect(await readFile(join(directory, 'websites.json'), 'utf8')).toBe(
      'CORRUPT WEBSITE METADATA',
    )
    await removeTestDirectory(directory, 'vps-websites-native-')
  }
})
