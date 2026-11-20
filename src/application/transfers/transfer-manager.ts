import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, readdir, mkdir, rename, unlink, statfs } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SessionManager } from '../connection/session-manager'
import { RemoteFs, identity, sameIdentity } from '../../infrastructure/sftp/remote-fs'
import { AppError, mapError } from '../../domain/errors/app-error'
import { validateWindowsName } from '../../domain/filesystem/policy'
import { canRetry, type TransferJob } from '../../domain/transfers/types'
import type { ConflictPolicy } from '../../domain/filesystem/types'
import type { AppEvent } from '../../shared/contracts/api'

interface Work {
  job: TransferJob
  controller: AbortController
  policy: ConflictPolicy
  running: boolean
}
export type ResolveConflict = (
  path: string,
) => Promise<{ policy: Exclude<ConflictPolicy, 'ask'> | 'cancel'; all: boolean }>
export class TransferManager {
  private work = new Map<string, Work>()
  private active = 0
  private concurrency = 2
  private planning = new Map<string, AbortController>()
  private batchPolicies = new Map<string, ConflictPolicy>()
  private resolving: Promise<unknown> = Promise.resolve()
  constructor(
    private sessions: SessionManager,
    private emit: (event: AppEvent) => void,
    private conflict: ResolveConflict,
  ) {}
  list(): TransferJob[] {
    return [...this.work.values()].map((w) => ({ ...w.job }))
  }
  setConcurrency(value: number): void {
    this.concurrency = Math.max(1, Math.min(4, value))
    this.pump()
  }
  cancel(id: string): void {
    const w = this.work.get(id)
    if (!w || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(w.job.status)) return
    w.controller.abort()
    if (!w.running) {
      w.job.status = 'CANCELLED'
      this.publish(w)
    }
  }
  cancelSession(id: string): void {
    this.planning.get(id)?.abort()
    for (const w of this.work.values()) if (w.job.sessionId === id) this.cancel(w.job.id)
  }
  cancelAll(): void {
    for (const controller of this.planning.values()) controller.abort()
    for (const id of this.work.keys()) this.cancel(id)
  }
  retry(id: string): void {
    const w = this.work.get(id)
    if (!w || !canRetry(w.job))
      throw new AppError('INVALID_REQUEST', 'This transfer cannot be retried.')
    this.sessions.get(w.job.sessionId)
    w.controller = new AbortController()
    w.job.status = 'QUEUED'
    w.job.transferred = 0
    w.job.speed = 0
    w.job.error = undefined
    w.job.retryCount++
    this.publish(w)
    this.pump()
  }
  get(id: string): TransferJob {
    const w = this.work.get(id)
    if (!w) throw new AppError('INVALID_REQUEST', 'Unknown transfer.')
    return w.job
  }
  private publish(w: Work): void {
    this.emit({ type: 'transfer', job: { ...w.job } })
  }
  private enqueue(
    sessionId: string,
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    size: number,
    policy: ConflictPolicy,
    batchId: string,
  ): void {
    if (this.work.size >= 10000)
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'The transfer queue limit is 10,000 files. Start a new session for additional files.',
      )
    const job: TransferJob = {
      id: randomUUID(),
      sessionId,
      batchId,
      direction,
      localPath,
      remotePath,
      size,
      status: 'QUEUED',
      transferred: 0,
      speed: 0,
      retryCount: 0,
    }
    const w: Work = { job, controller: new AbortController(), policy, running: false }
    this.work.set(job.id, w)
    this.publish(w)
  }
  private async plan(id: string, fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.planning.has(id))
      throw new AppError(
        'FILE_CONFLICT',
        'A transfer batch is already being prepared for this server.',
      )
    const controller = new AbortController()
    this.planning.set(id, controller)
    try {
      await fn(controller.signal)
    } finally {
      this.planning.delete(id)
      this.pump()
    }
  }
  async upload(
    id: string,
    localPaths: string[],
    destination: string,
    policy: ConflictPolicy,
  ): Promise<void> {
    const batchId = randomUUID()
    const fs = new RemoteFs(this.sessions.fs(id))
    const canonical = await fs.realpath(destination)
    await this.plan(id, async (signal) => {
      const visit = async (local: string, remote: string, depth: number): Promise<void> => {
        signal.throwIfAborted()
        if (depth > 100)
          throw new AppError('UNSUPPORTED_OPERATION', 'Folder nesting exceeds 100 levels.')
        const attrs = await lstat(local)
        if (attrs.isSymbolicLink())
          throw new AppError(
            'UNSUPPORTED_OPERATION',
            'Local symbolic links and junctions are not uploaded.',
            'Select regular files or directories.',
          )
        if (attrs.isDirectory()) {
          await fs.ensureDirectory(remote)
          for (const child of await readdir(local))
            await visit(join(local, child), posix.join(remote, child), depth + 1)
        } else if (attrs.isFile())
          this.enqueue(id, 'upload', local, remote, attrs.size, policy, batchId)
        else
          throw new AppError(
            'UNSUPPORTED_OPERATION',
            'Only regular files and folders can be uploaded.',
          )
      }
      for (const local of localPaths) await visit(local, posix.join(canonical, basename(local)), 0)
    })
  }
  async download(
    id: string,
    remotePaths: string[],
    destination: string,
    policy: ConflictPolicy,
  ): Promise<void> {
    const batchId = randomUUID()
    const fs = new RemoteFs(this.sessions.fs(id))
    await this.plan(id, async (signal) => {
      const root = resolve(destination)
      const visit = async (remote: string, localParent: string, depth: number): Promise<void> => {
        signal.throwIfAborted()
        if (depth > 100)
          throw new AppError('UNSUPPORTED_OPERATION', 'Folder nesting exceeds 100 levels.')
        const name = posix.basename(remote)
        validateWindowsName(name)
        const local = resolve(localParent, name)
        if (!local.startsWith(root + '\\') && !local.startsWith(root + '/'))
          throw new AppError('INVALID_PATH', 'A download path escaped the selected destination.')
        const attrs = await fs.lstat(remote)
        if (attrs.isSymbolicLink())
          throw new AppError(
            'UNSUPPORTED_OPERATION',
            'Symbolic links are not followed when downloading folders.',
            'Select the target explicitly if it is trusted.',
          )
        const existing = await lstat(local).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return null
          throw e
        })
        if (existing?.isSymbolicLink())
          throw new AppError(
            'INVALID_PATH',
            'The local destination contains a symbolic link or junction.',
          )
        if (attrs.isDirectory()) {
          if (existing && !existing.isDirectory())
            throw new AppError(
              'FILE_CONFLICT',
              'A file already occupies the local folder destination.',
            )
          await mkdir(local, { recursive: true })
          for (const child of (await fs.list(remote)).entries)
            await visit(child.path, local, depth + 1)
        } else if (attrs.isFile())
          this.enqueue(id, 'download', local, remote, attrs.size, policy, batchId)
        else
          throw new AppError(
            'UNSUPPORTED_OPERATION',
            'Only regular remote files can be downloaded.',
          )
      }
      for (const path of remotePaths) await visit(path, root, 0)
    })
  }
  private pump(): void {
    for (const w of this.work.values()) {
      if (this.active >= this.concurrency) return
      if (w.job.status !== 'QUEUED' || this.planning.has(w.job.sessionId)) continue
      w.running = true
      this.active++
      void this.run(w).finally(() => {
        w.running = false
        this.active--
        this.pump()
      })
    }
  }
  private resolveConflict(w: Work, path: string): Promise<Exclude<ConflictPolicy, 'ask'>> {
    const answer = this.resolving
      .catch(() => {})
      .then(async () => {
        w.controller.signal.throwIfAborted()
        const inherited = this.batchPolicies.get(w.job.batchId)
        if (inherited && inherited !== 'ask') return inherited
        const decision = await this.conflict(path)
        if (decision.policy === 'cancel') {
          for (const other of this.work.values())
            if (other.job.batchId === w.job.batchId) this.cancel(other.job.id)
          throw new AppError('CANCELLED', 'Transfer batch cancelled.')
        }
        if (decision.all) this.batchPolicies.set(w.job.batchId, decision.policy)
        return decision.policy
      })
    this.resolving = answer
    return answer
  }
  private async run(w: Work): Promise<void> {
    const j = w.job
    const signal = w.controller.signal
    j.startedAt = Date.now()
    j.completedAt = undefined
    let lastEvent = 0
    const progress = (bytes: number): void => {
      j.transferred = bytes
      j.speed = bytes / Math.max(0.001, (Date.now() - j.startedAt!) / 1000)
      if (Date.now() - lastEvent > 120) {
        lastEvent = Date.now()
        this.publish(w)
      }
    }
    try {
      signal.throwIfAborted()
      j.status = 'VALIDATING'
      this.publish(w)
      const fs = new RemoteFs(this.sessions.fs(j.sessionId))
      const originalRemote = j.remotePath
      const originalLocal = j.localPath
      const currentRemote = await fs.exists(j.remotePath)
      const currentLocal = await lstat(j.localPath).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null
        throw e
      })
      const exists = j.direction === 'upload' ? currentRemote : currentLocal
      let policy = this.batchPolicies.get(j.batchId) ?? w.policy
      if (exists) {
        if (
          (j.direction === 'upload' && currentRemote?.isSymbolicLink()) ||
          (j.direction === 'download' && currentLocal?.isSymbolicLink())
        )
          throw new AppError('FILE_CONFLICT', 'Replacing symbolic links is blocked.')
        if (policy === 'ask') {
          policy = await this.resolveConflict(
            w,
            j.direction === 'upload' ? j.remotePath : j.localPath,
          )
        }
        if (policy === 'skip') {
          j.status = 'CANCELLED'
          j.error = 'Skipped by conflict policy.'
          this.publish(w)
          return
        }
        if (policy === 'keep-both') {
          const base = j.direction === 'upload' ? j.remotePath : j.localPath
          let n = 1
          for (;;) {
            const candidate = `${base}.copy-${n++}`
            const occupied =
              j.direction === 'upload'
                ? await fs.exists(candidate)
                : await lstat(candidate).catch((e: NodeJS.ErrnoException) => {
                    if (e.code === 'ENOENT') return null
                    throw e
                  })
            if (!occupied) {
              if (j.direction === 'upload') j.remotePath = candidate
              else j.localPath = candidate
              break
            }
            if (n > 10000)
              throw new AppError('FILE_CONFLICT', 'Could not allocate a unique filename.')
          }
        }
      }
      signal.throwIfAborted()
      j.status = 'PREPARING'
      this.publish(w)
      if (j.direction === 'upload') {
        if (!currentLocal?.isFile() || currentLocal.isSymbolicLink())
          throw new AppError('FILE_NOT_FOUND', 'The upload source is no longer a regular file.')
        j.size = currentLocal.size
        const expected =
          exists && policy === 'replace' && j.remotePath === originalRemote
            ? identity(currentRemote!)
            : null
        if (expected && !currentRemote!.isFile())
          throw new AppError('FILE_CONFLICT', 'A folder cannot be replaced with a file.')
        j.status = 'TRANSFERRING'
        this.publish(w)
        const stream = createReadStream(j.localPath)
        // Detect source changes before finalizing the remote temporary file.
        const sourceCheck = new Transform({
          transform(chunk, _enc, cb) {
            cb(null, chunk)
          },
          flush(cb) {
            void lstat(j.localPath).then((now) => {
              if (now.size !== currentLocal.size || now.mtimeMs !== currentLocal.mtimeMs)
                cb(new AppError('FILE_CONFLICT', 'The local source changed during upload.'))
              else cb()
            }, cb)
          },
        })
        stream.on('error', (error) => sourceCheck.destroy(error))
        sourceCheck.on('close', () => stream.destroy())
        stream.pipe(sourceCheck)
        await fs.writeAtomic(j.remotePath, sourceCheck, j.size, expected, signal, progress)
      } else {
        if (!currentRemote?.isFile() || currentRemote.isSymbolicLink())
          throw new AppError('UNSUPPORTED_OPERATION', 'The remote source is not a regular file.')
        j.size = currentRemote.size
        const space = await statfs(dirname(j.localPath))
        if (space.bavail * space.bsize < j.size)
          throw new AppError('DISK_FULL', 'There is insufficient space for this download.')
        const temporary = join(dirname(j.localPath), `.vps-manager-${randomUUID()}.part`)
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            progress(j.transferred + chunk.length)
            cb(null, chunk)
          },
        })
        try {
          j.status = 'TRANSFERRING'
          this.publish(w)
          await pipeline(
            fs.readStream(j.remotePath, signal),
            counter,
            createWriteStream(temporary, { flags: 'wx' }),
            { signal },
          )
          j.status = 'VERIFYING'
          this.publish(w)
          if (
            j.transferred !== j.size ||
            !sameIdentity(identity(currentRemote), identity(await fs.lstat(j.remotePath)))
          )
            throw new AppError('FILE_CONFLICT', 'The remote file changed during download.')
          const now = await lstat(j.localPath).catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null
            throw e
          })
          if (j.localPath === originalLocal && currentLocal && policy === 'replace') {
            if (
              !now ||
              now.isSymbolicLink() ||
              now.size !== currentLocal.size ||
              now.mtimeMs !== currentLocal.mtimeMs
            )
              throw new AppError('FILE_CONFLICT', 'The local destination changed during download.')
          } else if (now)
            throw new AppError('FILE_CONFLICT', 'The local destination appeared during download.')
          signal.throwIfAborted()
          await rename(temporary, j.localPath)
        } finally {
          await unlink(temporary).catch(() => {})
        }
      }
      j.status = 'VERIFYING'
      this.publish(w)
      j.status = 'COMPLETED'
      j.completedAt = Date.now()
      this.publish(w)
    } catch (error) {
      const e = mapError(error, 'transfer')
      j.status = signal.aborted || e.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED'
      j.error = e.message
      j.completedAt = Date.now()
      this.publish(w)
    }
  }
}
