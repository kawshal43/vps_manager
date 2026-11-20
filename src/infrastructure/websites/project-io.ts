import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, readdir, mkdir, mkdtemp, realpath, rm, statfs } from 'node:fs/promises'
import { join, resolve, sep, posix, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'
import type { SessionManager } from '../../application/connection/session-manager'
import { RemoteFs, sftpCall } from '../sftp/remote-fs'
import { AppError } from '../../domain/errors/app-error'
import { validateWindowsName } from '../../domain/filesystem/policy'
import { childPath, isProtected, MAX_BYTES, MAX_FILES } from '../../domain/websites/policy'
import { relativeWebsitePath, type FileEntry } from '../../domain/websites/types'

export interface ProjectSource {
  kind: 'local' | 'remote'
  root: string
  temporary?: string
}
export interface Manifest {
  files: FileEntry[]
  skipped: string[]
  bytes: number
}
async function streamHash(source: Readable): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of source) hash.update(chunk)
  return hash.digest('hex')
}
export async function cleanSource(path?: string): Promise<void> {
  if (!path) return
  const safe = resolve(path)
  if (
    !safe.startsWith(resolve(tmpdir()) + sep) ||
    !basename(safe).startsWith('vps-websites-source-')
  )
    throw new AppError(
      'INVALID_PATH',
      'Refusing to remove a directory outside the source staging area.',
    )
  await rm(safe, { recursive: true, force: true })
}
export async function unzipSource(path: string): Promise<ProjectSource> {
  const directory = await mkdtemp(join(tmpdir(), 'vps-websites-source-'))
  try {
    const space = await statfs(directory),
      available = Number(space.bavail) * Number(space.bsize) - 50 * 1024 ** 2
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, value) =>
        error ? reject(error) : resolve(value!),
      ),
    )
    let count = 0,
      bytes = 0
    const seen = new Set<string>()
    const spellings = new Map<string, string>()
    await new Promise<void>((resolveZip, reject) => {
      let failed = false
      const fail = (error: unknown) => {
        if (!failed) {
          failed = true
          zip.close()
          reject(error)
        }
      }
      zip.on('error', fail)
      zip.on('end', () => resolveZip())
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          const name = entry.fileName.replace(/\/$/, '')
          relativeWebsitePath.parse(name)
          name.split('/').forEach(validateWindowsName)
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff
          const type = mode & 0o170000
          if (
            (type && type !== 0o100000 && type !== 0o040000) ||
            ++count > MAX_FILES ||
            (bytes += entry.uncompressedSize) > Math.min(MAX_BYTES, available)
          )
            throw new AppError(
              'UNSUPPORTED_OPERATION',
              'ZIP files must contain regular files/directories within the 10,000-entry / 2 GiB limit and fit available temporary storage.',
            )
          if (seen.has(name.toLowerCase()))
            throw new AppError('INVALID_PATH', 'ZIP contains duplicate or case-colliding paths.')
          seen.add(name.toLowerCase())
          const parts = name.split('/')
          for (let i = 1; i <= parts.length; i++) {
            const prefix = parts.slice(0, i).join('/'),
              key = prefix.toLowerCase(),
              previous = spellings.get(key)
            if (previous && previous !== prefix)
              throw new AppError('INVALID_PATH', 'ZIP contains case-colliding directory paths.')
            spellings.set(key, prefix)
          }
          if (!isProtected(name)) {
            const destination = resolve(directory, ...name.split('/'))
            if (!destination.startsWith(resolve(directory) + sep))
              throw new AppError('INVALID_PATH', 'ZIP entry escaped its staging folder.')
            if (entry.fileName.endsWith('/')) await mkdir(destination, { recursive: true })
            else {
              await mkdir(resolve(destination, '..'), { recursive: true })
              const source = await new Promise<Readable>((res, rej) =>
                zip.openReadStream(entry, (error, stream) => (error ? rej(error) : res(stream!))),
              )
              await pipeline(source, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
            }
          }
          if (!failed) zip.readEntry()
        })().catch(fail)
      })
      zip.readEntry()
    })
    const roots = await readdir(directory)
    const root =
      roots.length === 1 && (await lstat(join(directory, roots[0]))).isDirectory()
        ? join(directory, roots[0])
        : directory
    return { kind: 'local', root, temporary: directory }
  } catch (error) {
    await cleanSource(directory)
    throw error
  }
}
export class ProjectIO {
  constructor(private sessions: SessionManager) {}
  fs(sessionId: string): RemoteFs {
    return new RemoteFs(this.sessions.fs(sessionId), [this.sessions.get(sessionId).info.home])
  }
  async manifest(
    sessionId: string,
    source: ProjectSource,
    protectedPaths: string[],
    signal?: AbortSignal,
  ): Promise<Manifest> {
    const files: FileEntry[] = [],
      skipped: string[] = []
    let bytes = 0,
      count = 0
    const remote = source.kind === 'remote' ? this.fs(sessionId) : undefined
    const canonical = remote ? await remote.realpath(source.root) : await realpath(source.root)
    if (remote ? canonical !== source.root : (await lstat(source.root)).isSymbolicLink())
      throw new AppError(
        'INVALID_PATH',
        'Select a canonical directory, not a symbolic link or junction.',
      )
    if (!remote) source.root = canonical
    const walk = async (relative: string, depth: number): Promise<void> => {
      signal?.throwIfAborted()
      if (++count > MAX_FILES || depth > 64)
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Source exceeds 10,000 entries or 64 directory levels.',
        )
      if (relative && isProtected(relative, protectedPaths)) {
        skipped.push(relative)
        return
      }
      const path = relative
        ? remote
          ? childPath(source.root, relative)
          : join(source.root, ...relative.split('/'))
        : source.root
      const attrs = remote ? await remote.lstat(path) : await lstat(path)
      if (attrs.isSymbolicLink())
        throw new AppError(
          'INVALID_PATH',
          'Source contains a symbolic link or junction. Select regular source files.',
        )
      if (attrs.isDirectory()) {
        const actual = remote ? await remote.realpath(path) : await realpath(path)
        if (
          remote ? actual !== path : resolve(actual).toLowerCase() !== resolve(path).toLowerCase()
        )
          throw new AppError('INVALID_PATH', 'A source parent became a symbolic link.')
        const names = remote
          ? (await remote.list(path)).entries.map((e) => e.name)
          : await readdir(path)
        for (const name of names.sort())
          await walk(relative ? `${relative}/${name}` : name, depth + 1)
      } else if (attrs.isFile()) {
        if ((bytes += attrs.size) > MAX_BYTES)
          throw new AppError('UNSUPPORTED_OPERATION', 'Source exceeds the 2 GiB deployment limit.')
        const hash = await streamHash(
          remote ? remote.readStream(path, signal) : createReadStream(path, { signal }),
        )
        files.push({ path: relative, hash, size: attrs.size, mode: attrs.mode & 0o777 })
      } else
        throw new AppError('UNSUPPORTED_OPERATION', 'Source contains a device or special file.')
    }
    await walk('', 0)
    return { files, skipped, bytes }
  }
  async copy(
    sessionId: string,
    source: ProjectSource,
    files: FileEntry[],
    destination: string,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<void> {
    const fs = this.fs(sessionId)
    for (const file of files) {
      signal.throwIfAborted()
      const target = childPath(destination, file.path)
      await fs.ensureDirectory(posix.dirname(target))
      const path =
        source.kind === 'remote'
          ? childPath(source.root, file.path)
          : join(source.root, ...file.path.split('/'))
      const attrs = source.kind === 'remote' ? await fs.lstat(path) : await lstat(path)
      if (!attrs.isFile() || attrs.isSymbolicLink() || attrs.size !== file.size)
        throw new AppError('FILE_CONFLICT', 'The source changed after preview.')
      const actual = source.kind === 'remote' ? await fs.realpath(path) : await realpath(path)
      if (
        source.kind === 'remote'
          ? actual !== path
          : resolve(actual).toLowerCase() !== resolve(path).toLowerCase()
      )
        throw new AppError('INVALID_PATH', 'A source parent became a symbolic link before upload.')
      const input =
        source.kind === 'remote' ? fs.readStream(path, signal) : createReadStream(path, { signal })
      const hash = createHash('sha256')
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk)
          progress(chunk.length)
          callback(null, chunk)
        },
      })
      input.on('error', (error) => verify.destroy(error))
      const expected = await fs.exists(target)
      try {
        await fs.writeAtomic(
          target,
          input.pipe(verify),
          file.size,
          expected
            ? {
                size: expected.size,
                mode: expected.mode,
                uid: expected.uid,
                gid: expected.gid,
                mtime: expected.mtime,
              }
            : null,
          signal,
        )
      } finally {
        input.destroy()
      }
      if (
        hash.digest('hex') !== file.hash ||
        (await streamHash(fs.readStream(target, signal))) !== file.hash
      )
        throw new AppError(
          'TRANSFER_INTERRUPTED',
          'Source or uploaded content failed SHA-256 verification. Activation was stopped.',
        )
      await sftpCall<void>(
        (cb) => fs.sftp.chmod(target, file.mode & 0o755 || 0o644, (e) => cb(e, undefined)),
        signal,
      )
    }
  }
  async writeJson(sessionId: string, path: string, value: unknown): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(value, null, 2))
    await this.fs(sessionId).writeAtomic(path, Readable.from([buffer]), buffer.length, null)
  }
}
