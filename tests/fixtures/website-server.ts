import { Readable } from 'node:stream'
import { posix } from 'node:path'
import { vi } from 'vitest'
import { AppError } from '../../src/domain/errors/app-error'
import { hash } from '../../src/domain/websites/policy'
import type { WebsiteInput } from '../../src/domain/websites/types'
import type { SessionManager } from '../../src/application/connection/session-manager'
import type { RemoteFs } from '../../src/infrastructure/sftp/remote-fs'
import type { ComposeModel } from '../../src/infrastructure/websites/compose'

interface Node {
  kind: 'file' | 'dir' | 'link'
  data: Buffer
  mode: number
  target?: string
}
export const firstSession = '00000000-0000-4000-8000-000000000001'
export const secondSession = '00000000-0000-4000-8000-000000000002'
export const oldImage = `sha256:${'a'.repeat(64)}`
export const newImage = `sha256:${'b'.repeat(64)}`
export const websiteConfig = (strategy: 'compose' | 'static' = 'compose'): WebsiteInput => ({
  name: 'Example website',
  domain: 'example.test',
  projectPath: '/home/demo/project',
  strategy,
  healthUrl: 'http://127.0.0.1:3000/health',
  publicUrl: 'https://example.test/',
  healthTimeoutSeconds: 10,
  protectedPaths: [],
  ...(strategy === 'compose'
    ? { compose: { project: 'example', files: ['compose.yml'], services: ['web'] } }
    : {}),
})
export class MemoryWebsiteFs {
  nodes = new Map<string, Node>()
  writes: string[] = []
  denied = false
  corruptWrites = false
  sftp = {
    chmod: (path: string, mode: number, cb: (e?: Error) => void) => {
      this.nodes.get(path)!.mode = mode
      cb()
    },
    symlink: (target: string, path: string, cb: (e?: Error) => void) => {
      this.nodes.set(path, { kind: 'link', target, data: Buffer.alloc(0), mode: 0o777 })
      cb()
    },
    rename: (from: string, to: string, cb: (e?: Error) => void) => {
      void this.rename(from, to).then(() => cb(), cb)
    },
    ext_openssh_rename: (from: string, to: string, cb: (e?: Error) => void) => {
      this.nodes.delete(to)
      void this.rename(from, to).then(() => cb(), cb)
    },
  }
  constructor(strategy: 'compose' | 'static' = 'compose') {
    for (const path of ['/', '/home', '/home/demo', '/home/demo/project', '/home/demo/source'])
      this.nodes.set(path, { kind: 'dir', data: Buffer.alloc(0), mode: 0o755 })
    this.file('/home/demo/project/index.html', 'old website', 0o664)
    this.file('/home/demo/source/index.html', 'new website', 0o664)
    if (strategy === 'compose') {
      this.file('/home/demo/project/compose.yml', 'unchanged infrastructure')
      this.file('/home/demo/source/compose.yml', 'unchanged infrastructure')
      this.file('/home/demo/project/Dockerfile', 'FROM scratch')
      this.file('/home/demo/source/Dockerfile', 'FROM scratch')
      this.file('/home/demo/project/.env', 'PASSWORD=NEVER_COPY_THIS')
      this.nodes.set('/home/demo/project/postgres-data', {
        kind: 'dir',
        data: Buffer.alloc(0),
        mode: 0o700,
      })
      this.file('/home/demo/project/postgres-data/database', 'IMPORTANT_DATABASE')
    }
  }
  file(path: string, data: string, mode = 0o644): void {
    this.nodes.set(path, { kind: 'file', data: Buffer.from(data), mode })
  }
  private resolve(path: string, followFinal = true): string {
    for (const [name, node] of this.nodes)
      if (node.kind === 'link' && (path.startsWith(name + '/') || (followFinal && path === name)))
        return this.resolve(node.target! + path.slice(name.length))
    return path
  }
  async realpath(path: string): Promise<string> {
    const actual = this.resolve(path)
    if (!this.nodes.has(actual)) throw new AppError('FILE_NOT_FOUND', 'Missing fixture path')
    return actual
  }
  async lstat(path: string) {
    const value = this.nodes.get(this.resolve(path, false))
    if (!value) throw new AppError('FILE_NOT_FOUND', 'Missing fixture path')
    return {
      size: value.data.length,
      mode:
        value.mode |
        (value.kind === 'dir' ? 0o040000 : value.kind === 'link' ? 0o120000 : 0o100000),
      uid: 1000,
      gid: 1000,
      mtime: 1,
      atime: 1,
      isDirectory: () => value.kind === 'dir',
      isFile: () => value.kind === 'file',
      isSymbolicLink: () => value.kind === 'link',
    }
  }
  async exists(path: string) {
    try {
      return await this.lstat(path)
    } catch {
      return null
    }
  }
  async list(path: string) {
    const actual = await this.realpath(path)
    return {
      path: actual,
      entries: await Promise.all(
        [...this.nodes.keys()]
          .filter((p) => p !== actual && posix.dirname(p) === actual)
          .map(async (p) => ({ name: posix.basename(p), path: p, ...(await this.lstat(p)) })),
      ),
    }
  }
  async text(path: string) {
    const actual = await this.realpath(path)
    return { content: this.nodes.get(actual)!.data.toString('utf8') }
  }
  readStream(path: string): Readable {
    return Readable.from([this.nodes.get(this.resolve(path))!.data])
  }
  async mkdir(path: string): Promise<void> {
    if (this.denied) throw new AppError('PERMISSION_DENIED', 'Fixture denied staging writes.')
    if (this.nodes.has(path)) throw new AppError('FILE_CONFLICT', 'Fixture destination exists.')
    this.nodes.set(path, { kind: 'dir', data: Buffer.alloc(0), mode: 0o755 })
  }
  async ensureDirectory(path: string): Promise<void> {
    if (this.nodes.has(path)) {
      if (this.nodes.get(path)!.kind !== 'dir')
        throw new AppError('INVALID_PATH', 'Fixture symlink')
      return
    }
    await this.ensureDirectory(posix.dirname(path))
    await this.mkdir(path)
  }
  async rename(from: string, to: string): Promise<void> {
    if (!this.nodes.has(from) || this.nodes.has(to))
      throw new AppError('FILE_CONFLICT', 'Fixture rename conflict.')
    for (const [path, node] of [...this.nodes])
      if (path === from || path.startsWith(from + '/')) {
        this.nodes.set(to + path.slice(from.length), node)
        this.nodes.delete(path)
      }
  }
  async writeAtomic(
    path: string,
    source: Readable,
    size: number,
    _expected: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (this.denied) throw new AppError('PERMISSION_DENIED', 'Fixture denied staging writes.')
    const chunks: Buffer[] = []
    for await (const chunk of source) {
      signal?.throwIfAborted()
      chunks.push(Buffer.from(chunk))
    }
    let data = Buffer.concat(chunks)
    if (data.length !== size) throw new AppError('TRANSFER_INTERRUPTED', 'Fixture byte mismatch.')
    if (this.corruptWrites && path.endsWith('index.html')) data = Buffer.from('CORRUPTED')
    this.nodes.set(path, { kind: 'file', data, mode: 0o644 })
    this.writes.push(path)
  }
  asRemoteFs(): RemoteFs {
    return this as unknown as RemoteFs
  }
}

export function websiteSessionFixture(strategy: 'compose' | 'static' = 'compose') {
  const filesystems = new Map([
    [firstSession, new MemoryWebsiteFs(strategy)],
    [secondSession, new MemoryWebsiteFs(strategy)],
  ])
  const disconnected = new Set<string>()
  const model: ComposeModel = {
    name: 'example',
    services: {
      web: {
        image: 'example-web',
        build: { context: '/home/demo/project', dockerfile: 'Dockerfile' },
        environment: { API_TOKEN: 'DONT_LEAK_THIS_TOKEN' },
      },
      db: {
        image: 'postgres:17',
        volumes: [
          {
            type: 'bind',
            source: '/home/demo/project/postgres-data',
            target: '/var/lib/postgresql/data',
          },
        ],
      },
    },
    networks: { default: { name: 'example_default' } },
  }
  const options = {
    failBuild: false,
    waitBuild: false,
    buildEntered: false,
    routeFailure: false,
    denyPermissions: false,
    mutateDuringBuild: false,
    gitWrongRevision: false,
    freeBytes: 20 * 1024 ** 3,
    actualMounts: [] as {
      Type: string
      Name?: string
      Source?: string
      Destination: string
      RW: boolean
    }[],
    otherMounts: [] as {
      Type: string
      Name?: string
      Source?: string
      Destination: string
      RW: boolean
    }[],
  }
  let activeImage = oldImage,
    containerId = '1'.repeat(64)
  const readOverride = (id: string, command: string) => {
    const path = / -f '([^']+\.compose\.json)'/.exec(command)?.[1]
    return path
      ? (JSON.parse(filesystems.get(id)!.nodes.get(path)!.data.toString('utf8')) as {
          services: Record<string, { image?: string; build?: object }>
        })
      : undefined
  }
  const get = (id: string) => {
    if (!filesystems.has(id) || disconnected.has(id))
      throw new AppError('NETWORK_ERROR', 'Fixture connection lost.')
    return {
      info: {
        home: '/home/demo',
        profile: {
          host: id === firstSession ? 'one.test' : 'two.test',
          port: 22,
          username: 'demo',
        },
      },
    }
  }
  const exec = vi.fn(
    async (
      id: string,
      command: string,
      _timeout?: number,
      signal?: AbortSignal,
      output?: (text: string) => void,
    ): Promise<string> => {
      get(id)
      signal?.throwIfAborted()
      if (command.includes(' config --format json')) {
        const value = structuredClone(model),
          override = readOverride(id, command)
        for (const [name, change] of Object.entries(override?.services ?? {}))
          value.services[name] = {
            ...value.services[name],
            ...change,
            ...(change.build
              ? { build: { ...(value.services[name].build as object), ...change.build } }
              : {}),
          }
        return JSON.stringify(value)
      }
      if (command.includes(' ps -aq '))
        return [
          {
            id: containerId,
            image: activeImage,
            name: '/example-web-1',
            state: 'running',
            health: 'healthy',
            project: 'example',
            service: 'web',
            directory: '/home/demo/project',
            files: '/home/demo/project/compose.yml',
            ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3000' }] },
            mounts: options.actualMounts,
          },
          {
            id: '9'.repeat(64),
            image: `sha256:${'c'.repeat(64)}`,
            name: '/other-web-1',
            state: 'running',
            health: 'healthy',
            project: 'other',
            service: 'web',
            directory: '/home/demo/other',
            files: '/home/demo/other/compose.yml',
            ports: {},
            mounts: options.otherMounts,
          },
        ]
          .filter((v) => strategy !== 'static' || v.project !== 'example')
          .map((v) => JSON.stringify(v))
          .join('\n')
      if (command.startsWith('df ')) return String(options.freeBytes)
      if (command.includes('git clone --no-checkout')) {
        const destination = /git clone --no-checkout --filter=blob:none -- '[^']+' '([^']+)'/.exec(
          command,
        )![1]
        const revision = /checkout --detach '([a-f0-9]{40})'/.exec(command)![1]
        const fs = filesystems.get(id)!
        await fs.ensureDirectory(destination)
        fs.file(destination + '/index.html', 'git revision website')
        fs.file(destination + '/compose.yml', 'unchanged infrastructure')
        fs.file(destination + '/Dockerfile', 'FROM scratch')
        return options.gitWrongRevision ? 'f'.repeat(40) : revision
      }
      if (command.startsWith('test ')) {
        if (options.denyPermissions)
          throw new AppError('PERMISSION_DENIED', 'Fixture missing permissions.')
        return ''
      }
      if (command.includes(' image tag ')) return ''
      if (command.includes(' image inspect '))
        return command.includes(oldImage) ? oldImage : newImage
      if (command.includes(' --progress plain build ')) {
        options.buildEntered = true
        output?.('Building DONT_LEAK_')
        output?.('THIS_TOKEN\n')
        if (options.failBuild) throw new AppError('SERVICE_ERROR', 'Fixture build failed.')
        if (options.mutateDuringBuild)
          model.services.web.environment = { API_TOKEN: 'CHANGED_DURING_BUILD' }
        if (options.waitBuild)
          await new Promise<void>((_resolve, reject) =>
            signal!.addEventListener(
              'abort',
              () => reject(new AppError('CANCELLED', 'Fixture build cancelled.')),
              { once: true },
            ),
          )
        return ''
      }
      if (command.includes(' up -d ')) {
        const image = readOverride(id, command)?.services.web.image
        activeImage = image?.startsWith('sha256:') ? image : newImage
        containerId = hash(command)
        return ''
      }
      if (command.startsWith('curl '))
        return options.routeFailure && command.includes('https://example.test') ? '503' : '200'
      if (command.includes(' logs --no-color ')) return 'hello DONT_LEAK_THIS_TOKEN\n'
      if (command.includes(' restart --no-deps ')) return ''
      throw new Error(`Unexpected fixture command: ${command}`)
    },
  )
  return {
    filesystems,
    disconnected,
    model,
    options,
    exec,
    sessions: { get, exec } as unknown as SessionManager,
    image: () => activeImage,
  }
}
