import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebsiteManager } from '../../src/application/websites/website-manager'
import { WebsiteRepository } from '../../src/infrastructure/persistence/websites'
import { ProjectIO } from '../../src/infrastructure/websites/project-io'
import type { AppEvent } from '../../src/shared/contracts/api'
import type { DeploymentProgress } from '../../src/domain/websites/types'
import { removeTestDirectory } from '../../scripts/test-temp'
import {
  firstSession,
  secondSession,
  oldImage,
  newImage,
  websiteConfig,
  websiteSessionFixture,
} from '../fixtures/website-server'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const d of directories.splice(0)) await removeTestDirectory(d, 'vps-websites-test-')
})
async function setup(strategy: 'compose' | 'static' = 'compose') {
  const directory = await mkdtemp(join(tmpdir(), 'vps-websites-test-'))
  directories.push(directory)
  const fixture = websiteSessionFixture(strategy),
    events: AppEvent[] = []
  vi.spyOn(ProjectIO.prototype, 'fs').mockImplementation((id) =>
    fixture.filesystems.get(id)!.asRemoteFs(),
  )
  const repository = new WebsiteRepository(directory)
  await repository.load()
  const confirm = vi.fn(async () => true)
  const manager = new WebsiteManager(fixture.sessions, repository, confirm, (event) =>
    events.push(event),
  )
  const record = await manager.register(firstSession, websiteConfig(strategy))
  const prepare = () =>
    manager.prepare(
      firstSession,
      record.id,
      'full',
      { kind: 'remote', path: '/home/demo/source' },
      'none',
      [],
    )
  const completed = async (id: string) => {
    let progress: DeploymentProgress | undefined
    await vi.waitFor(
      () => {
        progress = events
          .filter(
            (e): e is Extract<AppEvent, { type: 'website-deployment' }> =>
              e.type === 'website-deployment',
          )
          .map((e) => e.operation)
          .findLast((o) => o.id === id)
        expect(progress?.state).not.toBe('running')
        expect(progress).toBeDefined()
      },
      { timeout: 5000, interval: 10 },
    )
    await repository.flush()
    return progress!
  }
  return { ...fixture, directory, repository, manager, record, events, confirm, prepare, completed }
}

describe('verified application deployment lifecycle', () => {
  it('requires declared bind storage to match the running application before source updates', async () => {
    const f = await setup()
    f.model.services.web.volumes = [
      { type: 'bind', source: '/srv/application-media', target: '/app/media' },
    ]
    f.options.actualMounts = [
      { Type: 'bind', Source: '/srv/other-media', Destination: '/app/media', RW: true },
    ]
    expect((await f.prepare()).blocked.join(' ')).toContain('does not match the running container')
    f.options.actualMounts[0].Source = '/srv/application-media'
    expect((await f.prepare()).blocked).toEqual([])
    expect(f.image()).toBe(oldImage)
  })
  it('verifies exact named-volume identities and blocks undeclared or database mounts', async () => {
    const f = await setup()
    f.model.services.web.volumes = [{ type: 'volume', source: 'uploads', target: '/app/uploads' }]
    f.model.volumes = { uploads: { name: 'example_uploads' } }
    f.options.actualMounts = [
      { Type: 'volume', Name: 'another_site_uploads', Destination: '/app/uploads', RW: true },
    ]
    expect((await f.prepare()).blocked.join(' ')).toContain('does not match the running container')
    f.options.actualMounts[0].Name = 'example_uploads'
    expect((await f.prepare()).blocked).toEqual([])
    f.model.services.web.volumes = []
    expect((await f.prepare()).blocked.join(' ')).toContain('undeclared volume mount')
    f.model.services.web.volumes = [
      { type: 'volume', source: 'uploads', target: '/var/lib/postgresql/data' },
    ]
    f.options.actualMounts[0].Destination = '/var/lib/postgresql/data'
    expect((await f.prepare()).blocked.join(' ')).toContain('mounts database storage')
    expect(f.image()).toBe(oldImage)
  })
  it('prepares an isolated exact Git revision and rejects a mismatched checkout without changing current source', async () => {
    const f = await setup(),
      fs = f.filesystems.get(firstSession)!
    const source = {
      kind: 'git' as const,
      url: 'https://github.com/example/fixture.git',
      revision: 'a'.repeat(40),
    }
    const preview = await f.manager.prepare(firstSession, f.record.id, 'full', source, 'none', [])
    expect(preview.blocked).toEqual([])
    expect(fs.nodes.get('/home/demo/project/index.html')!.data.toString()).toBe('old website')
    expect(f.exec.mock.calls.filter(([, command]) => command.includes('git clone')).length).toBe(1)
    expect(f.exec.mock.calls.some(([, command]) => /git push|git pull/.test(command))).toBe(false)
    f.options.gitWrongRevision = true
    await expect(
      f.manager.prepare(firstSession, f.record.id, 'full', source, 'none', []),
    ).rejects.toThrow(/revision did not match/)
    f.options.freeBytes = 100 * 1024 ** 2
    const clones = f.exec.mock.calls.filter(([, command]) => command.includes('git clone')).length
    await expect(
      f.manager.prepare(firstSession, f.record.id, 'full', source, 'none', []),
    ).rejects.toThrow(/4 GiB/)
    expect(f.exec.mock.calls.filter(([, command]) => command.includes('git clone'))).toHaveLength(
      clones,
    )
  })
  it('distinguishes an unhealthy HTTP response from an unreachable application', async () => {
    const f = await setup()
    f.exec.mockResolvedValueOnce('503')
    expect(await f.manager.health(firstSession, f.record.id)).toMatchObject({
      state: 'unhealthy',
      code: 503,
    })
    f.exec.mockRejectedValueOnce(new Error('private network diagnostic'))
    const health = await f.manager.health(firstSession, f.record.id)
    expect(health.state).toBe('unreachable')
    expect(JSON.stringify(health)).not.toContain('private network diagnostic')
  })
  it('backs up, verifies and deploys only selected services, then restores old image/source without touching persistent data', async () => {
    const f = await setup(),
      fs = f.filesystems.get(firstSession)!
    const preview = await f.prepare()
    expect(preview.blocked).toEqual([])
    expect(preview.protected.join(' ')).toContain('postgres-data')
    const id = (await f.manager.deploy(firstSession, preview.token, true))!
    expect((await f.completed(id)).state).toBe('completed')
    expect(f.image()).toBe(newImage)
    const history = f.manager.history(firstSession, f.record.id).find((h) => h.id === id)!
    expect(history.backupVerified).toBe(true)
    expect(fs.nodes.get(history.backupPath + '/index.html')!.data.toString()).toBe('old website')
    expect(fs.nodes.get('/home/demo/project/postgres-data/database')!.data.toString()).toBe(
      'IMPORTANT_DATABASE',
    )
    expect(fs.nodes.get('/home/demo/project/.env')!.data.toString()).toBe(
      'PASSWORD=NEVER_COPY_THIS',
    )
    expect(fs.writes.every((path) => !/\/postgres-data\/|\/\.env$/.test(path))).toBe(true)
    expect(JSON.stringify(f.events)).not.toContain('DONT_LEAK_THIS_TOKEN')
    expect(
      f.exec.mock.calls
        .filter(([, command]) => command.includes(' up -d '))
        .every(
          ([, command]) =>
            command.endsWith("'web'") && command.includes('--no-deps --no-build --pull never'),
        ),
    ).toBe(true)
    const restored = (await f.manager.restore(firstSession, f.record.id, id, 'none'))!
    expect((await f.completed(restored)).state).toBe('restored')
    expect(f.image()).toBe(oldImage)
    expect(f.manager.history(firstSession, f.record.id).at(-1)?.backupVerified).toBe(true)
    expect(f.exec.mock.calls.some(([, c]) => /down|prune|--volumes|remove-orphans/.test(c))).toBe(
      false,
    )
  })
  it('publishes and rolls back static releases using a validated document-root link', async () => {
    const f = await setup('static'),
      fs = f.filesystems.get(firstSession)!
    const preview = await f.prepare(),
      id = (await f.manager.deploy(firstSession, preview.token, true))!
    expect((await f.completed(id)).state).toBe('completed')
    expect((await fs.lstat(f.record.config.projectPath)).isSymbolicLink()).toBe(true)
    expect((await fs.text(f.record.config.projectPath + '/index.html')).content).toBe('new website')
    const restored = (await f.manager.restore(firstSession, f.record.id, id, 'none'))!
    expect((await f.completed(restored)).state).toBe('restored')
    expect((await fs.text(f.record.config.projectPath + '/index.html')).content).toBe('old website')
  })
  it('does not activate after a failed build and retains the verified backup', async () => {
    const f = await setup()
    f.options.failBuild = true
    const preview = await f.prepare(),
      id = (await f.manager.deploy(firstSession, preview.token, true))!
    expect((await f.completed(id)).state).toBe('failed')
    expect(f.image()).toBe(oldImage)
    expect(f.exec.mock.calls.some(([, c]) => c.includes(' up -d '))).toBe(false)
    expect(f.manager.history(firstSession, f.record.id).at(-1)?.backupVerified).toBe(true)
  })
  it('blocks configuration drift during build before it can affect live services', async () => {
    const f = await setup()
    f.options.mutateDuringBuild = true
    const preview = await f.prepare(),
      id = (await f.manager.deploy(firstSession, preview.token, true))!
    expect((await f.completed(id)).state).toBe('failed')
    expect(f.image()).toBe(oldImage)
    expect(f.exec.mock.calls.some(([, c]) => c.includes(' up -d '))).toBe(false)
  })
  it('records failed website routing as failure and exposes the application backup for recovery', async () => {
    const f = await setup()
    f.options.routeFailure = true
    const preview = await f.prepare(),
      id = (await f.manager.deploy(firstSession, preview.token, true))!
    expect((await f.completed(id)).state).toBe('failed')
    expect(f.manager.history(firstSession, f.record.id).at(-1)).toMatchObject({
      backupVerified: true,
      status: 'failed',
    })
    f.options.routeFailure = false
    const restored = (await f.manager.restore(firstSession, f.record.id, id, 'none'))!
    expect((await f.completed(restored)).state).toBe('restored')
  })
  it('cancels a pending build, blocks concurrent deployment and leaves the published app untouched', async () => {
    const f = await setup()
    f.options.waitBuild = true
    const preview = await f.prepare(),
      second = await f.prepare()
    const id = (await f.manager.deploy(firstSession, preview.token, true))!
    await vi.waitFor(() => expect(f.options.buildEntered).toBe(true))
    await expect(f.manager.deploy(firstSession, second.token, true)).rejects.toThrow(
      /already running/,
    )
    f.manager.cancel(firstSession, id)
    expect((await f.completed(id)).state).toBe('cancelled')
    expect(f.image()).toBe(oldImage)
  })
  it('records a connection loss as interrupted and never replays the operation', async () => {
    const f = await setup()
    f.options.waitBuild = true
    const preview = await f.prepare(),
      id = (await f.manager.deploy(firstSession, preview.token, true))!
    await vi.waitFor(() => expect(f.options.buildEntered).toBe(true))
    f.disconnected.add(firstSession)
    f.manager.disconnect(firstSession)
    expect((await f.completed(id)).state).toBe('interrupted')
    expect(f.image()).toBe(oldImage)
    f.disconnected.clear()
    const reloaded = new WebsiteRepository(f.directory)
    await reloaded.load()
    expect(reloaded.history(f.record.scope, f.record.id).at(-1)?.status).toBe('interrupted')
    expect(f.exec.mock.calls.some(([, c]) => c.includes(' up -d '))).toBe(false)
  })
  it('rejects a stale preview and corrupt uploaded bytes before activation', async () => {
    const f = await setup(),
      fs = f.filesystems.get(firstSession)!
    const preview = await f.prepare()
    fs.file('/home/demo/source/index.html', 'source changed')
    const id = (await f.manager.deploy(firstSession, preview.token, true))!
    expect((await f.completed(id)).state).toBe('failed')
    const fresh = await f.prepare()
    fs.corruptWrites = true
    const corrupt = (await f.manager.deploy(firstSession, fresh.token, true))!
    expect((await f.completed(corrupt)).state).toBe('failed')
    expect(f.image()).toBe(oldImage)
    expect(f.exec.mock.calls.some(([, c]) => c.includes(' up -d '))).toBe(false)
  })
  it('requires native confirmation and explicit acknowledgement before starting a deployment', async () => {
    const f = await setup(),
      preview = await f.prepare()
    await expect(f.manager.deploy(firstSession, preview.token, false)).rejects.toThrow(
      /acknowledge/,
    )
    f.confirm.mockResolvedValue(false)
    expect(await f.manager.deploy(firstSession, preview.token, true)).toBeNull()
    expect(f.manager.history(firstSession, f.record.id)).toEqual([])
    expect(f.image()).toBe(oldImage)
  })
  it('rejects cross-server plans, website IDs and histories', async () => {
    const f = await setup(),
      preview = await f.prepare()
    await expect(f.manager.deploy(secondSession, preview.token, true)).rejects.toThrow(
      /another connection/,
    )
    expect(() => f.manager.history(secondSession, f.record.id)).toThrow(/server\/account/)
    const other = await f.manager.register(secondSession, websiteConfig())
    expect(other.scope).not.toBe(f.record.scope)
    expect(f.manager.history(secondSession, other.id)).toEqual([])
  })
  it('blocks persistent-data static roots, changed Compose files and insufficient permissions', async () => {
    const f = await setup(),
      fs = f.filesystems.get(firstSession)!
    fs.file('/home/demo/source/compose.yml', 'changed infrastructure')
    expect((await f.prepare()).blocked.join(' ')).toContain('Infrastructure file changed')
    fs.file('/home/demo/source/compose.yml', 'unchanged infrastructure')
    f.options.denyPermissions = true
    await expect(f.prepare()).rejects.toThrow(/permissions/)
    expect(f.exec.mock.calls.some(([, c]) => c.includes(' up -d '))).toBe(false)
  })
  it('does not restore a modified or missing backup', async () => {
    const f = await setup(),
      fs = f.filesystems.get(firstSession)!
    const preview = await f.prepare(),
      id = (await f.manager.deploy(firstSession, preview.token, true))!
    await f.completed(id)
    const history = f.manager.history(firstSession, f.record.id).at(-1)!
    fs.file(history.backupPath + '/index.html', 'modified backup')
    await expect(f.manager.restore(firstSession, f.record.id, id, 'none')).rejects.toThrow(
      /backup content changed/,
    )
    expect(f.image()).toBe(newImage)
  })
  it('blocks a shared Nginx document root used by a second website', async () => {
    const f = await setup('static'),
      fs = f.filesystems.get(firstSession)!
    await fs.ensureDirectory('/etc/nginx/sites-enabled')
    fs.file(
      '/etc/nginx/sites-enabled/other.conf',
      'server { listen 80; server_name other.test; root /home/demo/project; }',
    )
    const preview = await f.prepare()
    expect(preview.blocked.join(' ')).toContain('overlaps another hosted website: other.test')
    await expect(f.manager.deploy(firstSession, preview.token, true)).rejects.toThrow(/blockers/)
  })
  it('blocks static persistent data and keeps its media contents intact', async () => {
    const f = await setup('static'),
      fs = f.filesystems.get(firstSession)!
    await fs.ensureDirectory('/home/demo/project/uploads')
    fs.file('/home/demo/project/uploads/video.mp4', 'IMPORTANT_MEDIA')
    const preview = await f.prepare()
    expect(preview.blocked.join(' ')).toContain('contains protected data')
    expect(fs.nodes.get('/home/demo/project/uploads/video.mp4')!.data.toString()).toBe(
      'IMPORTANT_MEDIA',
    )
    f.options.otherMounts = [
      {
        Type: 'bind',
        Source: '/home/demo/project',
        Destination: '/usr/share/nginx/html',
        RW: false,
      },
    ]
    expect((await f.prepare()).blocked.join(' ')).toContain('overlaps a container bind mount')
  })
  it('preserves corrupt metadata and converts unfinished persisted jobs into recovery records', async () => {
    const f = await setup()
    const raw = JSON.parse(await readFile(join(f.directory, 'websites.json'), 'utf8'))
    raw.history = [
      {
        id: '00000000-0000-4000-8000-000000000099',
        websiteId: f.record.id,
        scope: f.record.scope,
        startedAt: new Date().toISOString(),
        status: 'running',
        action: 'deploy',
        message: '',
        backupVerified: false,
        backupBytes: 0,
        backupHash: '',
        previousImages: {},
        configHash: '',
        log: [],
      },
    ]
    await writeFile(join(f.directory, 'websites.json'), JSON.stringify(raw))
    const recovering = new WebsiteRepository(f.directory)
    await recovering.load()
    expect(recovering.history(f.record.scope)[0].status).toBe('interrupted')
    await writeFile(join(f.directory, 'websites.json'), 'CORRUPT ORIGINAL')
    const broken = new WebsiteRepository(f.directory)
    await expect(broken.load()).rejects.toThrow(/preserved/)
    await expect(broken.flush()).rejects.toThrow(/preserved/)
    expect(await readFile(join(f.directory, 'websites.json'), 'utf8')).toBe('CORRUPT ORIGINAL')
  })
  it('bounds persisted logs while retaining operation metadata and recent output', async () => {
    const f = await setup()
    for (let n = 0; n < 12; n++)
      await f.repository.saveHistory({
        id: `00000000-0000-4000-8000-${String(n + 100).padStart(12, '0')}`,
        websiteId: f.record.id,
        scope: f.record.scope,
        startedAt: new Date().toISOString(),
        status: 'completed',
        action: 'deploy',
        message: 'Fixture history',
        backupVerified: false,
        backupBytes: 0,
        backupHash: '',
        previousImages: {},
        configHash: '',
        log: Array.from({ length: 200 }, () => 'x'.repeat(2000)),
      })
    const history = f.repository.history(f.record.scope, f.record.id)
    expect(history).toHaveLength(12)
    expect(
      history.flatMap((h) => h.log).reduce((sum, line) => sum + Buffer.byteLength(line), 0),
    ).toBeLessThanOrEqual(4 * 1024 ** 2)
    expect(history.at(-1)?.log).toHaveLength(200)
    expect(history[0].log.length).toBeLessThan(200)
  })
})
