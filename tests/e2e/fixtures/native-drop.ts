import type { Page } from '@playwright/test'

/** Chromium creates real disk-backed Files, exercising Electron's native path bridge. */
export async function prepareDrop(page: Page, localFile: string) {
  await page.evaluate(() => {
    document.querySelector('#native-drop-source')?.remove()
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'native-drop-source'
    input.style.display = 'none'
    document.body.append(input)
  })
  await page.locator('#native-drop-source').setInputFiles(localFile)
}
export async function dropOn(page: Page, selector: string) {
  await page.evaluate((target) => {
    const input = document.querySelector<HTMLInputElement>('#native-drop-source')!
    const data = new DataTransfer()
    for (const file of input.files!) data.items.add(file)
    document
      .querySelector(target)!
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  }, selector)
}
