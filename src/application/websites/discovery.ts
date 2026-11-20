import { posix } from 'node:path'
import { z } from 'zod'
import type { SessionManager } from '../connection/session-manager'
import { RemoteFs } from '../../infrastructure/sftp/remote-fs'
import { parseNginx, type NginxSite } from '../../infrastructure/websites/nginx'
import { containerDiscoveryCommand } from '../../infrastructure/commands/websites'
import { quotePosix } from '../../domain/filesystem/policy'
import { hash } from '../../domain/websites/policy'
import {
  websitePath,
  type Elevation,
  type WebsiteRecord,
  type WebsiteView,
  type RuntimeService,
  type DiscoveryResult,
} from '../../domain/websites/types'

const containerSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  name: z.string(),
  state: z.string(),
  health: z.string().nullable(),
  project: z.string().nullable(),
  service: z.string().nullable(),
  directory: z.string().nullable(),
  files: z.string().nullable(),
  mounts: z
    .array(
      z.object({
        Type: z.string(),
        Name: z.string().optional(),
        Source: z.string().optional(),
        Destination: z.string(),
        RW: z.boolean(),
      }),
    )
    .max(100)
    .nullish()
    .transform((value) => value ?? []),
  ports: z
    .record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable())
    .nullable(),
})
export type ContainerInfo = z.infer<typeof containerSchema>
export function parseContainers(output: string): ContainerInfo[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 500)
    .map((line) => containerSchema.parse(JSON.parse(line)))
}
function runtime(c: ContainerInfo): RuntimeService {
  return {
    name: c.service || c.name.replace(/^\//, ''),
    state: c.state,
    health: c.health || undefined,
    image: c.image,
    ports: Object.values(c.ports ?? {}).flatMap((v) =>
      (v ?? []).map((p) => `${p.HostIp}:${p.HostPort}`),
    ),
  }
}
export function displayUpstream(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const u = new URL(value)
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    return u.href
  } catch {
    return 'Dynamic upstream — inspect configuration'
  }
}
export function associateContainers(site: NginxSite, containers: ContainerInfo[]): ContainerInfo[] {
  if (!site.upstream) return []
  try {
    const u = new URL(site.upstream)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return []
    const port = u.port || (u.protocol === 'https:' ? '443' : '80')
    const matching = containers.filter((c) =>
      Object.values(c.ports ?? {}).some((v) =>
        v?.some(
          (p) =>
            p.HostPort === port && ['', '0.0.0.0', '127.0.0.1', '::', '::1'].includes(p.HostIp),
        ),
      ),
    )
    const projects = [...new Set(matching.map((c) => c.project).filter(Boolean))]
    return projects.length === 1 ? containers.filter((c) => c.project === projects[0]) : []
  } catch {
    return []
  }
}
function suggestion(containers: ContainerInfo[]): WebsiteView['suggestedCompose'] {
  const first = containers[0]
  if (
    !first?.project ||
    !first.directory ||
    !first.files ||
    !websitePath.safeParse(first.directory).success
  )
    return undefined
  const files = first.files.split(',').map((f) => posix.relative(first.directory!, f))
  if (files.some((f) => !f || f.startsWith('../') || posix.isAbsolute(f))) return undefined
  return {
    project: first.project,
    directory: first.directory,
    files,
    services: containers.map((c) => c.service).filter((v): v is string => !!v),
  }
}
export class WebsiteDiscovery {
  constructor(
    private sessions: SessionManager,
    private fsFactory = (id: string) => new RemoteFs(sessions.fs(id)),
  ) {}
  async containers(sessionId: string, elevation: Elevation): Promise<ContainerInfo[]> {
    return parseContainers(
      await this.sessions.exec(sessionId, containerDiscoveryCommand(elevation), 20000),
    )
  }
  async discover(
    sessionId: string,
    records: WebsiteRecord[],
    elevation: Elevation,
  ): Promise<DiscoveryResult> {
    const warnings: string[] = [],
      sites: NginxSite[] = []
    const fs = this.fsFactory(sessionId)
    try {
      const enabled = (await fs.list('/etc/nginx/sites-enabled')).entries
      if (enabled.length > 100)
        warnings.push('Nginx discovery is limited to 100 enabled configuration files.')
      for (const entry of enabled.slice(0, 100)) {
        try {
          const path = await fs.realpath(entry.path)
          sites.push(...parseNginx((await fs.text(path)).content, path))
        } catch {
          warnings.push(`An enabled Nginx configuration could not be read: ${entry.name}`)
        }
      }
    } catch {
      warnings.push(
        'Nginx sites-enabled could not be read. Import other layouts, Apache or Caddy sites manually.',
      )
    }
    let containers: ContainerInfo[] = []
    try {
      containers = await this.containers(sessionId, elevation)
    } catch {
      warnings.push(
        'Docker inspection is unavailable or denied. Use explicit existing sudo access if needed, or import a site manually.',
      )
    }
    const views = new Map<string, WebsiteView>()
    for (const site of sites) {
      const domain = site.domains[0]
      const key =
        records.find((r) => site.domains.includes(r.config.domain))?.id ||
        `nginx:${hash(domain).slice(0, 24)}`
      const matched = associateContainers(site, containers),
        compose = suggestion(matched)
      const existing = views.get(key)
      const view: WebsiteView = existing ?? {
        id: key,
        name: domain,
        domain,
        aliases: [],
        webServer: 'Nginx',
        technology: compose
          ? 'Docker Compose'
          : site.upstream
            ? 'Reverse proxy'
            : 'Static / PHP (inspect source)',
        support: 'import',
        https: false,
        services: [],
      }
      view.aliases = [...new Set([...view.aliases, ...site.domains.filter((d) => d !== domain)])]
      view.https ||= site.https
      view.configPath = site.configPath
      view.documentRoot = site.root ?? view.documentRoot
      view.upstream = displayUpstream(site.upstream) ?? view.upstream
      view.suggestedCompose = compose ?? view.suggestedCompose
      view.projectPath = compose?.directory ?? site.root ?? view.projectPath
      view.services = matched.map(runtime)
      if (site.certificatePath && websitePath.safeParse(site.certificatePath).success) {
        try {
          const result = await this.sessions.exec(
            sessionId,
            `openssl x509 -in ${quotePosix(site.certificatePath)} -noout -issuer -enddate`,
          )
          view.certificate = {
            issuer: /^issuer=(.*)$/m.exec(result)?.[1]?.slice(0, 300),
            expires: /^notAfter=(.*)$/m.exec(result)?.[1],
          }
        } catch {
          warnings.push(`Certificate metadata for ${domain} could not be read.`)
        }
      }
      views.set(key, view)
    }
    for (const record of records) {
      const matched = containers.filter(
        (c) =>
          c.project === record.config.compose?.project && c.directory === record.config.projectPath,
      )
      const view = views.get(record.id) ?? {
        id: record.id,
        name: record.config.name,
        domain: record.config.domain,
        aliases: [],
        webServer: 'Registered',
        technology:
          record.config.strategy === 'compose'
            ? 'Docker Compose'
            : record.config.strategy === 'static'
              ? 'Static assets'
              : 'Manual',
        https: record.config.publicUrl.startsWith('https:'),
        services: [],
      }
      views.set(record.id, {
        ...view,
        name: record.config.name,
        record,
        projectPath: record.config.projectPath,
        services: matched.map(runtime),
        support: record.config.strategy === 'manual' ? 'partial' : 'supported',
      })
    }
    for (const project of [
      ...new Set(containers.map((c) => c.project).filter((v): v is string => !!v)),
    ]) {
      if (
        [...views.values()].some(
          (v) =>
            v.record?.config.compose?.project === project ||
            v.suggestedCompose?.project === project,
        )
      )
        continue
      const members = containers.filter((c) => c.project === project),
        compose = suggestion(members)
      views.set(`compose:${hash(project).slice(0, 24)}`, {
        id: `compose:${hash(project).slice(0, 24)}`,
        name: project,
        domain: '',
        aliases: [],
        webServer: 'Docker',
        technology: 'Docker Compose',
        support: 'import',
        https: false,
        projectPath: compose?.directory,
        suggestedCompose: compose,
        services: members.map(runtime),
      })
    }
    return {
      websites: [...views.values()],
      warnings: [...new Set(warnings)],
      at: new Date().toISOString(),
    }
  }
}
