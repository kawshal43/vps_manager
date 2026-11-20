import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../domain/errors/app-error'
import type {
  WebsiteInput,
  WebsiteRecord,
  UpdateMethod,
  Elevation,
} from '../../domain/websites/types'
import type { Manifest, ProjectIO } from '../../infrastructure/websites/project-io'
import { sftpCall } from '../../infrastructure/sftp/remote-fs'
import { composeAction } from '../../infrastructure/commands/websites'
import type { SessionManager } from '../connection/session-manager'

interface Activation {
  sessionId: string
  record: WebsiteRecord
  release: string
  originalBackup: string
  override?: string
  elevation: Elevation
  io: ProjectIO
  sessions: SessionManager
}
export interface WebsiteDeploymentAdapter {
  id: 'compose' | 'static'
  activationMayPartiallySucceed: boolean
  sourceBlockers(current: Manifest, incoming: Manifest, method: UpdateMethod): string[]
  activate(context: Activation): Promise<void>
}
const composeAdapter: WebsiteDeploymentAdapter = {
  id: 'compose',
  activationMayPartiallySucceed: true,
  sourceBlockers: () => [],
  activate: ({ sessions, sessionId, record, elevation, override }) =>
    sessions
      .exec(sessionId, composeAction(record.config, elevation, 'activate', override), 5 * 60000)
      .then(() => {}),
}
const staticAdapter: WebsiteDeploymentAdapter = {
  id: 'static',
  activationMayPartiallySucceed: false,
  sourceBlockers: (current, incoming, method) => {
    const blocked: string[] = []
    if (current.skipped.some((p) => !/(?:^|\/)(?:\.git|node_modules)$/.test(p)))
      blocked.push(
        'This document root contains protected data. Static activation is blocked to avoid hiding or replacing it.',
      )
    if (
      [...current.files, ...incoming.files].some((f) =>
        /(?:^|\/)(?:package\.json|pom\.xml|composer\.json|gradlew)$|\.php$/i.test(f.path),
      )
    )
      blocked.push(
        'Deploy prebuilt static assets only. This directory contains an application runtime.',
      )
    if (
      !(method === 'full' ? incoming.files : [...incoming.files, ...current.files]).some(
        (f) => f.path === 'index.html',
      )
    )
      blocked.push('A static release must contain index.html at its root.')
    return blocked
  },
  activate: async ({ sessionId, record, release, originalBackup, io }) => {
    const fs = io.fs(sessionId),
      path = record.config.projectPath,
      temp = posix.join(posix.dirname(path), `.vps-link-${randomUUID()}`)
    const stat = await fs.lstat(path)
    if (
      record.activeRelease
        ? !stat.isSymbolicLink() || (await fs.realpath(path)) !== record.activeRelease
        : !stat.isDirectory() || stat.isSymbolicLink()
    )
      throw new AppError('FILE_CONFLICT', 'The document root changed before activation.')
    await sftpCall<void>((cb) => fs.sftp.symlink(release, temp, (e) => cb(e, undefined)))
    if (record.activeRelease)
      await sftpCall<void>((cb) => fs.sftp.ext_openssh_rename(temp, path, (e) => cb(e, undefined)))
    else {
      await fs.rename(path, originalBackup)
      try {
        await sftpCall<void>((cb) => fs.sftp.rename(temp, path, (e) => cb(e, undefined)))
      } catch (error) {
        await fs.rename(originalBackup, path)
        throw error
      }
    }
  },
}
export const websiteAdapters: Record<'compose' | 'static', WebsiteDeploymentAdapter> = {
  compose: composeAdapter,
  static: staticAdapter,
}
export function websiteAdapter(config: WebsiteInput): WebsiteDeploymentAdapter {
  if (config.strategy === 'manual')
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'This runtime supports inspection only. Use a Compose or static mapping for managed updates.',
    )
  return websiteAdapters[config.strategy]
}
