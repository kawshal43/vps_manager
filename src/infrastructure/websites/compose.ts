import { posix } from 'node:path'
import { AppError } from '../../domain/errors/app-error'
import { childPath, hash, isProtected } from '../../domain/websites/policy'
import { websitePath, type WebsiteInput } from '../../domain/websites/types'

export interface ComposeService {
  image?: string
  build?:
    | string
    | {
        context?: string
        dockerfile?: string
        additional_contexts?: unknown
        args?: Record<string, unknown>
      }
  volumes?: { type: string; source?: string; target: string; read_only?: boolean }[]
  environment?: Record<string, unknown>
  command?: unknown
  entrypoint?: unknown
  privileged?: boolean
  network_mode?: string
  post_start?: unknown
  pre_stop?: unknown
}
export interface ComposeModel {
  name?: string
  services: Record<string, ComposeService>
  volumes?: unknown
  networks?: unknown
  secrets?: unknown
  configs?: unknown
}
export function parseComposeModel(output: string): ComposeModel {
  const v = JSON.parse(output) as ComposeModel
  if (
    !v ||
    !v.services ||
    typeof v.services !== 'object' ||
    Array.isArray(v.services) ||
    Object.keys(v.services).length > 100
  )
    throw new AppError('INVALID_REQUEST', 'Compose did not return a bounded service model.')
  return v
}
export function composeFingerprint(model: ComposeModel): string {
  return hash(JSON.stringify(model))
}
export function composeSecrets(model: ComposeModel): string[] {
  return Object.values(model.services)
    .flatMap((s) => [
      ...Object.values(s.environment ?? {}),
      ...Object.values(typeof s.build === 'object' ? (s.build.args ?? {}) : {}),
    ])
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .flatMap((v) => String(v).split(/\r?\n/))
    .filter(Boolean)
}
export function inspectCompose(
  config: WebsiteInput,
  model: ComposeModel,
): { blocked: string[]; protected: string[] } {
  const blocked: string[] = [],
    protectedPaths: string[] = []
  for (const [name, s] of Object.entries(model.services)) {
    for (const mount of s.volumes ?? []) {
      protectedPaths.push(`${name}: ${mount.type} ${mount.source || ''} → ${mount.target}`)
      if (
        mount.type === 'bind' &&
        (mount.source === config.projectPath || mount.source?.startsWith(config.projectPath + '/'))
      ) {
        const relative = posix.relative(config.projectPath, mount.source)
        if (
          config.compose!.services.includes(name) &&
          (!relative || !isProtected(relative, config.protectedPaths))
        )
          blocked.push(
            `${name} bind-mounts application source. Versioned image deployment cannot safely replace this mount.`,
          )
      }
    }
    if (!config.compose!.services.includes(name)) continue
    if (
      /postgres|mysql|mariadb|mongo|redis|database|(?:^|[-_])db(?:$|[-_])/i.test(
        `${name} ${s.image ?? ''}`,
      )
    )
      blocked.push(`${name} is a persistent data service and cannot be selected for rebuild.`)
    if (!s.build)
      blocked.push(
        `${name} has no local build context. Image-only updates require manual deployment.`,
      )
    const context = typeof s.build === 'string' ? s.build : s.build?.context
    if (
      !context ||
      !(context === config.projectPath || context.startsWith(config.projectPath + '/'))
    )
      blocked.push(`${name} has an external or remote build context.`)
    if (
      typeof s.build === 'object' &&
      (s.build.additional_contexts ||
        (s.build.dockerfile &&
          (posix.isAbsolute(s.build.dockerfile) || s.build.dockerfile.split('/').includes('..'))))
    )
      blocked.push(`${name} uses external build inputs that cannot be staged safely.`)
    if (s.privileged || s.network_mode === 'host' || s.post_start || s.pre_stop)
      blocked.push(
        `${name} uses privileged networking or lifecycle hooks; automatic deployment is blocked.`,
      )
    if (/migrat|flyway|liquibase|schema.?update/i.test(JSON.stringify([s.command, s.entrypoint])))
      blocked.push(
        `${name} runs database migrations at startup. Database backup/restore is not implemented.`,
      )
    for (const [key, value] of Object.entries(s.environment ?? {})) {
      if (
        (/(?:DDL_AUTO|HBM2DDL_AUTO)$/i.test(key) &&
          !['none', 'validate', 'false', ''].includes(String(value).toLowerCase())) ||
        (/(?:FLYWAY|LIQUIBASE)_ENABLED$/i.test(key) && String(value).toLowerCase() === 'true')
      )
        blocked.push(
          `${name} enables automatic database schema changes. Database backup/restore is not implemented.`,
        )
    }
  }
  for (const name of config.compose!.services)
    if (!Object.hasOwn(model.services, name))
      blocked.push(`${name} is not a service in this Compose project.`)
  return { blocked, protected: [...new Set(protectedPaths)] }
}
export function composeProtectedPaths(config: WebsiteInput, model: ComposeModel): string[] {
  return [
    ...new Set([
      ...config.protectedPaths,
      ...Object.values(model.services).flatMap((s) =>
        (s.volumes ?? [])
          .filter((v) => v.type === 'bind' && v.source?.startsWith(config.projectPath + '/'))
          .map((v) => posix.relative(config.projectPath, v.source!)),
      ),
    ]),
  ]
}
interface ObservedMount {
  Type: string
  Name?: string
  Source?: string
  Destination: string
  RW: boolean
}
export function runtimeMountBlockers(
  config: WebsiteInput,
  model: ComposeModel,
  containers: { service: string | null; mounts: ObservedMount[] }[],
): string[] {
  const blocked: string[] = []
  for (const name of config.compose!.services) {
    const service = model.services[name],
      instances = containers.filter((c) => c.service === name)
    if (!service || instances.length !== 1) continue
    const expected = service.volumes ?? [],
      observed = instances[0].mounts
    for (const mount of expected) {
      const actual = observed.find((m) => m.Destination === mount.target)
      const volumeName = mount.source
        ? (model.volumes as Record<string, { name?: string }> | undefined)?.[mount.source]?.name
        : undefined
      if (
        !actual ||
        actual.Type !== mount.type ||
        actual.RW !== !mount.read_only ||
        (mount.type === 'bind' && actual.Source !== mount.source) ||
        (mount.type === 'volume' && !!mount.source && (!volumeName || actual.Name !== volumeName))
      )
        blocked.push(
          `${name} storage at ${mount.target} does not match the running container. Reconcile storage manually before deploying.`,
        )
      if (/^\/(?:var\/lib\/(?:postgresql|mysql|mongodb)|data\/db)(?:\/|$)/.test(mount.target))
        blocked.push(
          `${name} mounts database storage and cannot be selected for application deployment.`,
        )
    }
    for (const mount of observed)
      if (!expected.some((m) => m.target === mount.Destination))
        blocked.push(
          `${name} has an undeclared ${mount.Type} mount at ${mount.Destination}. Implicit volumes/config/secret mounts require manual management.`,
        )
  }
  return blocked
}
export function buildOverride(
  config: WebsiteInput,
  model: ComposeModel,
  release: string,
  deploymentId: string,
): object {
  const services: Record<string, object> = {}
  for (const name of config.compose!.services) {
    const build = model.services[name].build!
    const context = typeof build === 'string' ? build : build.context!
    const relative = posix.relative(config.projectPath, context)
    const staged = relative ? childPath(release, relative) : release
    websitePath.parse(staged)
    services[name] = {
      image: `vps-manager/${deploymentId}/service-${hash(name).slice(0, 12)}:release`,
      build: { context: staged },
    }
  }
  return { services }
}
