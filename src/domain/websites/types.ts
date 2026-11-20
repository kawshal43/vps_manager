import { z } from 'zod'

export const relativeWebsitePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) =>
      !v.startsWith('/') &&
      !v.includes('\\') &&
      !/[\x00-\x1f\x7f]/.test(v) &&
      v.split('/').every((p) => p !== '' && p !== '.' && p !== '..'),
    'Use a relative path without traversal or control characters.',
  )
export const websitePath = z
  .string()
  .min(2)
  .max(4096)
  .startsWith('/')
  .refine(
    (v) => !/[\x00-\x1f\x7f\\]/.test(v) && !v.split('/').includes('..'),
    'Use an absolute POSIX path without traversal.',
  )
export const websiteDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
export const endpointSchema = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v)
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        !!u.hostname &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        !/[\x00-\x20\x7f]/.test(v)
      )
    } catch {
      return false
    }
  }, 'Use an HTTP(S) endpoint without credentials, query parameters or fragments.')
export const serviceName = z
  .string()
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
export const defaultProtectedPaths = ['uploads', 'media', 'storage', 'data', 'pgdata']
export const websiteInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    domain: websiteDomain,
    projectPath: websitePath,
    strategy: z.enum(['compose', 'static', 'manual']),
    healthUrl: endpointSchema,
    publicUrl: endpointSchema,
    healthTimeoutSeconds: z.number().int().min(10).max(300).default(60),
    protectedPaths: z.array(relativeWebsitePath).max(50),
    compose: z
      .object({
        project: z
          .string()
          .max(100)
          .regex(/^[a-z0-9][a-z0-9_-]*$/),
        files: z.array(relativeWebsitePath).min(1).max(8),
        services: z.array(serviceName).min(1).max(12),
        envFile: websitePath.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) => v.strategy !== 'compose' || !!v.compose,
    'Configure the Compose project and services.',
  )
  .refine((v) => {
    try {
      return new URL(v.publicUrl).hostname.toLowerCase() === v.domain
    } catch {
      return false
    }
  }, 'Public URL must use the configured domain.')
export type WebsiteInput = z.infer<typeof websiteInputSchema>
export const websiteRecordSchema = z
  .object({
    id: z.string().uuid(),
    scope: z.string().max(600),
    config: websiteInputSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    activeRelease: websitePath.optional(),
    activeOverride: websitePath.optional(),
  })
  .strict()
export type WebsiteRecord = z.infer<typeof websiteRecordSchema>
export type Elevation = 'none' | 'sudo'
export type UpdateMethod = 'full' | 'partial' | 'rebuild'
export const updateSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), token: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('remote'), path: websitePath }).strict(),
  z
    .object({
      kind: z.literal('git'),
      url: z.string().max(2048),
      revision: z.string().regex(/^[a-fA-F0-9]{40}$/),
    })
    .strict(),
  z.object({ kind: z.literal('current') }).strict(),
])
export type UpdateSource = z.infer<typeof updateSourceSchema>
export interface RuntimeService {
  name: string
  state: string
  health?: string
  ports: string[]
  image?: string
}
export interface HealthResult {
  at: string
  url: string
  state: 'healthy' | 'unhealthy' | 'unreachable'
  code?: number
  detail: string
}
export interface WebsiteView {
  id: string
  name: string
  domain: string
  aliases: string[]
  webServer: string
  technology: string
  support: 'supported' | 'partial' | 'import'
  projectPath?: string
  documentRoot?: string
  upstream?: string
  configPath?: string
  https: boolean
  certificate?: { issuer?: string; expires?: string }
  services: RuntimeService[]
  record?: WebsiteRecord
  health?: HealthResult
  lastDeployment?: string
  suggestedCompose?: { project: string; directory: string; files: string[]; services: string[] }
}
export interface DiscoveryResult {
  websites: WebsiteView[]
  warnings: string[]
  at: string
}
export interface FileEntry {
  path: string
  size: number
  hash: string
  mode: number
}
export interface FileChanges {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: number
}
export interface DeploymentPreview {
  token: string
  websiteId: string
  expiresAt: number
  method: UpdateMethod
  changes: FileChanges
  bytes: number
  fileCount: number
  services: string[]
  protected: string[]
  blocked: string[]
  warnings: string[]
  freeBytes: number
}
export const deploymentHistorySchema = z
  .object({
    id: z.string().uuid(),
    websiteId: z.string().uuid(),
    scope: z.string().max(600),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'restored']),
    action: z.enum(['deploy', 'restore']),
    message: z.string().max(2000),
    releasePath: websitePath.optional(),
    backupPath: websitePath.optional(),
    backupVerified: z.boolean(),
    backupBytes: z.number().nonnegative(),
    backupHash: z.string().max(64),
    previousRelease: websitePath.optional(),
    previousOverride: websitePath.optional(),
    previousImages: z.record(serviceName, z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    configHash: z.string().max(64),
    log: z.array(z.string().max(2000)).max(500),
  })
  .strict()
export type DeploymentHistory = z.infer<typeof deploymentHistorySchema>
export interface DeploymentProgress {
  id: string
  sessionId: string
  websiteId: string
  state: DeploymentHistory['status']
  stage: string
  startedAt: string
  transferred: number
  total: number
  log: string[]
  cancellable: boolean
  finishedAt?: string
}
