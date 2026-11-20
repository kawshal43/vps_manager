import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile, symlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ZipFile } from 'yazl'
import { parseNginx } from '../../src/infrastructure/websites/nginx'
import {
  associateContainers,
  parseContainers,
  displayUpstream,
} from '../../src/application/websites/discovery'
import {
  inspectCompose,
  buildOverride,
  composeProtectedPaths,
  type ComposeModel,
} from '../../src/infrastructure/websites/compose'
import {
  composeAction,
  containerDiscoveryCommand,
  gitCloneCommand,
} from '../../src/infrastructure/commands/websites'
import { ProjectIO, unzipSource, cleanSource } from '../../src/infrastructure/websites/project-io'
import {
  childPath,
  compareFiles,
  deploymentPath,
  DeploymentLogSanitizer,
  hash,
  isProtected,
  safeGitUrl,
} from '../../src/domain/websites/policy'
import {
  websiteInputSchema,
  type WebsiteInput,
  type FileEntry,
} from '../../src/domain/websites/types'
import { schemas } from '../../src/shared/schemas'
import type { SessionManager } from '../../src/application/connection/session-manager'
import { removeTestDirectory } from '../../scripts/test-temp'

const config: WebsiteInput = {
  name: 'Example',
  domain: 'example.test',
  projectPath: '/home/demo/project',
  strategy: 'compose',
  healthUrl: 'http://127.0.0.1:3000/health',
  publicUrl: 'https://example.test/',
  healthTimeoutSeconds: 10,
  protectedPaths: [],
  compose: {
    project: 'example',
    files: ['deploy/compose.yml'],
    services: ['web', 'api'],
    envFile: '/etc/example/settings.env',
  },
}
const model: ComposeModel = {
  name: 'example',
  services: {
    web: {
      build: { context: '/home/demo/project/frontend', dockerfile: 'Dockerfile' },
      image: 'example-web',
      volumes: [{ type: 'volume', source: 'uploads', target: '/app/uploads' }],
    },
    api: { build: { context: '/home/demo/project/backend' }, image: 'example-api' },
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
  volumes: { uploads: { name: 'example_uploads' } },
  networks: { default: { name: 'example_default' } },
}
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const d of directories.splice(0)) await removeTestDirectory(d, 'vps-websites-test-')
})
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'vps-websites-test-'))
  directories.push(d)
  return d
}

describe('website discovery and Compose isolation', () => {
  it('scopes the illustrative A Plus TV update to web/api while preserving PostgreSQL, Nginx and the other website', () => {
    const root = '/home/ubuntu/aplus-upload/aplus-kids-ovh-20261120-final'
    const selected: WebsiteInput = {
      ...config,
      domain: 'aplustv.lk',
      publicUrl: 'https://aplustv.lk/',
      projectPath: root,
      compose: {
        project: 'apluskids',
        files: ['deploy/compose.yml'],
        envFile: '/etc/apluskids/settings.env',
        services: ['web', 'api'],
      },
    }
    const fixture: ComposeModel = {
      name: 'apluskids',
      services: {
        web: { build: { context: root + '/frontend' } },
        api: {
          build: { context: root + '/backend' },
          volumes: [{ type: 'volume', source: 'media', target: '/app/uploads' }],
        },
        db: {
          image: 'postgres:17',
          volumes: [
            { type: 'volume', source: 'postgres_data', target: '/var/lib/postgresql/data' },
          ],
        },
        nginx: {
          image: 'nginx:alpine',
          volumes: [
            { type: 'bind', source: root + '/deploy/nginx.conf', target: '/etc/nginx/nginx.conf' },
          ],
        },
      },
      volumes: { media: {}, postgres_data: {} },
    }
    expect(inspectCompose(selected, fixture).blocked).toEqual([])
    const override = buildOverride(
      selected,
      fixture,
      '/home/ubuntu/versioned-release',
      'fixture-release',
    ) as { services: object }
    expect(Object.keys(override.services)).toEqual(['web', 'api'])
    const command = composeAction(selected, 'sudo', 'activate', '/home/ubuntu/override.json')
    expect(command).toContain("--env-file '/etc/apluskids/settings.env'")
    expect(command).toContain("up -d --no-deps --no-build --pull never 'web' 'api'")
    expect(command).not.toMatch(/'db'|'nginx'|nuranova|down|prune/)
    expect(fixture.volumes).toEqual({ media: {}, postgres_data: {} })
  })
  it('removes upstream credentials and query tokens from the website details projection', () => {
    expect(
      displayUpstream(
        'https://admin:PRIVATE_PASSWORD@upstream.test/app?token=PRIVATE_TOKEN#fragment',
      ),
    ).toBe('https://upstream.test/app')
    expect(displayUpstream('http://$dynamic:$port')).toBe(
      'Dynamic upstream — inspect configuration',
    )
  })
  it('parses quoted/commented Nginx roots, host aliases, nested proxy locations and TLS', () => {
    const sites = parseNginx(
      `# ignored server { server_name fake.test; }
      upstream app { server 127.0.0.1:3000; }
      server { listen 80; server_name example.test www.example.test; root "/srv/a; b"; location /api { proxy_pass http://127.0.0.1:8080; } }
      server { listen [::]:443 ssl; server_name example.test; ssl_certificate /etc/letsencrypt/live/example/fullchain.pem; }`,
      '/etc/nginx/sites-available/example',
    )
    expect(sites).toHaveLength(2)
    expect(sites[0]).toMatchObject({
      domains: ['example.test', 'www.example.test'],
      root: '/srv/a; b',
      upstream: 'http://127.0.0.1:8080',
      https: false,
    })
    expect(sites[1]).toMatchObject({
      https: true,
      certificatePath: '/etc/letsencrypt/live/example/fullchain.pem',
    })
  })
  it('does not guess variable roots, wildcard domains or ambiguous proxy targets', () => {
    expect(parseNginx('server { server_name *.test _; root /srv/$host; }', 'test')).toEqual([])
    expect(
      parseNginx(
        'server { server_name example.test; root /srv/${site}; location /a { proxy_pass http://a; } location /b { proxy_pass http://b; } }',
        'test',
      )[0],
    ).toMatchObject({ root: undefined, upstream: undefined })
    expect(parseNginx('server { server_name "unterminated; }', 'test')).toEqual([])
  })
  it('associates a loopback reverse proxy only with a unique Compose project', () => {
    const container = {
      id: '1'.repeat(64),
      image: `sha256:${'a'.repeat(64)}`,
      name: '/web',
      state: 'running',
      health: 'healthy',
      project: 'example',
      service: 'web',
      directory: config.projectPath,
      files: '/home/demo/project/compose.yml',
      ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] },
    }
    const containers = parseContainers(JSON.stringify(container))
    expect(
      associateContainers(
        {
          domains: ['example.test'],
          upstream: 'http://127.0.0.1:8080',
          https: true,
          configPath: '/etc/nginx/site',
        },
        containers,
      ),
    ).toHaveLength(1)
    expect(
      associateContainers(
        { domains: [], upstream: 'http://127.0.0.1:8080', https: false, configPath: '' },
        [...containers, { ...containers[0], project: 'other' }],
      ),
    ).toEqual([])
    expect(() =>
      parseContainers(JSON.stringify({ ...container, id: 'injected; command' })),
    ).toThrow()
  })
  it('keeps the original project, env file, volumes and unselected database out of activation commands', () => {
    const command = composeAction(config, 'sudo', 'activate', '/home/demo/release.json')
    expect(command).toContain("--project-name 'example' --project-directory '/home/demo/project'")
    expect(command).toContain("--env-file '/etc/example/settings.env'")
    expect(command).toContain("up -d --no-deps --no-build --pull never 'web' 'api'")
    expect(command).not.toMatch(/down|prune|remove-orphans|\bdb\b/)
    expect(containerDiscoveryCommand('none')).not.toContain('.Config.Env')
    expect(containerDiscoveryCommand('none')).toContain('|| exit')
    const override = buildOverride(config, model, '/home/demo/releases/one', 'release-one') as {
      services: Record<string, { build: { context: string } }>
    }
    expect(Object.keys(override.services)).toEqual(['web', 'api'])
    expect(override.services.web.build.context).toBe('/home/demo/releases/one/frontend')
    expect(inspectCompose(config, model).blocked).toEqual([])
    expect(composeProtectedPaths(config, model)).toContain('postgres-data')
  })
  it.each([
    'database',
    'source bind',
    'external context',
    'privileged',
    'migration hook',
    'automatic schema update',
    'automatic Flyway',
    'root bind',
  ])('blocks unsafe Compose selection: %s', (kind) => {
    const current = structuredClone(model),
      selected = structuredClone(config)
    if (kind === 'database') selected.compose!.services = ['db']
    if (kind === 'source bind')
      current.services.web.volumes = [
        { type: 'bind', source: `${config.projectPath}/frontend`, target: '/app' },
      ]
    if (kind === 'external context') current.services.web.build = { context: '/etc' }
    if (kind === 'privileged') current.services.web.privileged = true
    if (kind === 'migration hook') current.services.web.command = 'npm run migrate'
    if (kind === 'automatic schema update')
      current.services.web.environment = { SPRING_JPA_HIBERNATE_DDL_AUTO: 'update' }
    if (kind === 'automatic Flyway')
      current.services.web.environment = { SPRING_FLYWAY_ENABLED: 'true' }
    if (kind === 'root bind')
      current.services.web.volumes = [{ type: 'bind', source: config.projectPath, target: '/app' }]
    expect(inspectCompose(selected, current).blocked.length).toBeGreaterThan(0)
  })
})

describe('website input, protected data and log policies', () => {
  it.each(['../outside', '/etc/passwd', 'dir/../file', 'dir\\file', 'x\nfile'])(
    'rejects a source child escape: %j',
    (path) => expect(() => childPath('/home/demo/app', path)).toThrow(),
  )
  it.each(['/etc/nginx/site', '/var/lib/postgresql/data', '/home/demo', '/srv'])(
    'rejects system/shared deployment roots: %s',
    (path) => expect(() => deploymentPath(path, '/home/demo')).toThrow(),
  )
  it('accepts a dedicated /srv application directory and rejects persistent/managed roots', () => {
    expect(deploymentPath('/srv/website', '/home/demo')).toBe('/srv/website')
    expect(() => deploymentPath('/home/demo/uploads', '/home/demo')).toThrow()
    expect(() =>
      deploymentPath('/home/demo/.vps-websites-test/backups/source', '/home/demo'),
    ).toThrow()
  })
  it.each([
    '.env',
    'config/.env.production',
    'media/video.mp4',
    'keys/key.pem',
    'db/backup.sql',
    '.ssh/config',
    'uploads/photo.jpg',
  ])('protects %s', (path) => expect(isProtected(path)).toBe(true))
  it('compares file content without removing unselected files in partial updates', () => {
    const file = (path: string, value: string): FileEntry => ({
      path,
      hash: hash(value),
      size: value.length,
      mode: 0o644,
    })
    const before = [file('same', 'a'), file('changed', 'b'), file('old', 'c')],
      next = [file('same', 'a'), file('changed', 'x'), file('new', 'd')]
    expect(compareFiles(before, next, 'full')).toEqual({
      added: ['new'],
      changed: ['changed'],
      removed: ['old'],
      unchanged: 1,
    })
    expect(compareFiles(before, next, 'partial').removed).toEqual([])
  })
  it('rejects token-bearing URLs, raw shell capabilities and invalid website settings', () => {
    expect(websiteInputSchema.safeParse(config).success).toBe(true)
    expect(websiteInputSchema.safeParse({ ...config, publicUrl: 'not a URL' }).success).toBe(false)
    expect(
      websiteInputSchema.safeParse({ ...config, publicUrl: 'https://other.test/' }).success,
    ).toBe(false)
    expect(
      websiteInputSchema.safeParse({ ...config, healthUrl: 'https://user:token@example.test/' })
        .success,
    ).toBe(false)
    expect(
      schemas['websites.deploy'].safeParse({ sessionId: 'bad', token: 'bad', command: 'rm -rf /' })
        .success,
    ).toBe(false)
    for (const url of [
      'file:///etc/passwd',
      'https://token@github.com/owner/repo',
      'ssh://-oProxyCommand=evil@host/repo',
    ])
      expect(() => safeGitUrl(url)).toThrow()
    expect(() =>
      gitCloneCommand('https://github.com/owner/repo.git', 'main; id', '/tmp/safe'),
    ).toThrow()
    expect(
      gitCloneCommand(
        'https://github.com/owner/repo.git',
        'a'.repeat(40),
        '/home/demo/new checkout',
      ),
    ).toContain('--detach')
  })
  it('redacts secrets across chunks and suppresses private keys and oversized output', () => {
    const lines: string[] = [],
      sanitizer = new DeploymentLogSanitizer((v) => lines.push(v), ['PRIVATE_TOKEN_VALUE', 'abc'])
    sanitizer.feed('building PRIVATE_TO')
    sanitizer.feed('KEN_VALUE password=abc\n-----BEGIN OPENSSH PRIVATE KEY-----\nkey-body\n')
    sanitizer.feed('-----END OPENSSH PRIVATE KEY-----\nready\n' + 'x'.repeat(9000))
    sanitizer.feed('tail\ndone')
    sanitizer.flush()
    expect(lines.join('\n')).not.toMatch(/PRIVATE_TOKEN_VALUE|abc|key-body|tail/)
    expect(lines).toContain('ready')
    expect(lines).toContain('done')
    expect(lines.every((line) => line.length <= 2000)).toBe(true)
  })
})

describe('local source staging', () => {
  it('hashes regular source files and excludes environment, database and media contents', async () => {
    const root = await temp()
    await mkdir(join(root, 'media'))
    await writeFile(join(root, 'index.html'), '<h1>hello</h1>')
    await writeFile(join(root, '.env'), 'SECRET=should-not-upload')
    await writeFile(join(root, 'media', 'photo.jpg'), 'persistent')
    const io = new ProjectIO({} as SessionManager)
    const manifest = await io.manifest('unused', { kind: 'local', root }, [])
    expect(manifest.files.map((f) => f.path)).toEqual(['index.html'])
    expect(manifest.files[0].hash).toBe(hash('<h1>hello</h1>'))
    expect(manifest.skipped).toEqual(['.env', 'media'])
  })
  it('rejects a directory junction instead of traversing outside the selected source', async () => {
    const root = await temp(),
      outside = await temp()
    await symlink(outside, join(root, 'linked'), 'junction')
    const io = new ProjectIO({} as SessionManager)
    await expect(io.manifest('unused', { kind: 'local', root }, [])).rejects.toThrow(
      /symbolic link|junction/,
    )
  })
  it('extracts a normal ZIP, skips secrets, and rejects traversal and symbolic link entries', async () => {
    const root = await temp()
    const makeZip = async (name: string, mode?: number) => {
      const zip = new ZipFile(),
        chunks: Buffer[] = []
      zip.addBuffer(Buffer.from('source'), name, mode ? { mode } : undefined)
      zip.outputStream.on('data', (b: Buffer) => chunks.push(b))
      const finished = new Promise<Buffer>((resolve, reject) => {
        zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
        zip.outputStream.on('error', reject)
      })
      zip.end()
      return finished
    }
    const normal = join(root, 'normal.zip')
    await writeFile(normal, await makeZip('project/index.html'))
    const source = await unzipSource(normal)
    expect(await readFile(join(source.root, 'index.html'), 'utf8')).toBe('source')
    await cleanSource(source.temporary)
    const traversal = (await makeZip('bad/file.txt'))
      .toString('binary')
      .replaceAll('bad/file.txt', '../evilx.txt')
    const unsafe = join(root, 'unsafe.zip')
    await writeFile(unsafe, Buffer.from(traversal, 'binary'))
    await expect(unzipSource(unsafe)).rejects.toThrow()
    await writeFile(unsafe, await makeZip('link', 0o120777))
    await expect(unzipSource(unsafe)).rejects.toThrow(/regular files/)
    await expect(cleanSource(root)).rejects.toThrow(/outside/)
  })
})
