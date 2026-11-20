import { lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** Remove only a direct child created by this task's mkdtemp calls. */
export async function removeTestDirectory(directory: string, prefix: string): Promise<void> {
  const absolute = resolve(directory)
  const root = await realpath(tmpdir())
  if (
    (await realpath(dirname(absolute))) !== root ||
    !basename(absolute).startsWith(prefix) ||
    (await lstat(absolute)).isSymbolicLink()
  )
    throw new Error('Refused cleanup outside the named test temporary directory')
  await rm(absolute, { recursive: true, force: true })
}
