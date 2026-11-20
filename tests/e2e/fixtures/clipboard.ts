import type { ElectronApplication } from '@playwright/test'

export async function preserveClipboard(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    // Read items are immutable snapshots; writing requires newly constructed items.
    const previous = await Promise.all(
      (await clipboard.read()).map(async (item) => {
        const entries = await Promise.all(
          item.types.map(async (type) => [type, await item.getType(type)] as const),
        )
        return new ClipboardItem(Object.fromEntries(entries))
      }),
    )
    Reflect.set(globalThis, '__clipboardBeforeTest', previous)
  })
}

export async function restoreClipboard(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ clipboard }) => {
    const previous = Reflect.get(globalThis, '__clipboardBeforeTest') as Parameters<
      typeof clipboard.write
    >[0]
    if (previous.length) await clipboard.write(previous)
    else await clipboard.clear()
  })
}
