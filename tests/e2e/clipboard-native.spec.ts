import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTestDirectory } from '../../scripts/test-temp'
import { preserveClipboard, restoreClipboard } from './fixtures/clipboard'

test('native clipboard bridge transfers text and app fields offer a right-click edit menu', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vps-clipboard-native-'))
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
  await preserveClipboard(app)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: 'Connect to server', exact: true })).toBeEnabled()
    const text = 'Clipboard code: "quotes", café, 😀\nsecond line'
    expect(
      await page.evaluate(
        (value) => window.vps.invoke('clipboard.writeText', { text: value }),
        text,
      ),
    ).toMatchObject({ ok: true })
    expect(await app.evaluate(async ({ clipboard }) => clipboard.readText())).toBe(text)
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('Text from another app'))
    expect(await page.evaluate(() => window.vps.invoke('clipboard.readText', {}))).toEqual({
      ok: true,
      value: 'Text from another app',
    })
    expect(
      await page.evaluate(() => window.vps.invoke('clipboard.writeText', { text: 123 } as never)),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(
      await page.evaluate(() => window.vps.invoke('clipboard.readText', { extra: true } as never)),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

    await app.evaluate(({ Menu }) => {
      const build = Menu.buildFromTemplate
      Menu.buildFromTemplate = (template) => {
        const menu = build(template)
        // Inspect the real native menu without opening a blocking OS popup in CI.
        menu.popup = () => {
          Reflect.set(globalThis, '__clipboardMenu', template)
        }
        return menu
      }
    })
    const field = page.getByLabel('Server address', { exact: true })
    await field.fill('clipboard.example.test')
    await field.press('Control+a')
    await field.click({ button: 'right' })
    await expect
      .poll(async () => app.evaluate(() => Reflect.get(globalThis, '__clipboardMenu')))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'copy', enabled: true }),
          expect.objectContaining({ role: 'paste', enabled: true }),
        ]),
      )
  } finally {
    try {
      await restoreClipboard(app)
    } finally {
      await app.close()
      await removeTestDirectory(directory, 'vps-clipboard-native-')
    }
  }
})
