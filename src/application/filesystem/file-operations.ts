import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionManager } from '../connection/session-manager'
import { RemoteFs, identity, sameIdentity } from '../../infrastructure/sftp/remote-fs'
import { AppError } from '../../domain/errors/app-error'
import { quotePosix, validateName } from '../../domain/filesystem/policy'

export type Confirm = (title: string, message: string, detail: string) => Promise<boolean>
export class FileOperations {
  private busy = new Map<string, AbortController>()
  constructor(
    private sessions: SessionManager,
    private confirm: Confirm,
  ) {}
  fs(id: string): RemoteFs {
    return new RemoteFs(this.sessions.fs(id), [this.sessions.get(id).info.home])
  }
  cancel(id: string): void {
    this.busy.get(id)?.abort()
  }
  async exclusive<T>(id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.busy.has(id))
      throw new AppError(
        'FILE_CONFLICT',
        'Another file operation is in progress on this server.',
        'Wait for it to finish before retrying.',
      )
    const controller = new AbortController()
    this.busy.set(id, controller)
    try {
      return await operation(controller.signal)
    } finally {
      this.busy.delete(id)
    }
  }
  async create(
    id: string,
    directory: string,
    name: string,
    kind: 'file' | 'directory',
  ): Promise<void> {
    const path = posix.join(directory, validateName(name))
    const fs = this.fs(id)
    if (kind === 'directory') await fs.mkdir(path)
    else await fs.save(path, '', null)
  }
  async delete(id: string, paths: string[], signal?: AbortSignal): Promise<void> {
    const fs = this.fs(id)
    const targets = await Promise.all(
      paths.map(async (p) => {
        const path = await fs.mutationPath(p)
        return { path, attrs: identity(await fs.lstat(path)) }
      }),
    )
    if (
      !(await this.confirm(
        'Delete permanently',
        `Permanently delete ${paths.length} selected item${paths.length === 1 ? '' : 's'}?`,
        targets.map((t) => t.path).join('\n') +
          '\n\nFolders are removed recursively. Symbolic links are removed without following them. This cannot be undone.',
      ))
    )
      return
    for (const target of targets) {
      signal?.throwIfAborted()
      if (!sameIdentity(target.attrs, identity(await fs.lstat(target.path))))
        throw new AppError(
          'FILE_CONFLICT',
          'A selected entry changed while confirmation was open. Refresh and try again.',
        )
      await fs.remove(target.path, signal)
    }
  }
  async copy(
    id: string,
    paths: string[],
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const fs = this.fs(id)
    for (const source of paths) {
      signal?.throwIfAborted()
      const from = await fs
        .realpath(posix.dirname(source))
        .then((p) => posix.join(p, posix.basename(source)))
      if (from === '/') throw new AppError('INVALID_PATH', 'The filesystem root cannot be copied.')
      const to = await fs.mutationPath(posix.join(destination, posix.basename(source)))
      if (to === from || to.startsWith(from + '/'))
        throw new AppError('INVALID_PATH', 'A folder cannot be copied into itself.')
      if (await fs.exists(to))
        throw new AppError('FILE_CONFLICT', 'The copy destination already exists. Rename it first.')
      const temporary = posix.join(posix.dirname(to), `.vps-manager-copy-${randomUUID()}`)
      if (await fs.exists(temporary))
        throw new AppError('FILE_CONFLICT', 'Copy staging path already exists.')
      try {
        await this.sessions.exec(
          id,
          `cp -a --no-target-directory -- ${quotePosix(from)} ${quotePosix(temporary)}`,
          60000,
          signal,
        )
        signal?.throwIfAborted()
        await fs.rename(temporary, to)
      } finally {
        if (await fs.exists(temporary).catch(() => null)) await fs.remove(temporary).catch(() => {})
      }
    }
  }
  async chmod(id: string, path: string, mode: string): Promise<void> {
    if (
      await this.confirm(
        'Change permissions',
        `Set permissions to ${mode}?`,
        path + '\nOnly this entry will be changed. No recursive permission changes or elevation.',
      )
    )
      await this.fs(id).chmod(path, parseInt(mode, 8))
  }
}
