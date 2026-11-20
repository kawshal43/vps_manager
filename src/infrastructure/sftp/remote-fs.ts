import { posix } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper, Stats, FileEntryWithStats } from 'ssh2'
import { AppError } from '../../domain/errors/app-error'
import { assertMutable, validateName, validatePath } from '../../domain/filesystem/policy'
import type { FileIdentity, RemoteFile, TextDocument } from '../../domain/filesystem/types'

export function sftpCall<T>(
  start: (cb: (err: Error | null | undefined, value: T) => void) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new AppError(
          'TRANSFER_INTERRUPTED',
          'The SSH/SFTP connection closed or the operation was cancelled.',
        ),
      )
      return
    }
    let finished = false
    const finish = (err: Error | null | undefined, value?: T): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (err) reject(err)
      else resolve(value as T)
    }
    const abort = (): void =>
      finish(
        new AppError(
          'TRANSFER_INTERRUPTED',
          'The SSH/SFTP connection closed or the operation was cancelled.',
        ),
      )
    const timer = setTimeout(
      () =>
        finish(
          new AppError(
            'OPERATION_TIMEOUT',
            'The SFTP operation timed out.',
            'Refresh the server state before retrying.',
            true,
          ),
        ),
      30000,
    )
    signal?.addEventListener('abort', abort, { once: true })
    try {
      start((err, value) => {
        finish(err, value)
      })
    } catch (error) {
      finish(error as Error)
    }
  })
}
const lifetimes = new WeakMap<SFTPWrapper, AbortSignal>()
export function bindSftpLifetime(sftp: SFTPWrapper, sessionSignal: AbortSignal): void {
  const channel = new AbortController()
  sftp.once('close', () => channel.abort())
  sftp.once('end', () => channel.abort())
  lifetimes.set(sftp, AbortSignal.any([channel.signal, sessionSignal]))
}
export function identity(s: Stats): FileIdentity {
  return { size: s.size, mtime: s.mtime, mode: s.mode, uid: s.uid, gid: s.gid }
}
export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid
  )
}
function entry(path: string, attrs: Stats): RemoteFile {
  return {
    name: posix.basename(path),
    path,
    ...identity(attrs),
    type: attrs.isSymbolicLink()
      ? 'symlink'
      : attrs.isDirectory()
        ? 'directory'
        : attrs.isFile()
          ? 'file'
          : 'other',
  }
}
export class RemoteFs {
  private get signal(): AbortSignal | undefined {
    return lifetimes.get(this.sftp)
  }
  private call<T>(
    start: (cb: (err: Error | null | undefined, value: T) => void) => void,
    signal = this.signal,
  ): Promise<T> {
    return sftpCall(start, signal)
  }
  private done(start: (cb: (err?: Error | null) => void) => void): Promise<void> {
    return this.call<void>((cb) => start((e) => cb(e, undefined)))
  }
  private async closeHandle(handle: Buffer): Promise<void> {
    if (!this.signal?.aborted) await this.done((cb) => this.sftp.close(handle, cb))
  }
  readStream(path: string, operationSignal?: AbortSignal): Readable {
    const signal =
      operationSignal && this.signal
        ? AbortSignal.any([operationSignal, this.signal])
        : (operationSignal ?? this.signal)
    return Readable.from(this.chunks(path, signal), { objectMode: false, highWaterMark: 131072 })
  }
  private async *chunks(path: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const handle = await this.call<Buffer>(
      (cb) => this.sftp.open(validatePath(path), 'r', cb),
      signal,
    )
    let position = 0
    try {
      for (;;) {
        signal?.throwIfAborted()
        const buffer = Buffer.allocUnsafe(65536)
        const count = await this.call<number>(
          (cb) =>
            this.sftp.read(handle, buffer, 0, buffer.length, position, (error, bytes) =>
              cb(error, bytes),
            ),
          signal,
        )
        if (!count) break
        position += count
        yield buffer.subarray(0, count)
      }
    } finally {
      await this.closeHandle(handle).catch(() => {})
    }
  }
  constructor(
    public sftp: SFTPWrapper,
    private protectedRoots: string[] = [],
  ) {}
  lstat(path: string): Promise<Stats> {
    return this.call((cb) => this.sftp.lstat(validatePath(path), cb))
  }
  realpath(path: string): Promise<string> {
    return this.call((cb) => this.sftp.realpath(validatePath(path), cb))
  }
  async exists(path: string): Promise<Stats | null> {
    try {
      return await this.lstat(path)
    } catch (error) {
      if ((error as { code?: number }).code === 2) return null
      throw error
    }
  }
  async list(path: string): Promise<{ path: string; entries: RemoteFile[] }> {
    const canonical = await this.realpath(path)
    const files = await this.call<FileEntryWithStats[]>((cb) => this.sftp.readdir(canonical, cb))
    return {
      path: canonical,
      entries: files
        .filter((f) => f.filename !== '.' && f.filename !== '..')
        .map((f) => entry(posix.join(canonical, f.filename), f.attrs)),
    }
  }
  async stat(path: string): Promise<RemoteFile> {
    return entry(path, await this.lstat(path))
  }
  async mutationPath(path: string): Promise<string> {
    const clean = validatePath(path)
    assertMutable(clean)
    const parent = await this.realpath(posix.dirname(clean))
    const canonical = posix.join(parent, validateName(posix.basename(clean)))
    assertMutable(canonical)
    if (this.protectedRoots.includes(clean) || this.protectedRoots.includes(canonical))
      throw new AppError(
        'PERMISSION_DENIED',
        'The account’s home directory itself is protected.',
        'Manage entries inside the home directory instead.',
      )
    return canonical
  }
  async mkdir(path: string): Promise<void> {
    const safe = await this.mutationPath(path)
    if (await this.exists(safe))
      throw new AppError('FILE_CONFLICT', 'The destination already exists.')
    await this.done((cb) => this.sftp.mkdir(safe, { mode: 0o755 }, cb))
  }
  async ensureDirectory(path: string): Promise<void> {
    const current = await this.exists(path)
    if (current) {
      if (current.isSymbolicLink() || !current.isDirectory())
        throw new AppError(
          'FILE_CONFLICT',
          'The destination folder is a symbolic link or another entry type.',
        )
      return
    }
    await this.ensureDirectory(posix.dirname(path))
    await this.mkdir(path)
  }
  async rename(source: string, destination: string): Promise<void> {
    const from = await this.mutationPath(source)
    const to = await this.mutationPath(destination)
    if (from === to) throw new AppError('FILE_CONFLICT', 'Source and destination are the same.')
    const before = identity(await this.lstat(from))
    if (await this.exists(to))
      throw new AppError(
        'FILE_CONFLICT',
        'The destination already exists. No file was overwritten.',
      )
    if (!sameIdentity(before, identity(await this.lstat(from))))
      throw new AppError('FILE_CONFLICT', 'The source changed. Refresh before retrying.')
    await this.done((cb) => this.sftp.rename(from, to, cb))
    if ((await this.exists(from)) || !(await this.exists(to)))
      throw new AppError('SFTP_ERROR', 'The rename result could not be verified.')
  }
  async remove(path: string, signal?: AbortSignal, depth = 0): Promise<void> {
    signal?.throwIfAborted()
    if (depth > 100)
      throw new AppError('UNSUPPORTED_OPERATION', 'The folder nesting exceeds the safety limit.')
    const safe = await this.mutationPath(path)
    const attrs = await this.lstat(safe)
    if (attrs.isDirectory() && !attrs.isSymbolicLink()) {
      // Re-resolve each child parent and lstat each node. Never recurse into a symlink.
      const canonical = await this.realpath(safe)
      assertMutable(canonical)
      if (canonical !== safe)
        throw new AppError('FILE_CONFLICT', 'The folder became a symbolic link. Deletion stopped.')
      const { entries } = await this.list(safe)
      for (const child of entries) await this.remove(child.path, signal, depth + 1)
      const now = await this.lstat(safe)
      if (!now.isDirectory() || now.isSymbolicLink() || (await this.realpath(safe)) !== safe)
        throw new AppError('FILE_CONFLICT', 'The directory changed during deletion.')
      await this.done((cb) => this.sftp.rmdir(safe, cb))
    } else await this.done((cb) => this.sftp.unlink(safe, cb))
    if (await this.exists(safe)) throw new AppError('SFTP_ERROR', 'Deletion could not be verified.')
  }
  async chmod(path: string, mode: number): Promise<void> {
    const safe = await this.mutationPath(path)
    const attrs = await this.lstat(safe)
    if (attrs.isSymbolicLink())
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Permission changes on symbolic links are blocked.',
      )
    await this.done((cb) => this.sftp.chmod(safe, mode, cb))
    if (((await this.lstat(safe)).mode & 0o777) !== mode)
      throw new AppError('SFTP_ERROR', 'The permission change could not be verified.')
  }
  async text(path: string): Promise<TextDocument> {
    const attrs = await this.lstat(path)
    if (!attrs.isFile() || attrs.isSymbolicLink())
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Only regular text files can be edited. Download other entry types instead.',
      )
    if (attrs.size > 2 * 1024 * 1024)
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'The editor supports files up to 2 MiB.',
        'Download this file to edit it locally.',
      )
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of this.readStream(path)) {
      bytes += chunk.length
      if (bytes > 2 * 1024 * 1024)
        throw new AppError('UNSUPPORTED_OPERATION', 'The file grew beyond the editor limit.')
      chunks.push(Buffer.from(chunk))
    }
    const data = Buffer.concat(chunks)
    if (data.includes(0))
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'This appears to be a binary file.',
        'Download it instead.',
      )
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
    } catch {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'This file is not valid UTF-8.',
        'Download it to edit with the appropriate encoding.',
      )
    }
    if (!sameIdentity(identity(attrs), identity(await this.lstat(path))))
      throw new AppError('FILE_CONFLICT', 'The file changed while it was being read. Retry.')
    return {
      path,
      content,
      identity: { ...identity(attrs), hash: createHash('sha256').update(data).digest('hex') },
      lineEnding: content.includes('\r\n') ? 'CRLF' : 'LF',
      bom: content.startsWith('\uFEFF'),
    }
  }
  async save(path: string, content: string, expected: FileIdentity | null): Promise<TextDocument> {
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024)
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'The UTF-8 content exceeds the editor’s 2 MiB limit.',
      )
    const safe = await this.mutationPath(path)
    if (expected) {
      const current = await this.text(safe)
      if (!sameIdentity(expected, current.identity) || expected.hash !== current.identity.hash)
        throw new AppError(
          'FILE_CONFLICT',
          'The server file changed since you opened it.',
          'Reload the server version or use Save As to preserve your edits.',
        )
    } else if (await this.exists(safe))
      throw new AppError(
        'FILE_CONFLICT',
        'Save As requires a new path. The destination already exists.',
      )
    const data = Buffer.from(content, 'utf8')
    await this.writeAtomic(safe, Readable.from([data]), data.length, expected)
    return this.text(safe)
  }
  async writeAtomic(
    path: string,
    source: Readable,
    size: number,
    expected: FileIdentity | null,
    signal?: AbortSignal,
    progress?: (bytes: number) => void,
  ): Promise<void> {
    const safe = await this.mutationPath(path)
    const temp = posix.join(posix.dirname(safe), `.vps-manager-${randomUUID()}.part`)
    const combinedSignal =
      signal && this.signal ? AbortSignal.any([signal, this.signal]) : (signal ?? this.signal)
    if (expected && expected.mode & 0o7000)
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Replacement of files with special Unix permission bits is blocked.',
        'Use Terminal for deliberate administration of this file.',
      )
    let written = 0
    let handle: Buffer | undefined
    let position = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, cb) {
        written += chunk.length
        progress?.(written)
        cb(null, chunk)
      },
    })
    try {
      handle = await this.call<Buffer>(
        (cb) => this.sftp.open(temp, 'wx', { mode: expected ? expected.mode & 0o777 : 0o644 }, cb),
        combinedSignal,
      )
      const destination = new Writable({
        highWaterMark: 65536,
        write: (chunk: Buffer, _encoding, cb) => {
          const offset = position
          position += chunk.length
          void this.call<void>(
            (done) =>
              this.sftp.write(handle!, chunk, 0, chunk.length, offset, (error) =>
                done(error, undefined),
              ),
            combinedSignal,
          ).then(() => cb(), cb)
        },
      })
      await pipeline(source, counter, destination, { signal: combinedSignal })
      await this.closeHandle(handle)
      handle = undefined
      combinedSignal?.throwIfAborted()
      const uploaded = await this.lstat(temp)
      if (written !== size || uploaded.size !== size)
        throw new AppError('TRANSFER_INTERRUPTED', 'Uploaded byte count did not match the source.')
      const current = await this.exists(safe)
      if (expected) {
        if (!current || current.isSymbolicLink() || !sameIdentity(expected, identity(current)))
          throw new AppError(
            'FILE_CONFLICT',
            'The destination changed during upload. The original file has been preserved.',
          )
        if (expected.hash) {
          const actual = await this.text(safe)
          if (actual.identity.hash !== expected.hash)
            throw new AppError('FILE_CONFLICT', 'The server content changed. Save was cancelled.')
        }
        if (uploaded.uid !== expected.uid || uploaded.gid !== expected.gid) {
          await this.done((cb) => this.sftp.chown(temp, expected.uid, expected.gid, cb))
        }
        await this.done((cb) => this.sftp.chmod(temp, expected.mode & 0o777, cb))
        try {
          await this.done((cb) => this.sftp.ext_openssh_rename(temp, safe, cb))
        } catch (error) {
          if (
            (error as { code?: number }).code === 8 ||
            (error as Error).message?.includes('support')
          )
            throw new AppError(
              'UNSUPPORTED_OPERATION',
              'The server does not support atomic replacement. The original file was preserved.',
              'Use Keep both or perform a deliberate replacement in Terminal.',
            )
          throw error
        }
      } else {
        if (current)
          throw new AppError(
            'FILE_CONFLICT',
            'The destination appeared during upload. It was not overwritten.',
          )
        await this.done((cb) => this.sftp.rename(temp, safe, cb))
      }
      if ((await this.lstat(safe)).size !== size)
        throw new AppError('TRANSFER_INTERRUPTED', 'Final file size verification failed.')
    } finally {
      source.destroy()
      if (handle) await this.closeHandle(handle).catch(() => {})
      await this.done((cb) => this.sftp.unlink(temp, cb)).catch(() => {})
    }
  }
}
