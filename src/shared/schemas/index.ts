import { z } from 'zod'
import { workspaceSchema } from '../workspace'
const id = z.string().uuid()
export const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (v) =>
      v.includes(':')
        ? z.ipv6().safeParse(v).success
        : /^[0-9.]+$/.test(v)
          ? z.ipv4().safeParse(v).success
          : v
              .replace(/\.$/, '')
              .split('.')
              .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)),
    'Enter an IPv4 address, IPv6 address, or hostname without a protocol.',
  )
export const profileSchema = z
  .object({
    id,
    displayName: z.string().trim().max(100),
    host,
    port: z.number().int().min(1).max(65535),
    username: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/),
    authenticationMethod: z.enum(['password', 'key']),
    privateKeyReference: z.string().max(4096).optional(),
    lastConnectedAt: z.string().optional(),
    lastDirectory: z.string().optional(),
  })
  .strict()
const remotePath = z
  .string()
  .min(1)
  .max(4096)
  .startsWith('/')
  .refine((v) => !/[\x00-\x1f\x7f]/.test(v), 'Control characters are not supported in paths.')
const paths = z.array(remotePath).min(1).max(1000)
const session = z.object({ sessionId: id }).strict()
const pathRequest = session.extend({ path: remotePath })
export const deploymentInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    path: remotePath,
    service: z
      .string()
      .max(256)
      .regex(/^[a-zA-Z0-9_.@:\\-]+\.service$/)
      .optional(),
    notes: z.string().max(500),
  })
  .strict()
export const deploymentSchema = deploymentInputSchema
  .extend({
    id,
    host,
    port: z.number().int().min(1).max(65535),
    username: profileSchema.shape.username,
    createdAt: z.string(),
  })
  .strict()
const conflict = z.enum(['ask', 'skip', 'replace', 'keep-both'])
export const preferencesSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']),
    hiddenFiles: z.boolean(),
    concurrency: z.number().int().min(1).max(4),
    monitoringInterval: z.number().int().min(3).max(60),
    lastProfileId: id.optional(),
    width: z.number().int().min(960).max(7680),
    height: z.number().int().min(640).max(4320),
  })
  .strict()
export const schemas = {
  'app.bootstrap': z.object({}).strict(),
  'app.preferences': preferencesSchema,
  'app.diagnostics': z.object({}).strict(),
  'clipboard.readText': z.object({}).strict(),
  'clipboard.writeText': z.object({ text: z.string().max(10485760) }).strict(),
  'workspace.load': z.object({}).strict(),
  'workspace.save': workspaceSchema,
  'app.editorState': z.object({ dirtyCount: z.number().int().min(0).max(256) }).strict(),
  'profiles.remove': z.object({ id }).strict(),
  'profiles.forgetCredentials': z.object({ id }).strict(),
  'connection.connect': z
    .object({
      profile: profileSchema,
      secret: z.string().max(32768).optional(),
      keyToken: id.optional(),
      rememberServer: z.boolean(),
      rememberCredentials: z.boolean(),
    })
    .strict(),
  'connection.disconnect': session,
  'connection.cancel': z.object({}).strict(),
  'connection.trust': z.object({ id, accept: z.boolean() }).strict(),
  'connection.pickKey': z.object({}).strict(),
  'files.list': pathRequest,
  'files.stat': pathRequest,
  'files.resolve': pathRequest,
  'files.cancel': session,
  'files.create': pathRequest.extend({
    name: z.string().min(1).max(255),
    kind: z.enum(['file', 'directory']),
  }),
  'files.rename': pathRequest.extend({ destination: remotePath }),
  'files.copy': session.extend({ paths, destination: remotePath }),
  'files.delete': session.extend({ paths }),
  'files.chmod': pathRequest.extend({ mode: z.string().regex(/^[0-7]{3}$/) }),
  'files.read': pathRequest,
  'files.save': pathRequest.extend({
    content: z.string().max(2097152),
    identity: z
      .object({
        size: z.number(),
        mtime: z.number(),
        mode: z.number(),
        uid: z.number(),
        gid: z.number(),
        hash: z.string().optional(),
      })
      .strict()
      .nullable(),
  }),
  'transfers.upload': pathRequest.extend({ folders: z.boolean(), conflict }),
  'transfers.drop': pathRequest.extend({ tokens: z.array(id).min(1).max(1000), conflict }),
  'transfers.desktopDrop': pathRequest.extend({ tokens: z.array(id).min(1).max(1000), conflict }),
  'transfers.download': session.extend({ paths, conflict }),
  'transfers.cancel': z.object({ id }).strict(),
  'transfers.retry': z.object({ id }).strict(),
  'transfers.reveal': z.object({ id }).strict(),
  'terminal.open': session.extend({
    cwd: remotePath.optional(),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(1).max(300),
  }),
  'terminal.input': z.object({ id, data: z.string().max(65536) }).strict(),
  'terminal.resize': z
    .object({ id, cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) })
    .strict(),
  'terminal.ack': z.object({ id, bytes: z.number().int().min(0).max(1048576) }).strict(),
  'terminal.close': z.object({ id }).strict(),
  'monitoring.get': session,
  'services.list': session,
  'services.details': session.extend({
    name: z
      .string()
      .max(256)
      .regex(/^[a-zA-Z0-9_.@:\\-]+\.service$/),
  }),
  'services.action': session.extend({
    name: z
      .string()
      .max(256)
      .regex(/^[a-zA-Z0-9_.@:\\-]+\.service$/),
    action: z.enum(['start', 'stop', 'restart', 'reload', 'enable', 'disable']),
  }),
  'logs.read': session.extend({
    name: z
      .string()
      .max(256)
      .regex(/^[a-zA-Z0-9_.@:\\-]+\.service$/)
      .optional(),
  }),
  'system.processes': session,
  'applications.packages': session,
  'applications.deployments': session,
  'applications.saveDeployment': session.extend({
    deployment: deploymentInputSchema,
    id: id.optional(),
  }),
  'applications.forgetDeployment': session.extend({ id }),
  'applications.prepareRemoval': session.extend({
    kind: z.enum(['package', 'deployment']),
    target: z.string().min(1).max(200),
  }),
  'applications.executeRemoval': session.extend({ token: id, elevation: z.enum(['none', 'sudo']) }),
  'system.ports': session,
  'system.inspect': session.extend({ pid: z.number().int().min(2).max(4194304) }),
  'system.terminate': session.extend({
    pid: z.number().int().min(2),
    startTime: z.string().regex(/^\d+$/),
  }),
  'shell.openExternal': z.object({ url: z.string().url().max(4096) }).strict(),
}
export type Route = keyof typeof schemas
export type Input<K extends Route> = z.infer<(typeof schemas)[K]>
