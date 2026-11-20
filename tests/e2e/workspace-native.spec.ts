import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultWorkspace } from '../../src/shared/workspace'
import { removeTestDirectory } from '../../scripts/test-temp'

test('native workspace bridge persists layout, rejects extra fields, and respects cancelled close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vps-workspace-native-'))
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
    await page.evaluate(() => window.vps.invoke('workspace.load', {}))
    const layout = { ...defaultWorkspace(), pinned: ['terminal' as const] }
    expect(
      await page.evaluate((p) => window.vps.invoke('workspace.save', p), layout),
    ).toMatchObject({ ok: true })
    expect(JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')).pinned).toEqual([
      'terminal',
    ])
    expect(
      await page.evaluate(() =>
        window.vps.invoke('workspace.save', {
          version: 1,
          pinned: [],
          windows: [],
          credentials: 'not allowed',
        } as never),
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    await page.reload()
    expect(await page.evaluate(() => window.vps.invoke('workspace.load', {}))).toMatchObject({
      ok: true,
      value: { layout: { pinned: ['terminal'] } },
    })
    expect(
      await page.evaluate(() => window.vps.invoke('app.editorState', { dirtyCount: 1 })),
    ).toMatchObject({ ok: true })
    await app.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBoxSync = (...args: unknown[]) => {
        const options = args.at(-1) as { message: string }
        Reflect.set(globalThis, '__closeMessage', options.message)
        return 0
      }
      BrowserWindow.getAllWindows()[0].close()
    })
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(await app.evaluate(() => Reflect.get(globalThis, '__closeMessage'))).toBe(
      'You have unsaved editor changes.',
    )
    await page.evaluate(() => window.vps.invoke('app.editorState', { dirtyCount: 0 }))
  } finally {
    await app.close()
    await removeTestDirectory(directory, 'vps-workspace-native-')
  }
})
