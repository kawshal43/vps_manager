import { createHash, randomUUID } from 'node:crypto'
import type { SessionManager } from '../connection/session-manager'
import type { SettingsRepository } from '../../infrastructure/persistence/store'
import { AppError, mapError } from '../../domain/errors/app-error'
import type {
  ApplicationOperation,
  Deployment,
  DeploymentInput,
  DeploymentStatus,
  Elevation,
  InstalledPackage,
  PackageInventory,
  RemovalPlan,
} from '../../domain/applications/types'
import {
  criticalService,
  equalPackageNames,
  packageName,
  packageProtection,
  parseSimulatedRemoval,
} from '../../domain/applications/policy'
import {
  aptPreviewCommand,
  aptRemovalCommand,
  packageInventoryCommand,
} from '../../infrastructure/commands/applications'
import { runAptRemoval } from '../../infrastructure/ssh/apt-transaction'
import { serviceActionCommand, serviceDetailsCommand } from '../../infrastructure/commands/catalog'
import { FileOperations, type Confirm } from '../filesystem/file-operations'
import type { AppEvent } from '../../shared/contracts/api'

interface StoredPlan {
  public: RemovalPlan
  snapshot: string
  deployment?: Deployment
}
export function parsePackageInventory(raw: string): PackageInventory {
  const uid = /^__UID__\n(\d+)\n/.exec(raw)?.[1]
  const manual = new Set(
    (/__MANUAL__\n([\s\S]*?)__HELD__\n/.exec(raw)?.[1] ?? '').trim().split(/\s+/),
  )
  const held = new Set(
    (/__HELD__\n([\s\S]*?)__PACKAGES__\n/.exec(raw)?.[1] ?? '').trim().split(/\s+/),
  )
  const body = /__PACKAGES__\n([\s\S]*?)__SNAPSHOT__\n([a-f0-9]{64})\s/.exec(raw)
  if (uid === undefined || !body)
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'The server did not return a supported dpkg/APT inventory.',
    )
  const packages: InstalledPackage[] = []
  for (const line of body[1].split('\n').filter(Boolean)) {
    const [
      name,
      version,
      architecture,
      size,
      essential,
      protectedValue,
      priority,
      status,
      ...description
    ] = line.split('\t')
    if (status !== 'installed') continue
    packageName(name)
    const bytes = Number(size) * 1024
    if (!Number.isFinite(bytes) || bytes < 0 || !version || !architecture)
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'The package inventory contains invalid metadata.',
      )
    const base = name.split(':')[0]
    const pkg: InstalledPackage = {
      name,
      version,
      architecture,
      size: bytes,
      description: description.join(' '),
      essential: essential === 'yes',
      protected: protectedValue === 'yes',
      priority,
      manual: manual.has(name) || manual.has(base),
      held: held.has(name) || held.has(base),
    }
    pkg.protectedReason = packageProtection(pkg)
    packages.push(pkg)
  }
  return {
    packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
    uid: Number(uid),
    snapshot: body[2],
    at: Date.now(),
  }
}
function findPackage(inventory: PackageInventory, name: string): InstalledPackage | undefined {
  return (
    inventory.packages.find((pkg) => pkg.name === name) ??
    inventory.packages.find(
      (pkg) =>
        pkg.name.split(':')[0] === name &&
        inventory.packages.filter((other) => other.name.split(':')[0] === name).length === 1,
    )
  )
}
export class ApplicationManager {
  private plans = new Map<string, StoredPlan>()
  private busy = new Set<string>()
  private files: FileOperations
  constructor(
    private sessions: SessionManager,
    private repository: SettingsRepository,
    private confirm: Confirm,
    private emit: (event: AppEvent) => void,
  ) {
    this.files = new FileOperations(sessions, confirm)
  }
  private report(id: string, stage: ApplicationOperation['stage'], message: string): void {
    this.emit({ type: 'application-operation', operation: { sessionId: id, stage, message } })
  }
  async packages(id: string): Promise<PackageInventory> {
    return parsePackageInventory(await this.sessions.exec(id, packageInventoryCommand, 30000))
  }
  private records(id: string): Deployment[] {
    const profile = this.sessions.get(id).info.profile
    return this.repository
      .deployments()
      .filter(
        (value) =>
          value.host.toLowerCase() === profile.host.toLowerCase() &&
          value.port === profile.port &&
          value.username === profile.username,
      )
  }
  async deployments(id: string): Promise<DeploymentStatus[]> {
    const fs = this.files.fs(id)
    const result: DeploymentStatus[] = []
    for (const value of this.records(id)) {
      try {
        const attrs = await fs.exists(value.path)
        result.push({
          ...value,
          state:
            attrs?.isDirectory() && !attrs.isSymbolicLink()
              ? 'present'
              : attrs
                ? 'unavailable'
                : 'missing',
          reason:
            attrs && (!attrs.isDirectory() || attrs.isSymbolicLink())
              ? 'The registered path is no longer a regular directory.'
              : undefined,
        })
      } catch (error) {
        result.push({
          ...value,
          state: 'unavailable',
          reason: mapError(error, 'applications.deployments').message,
        })
      }
    }
    return result
  }
  async saveDeployment(id: string, input: DeploymentInput, recordId?: string): Promise<Deployment> {
    const fs = this.files.fs(id)
    const path = await fs.mutationPath(input.path)
    const attrs = await fs.lstat(path)
    if (!attrs.isDirectory() || attrs.isSymbolicLink() || (await fs.realpath(path)) !== path)
      throw new AppError('INVALID_PATH', 'Register an existing directory, not a symbolic link.')
    if (recordId && !this.records(id).some((value) => value.id === recordId))
      throw new AppError(
        'INVALID_REQUEST',
        'This saved app belongs to another server/account or no longer exists.',
      )
    const profile = this.sessions.get(id).info.profile
    const record: Deployment = {
      ...input,
      path,
      id: recordId ?? randomUUID(),
      host: profile.host.toLowerCase(),
      port: profile.port,
      username: profile.username,
      createdAt: new Date().toISOString(),
    }
    await this.repository.saveDeployment(record)
    return record
  }
  async forgetDeployment(id: string, recordId: string): Promise<void> {
    const record = this.records(id).find((value) => value.id === recordId)
    if (!record)
      throw new AppError('FILE_NOT_FOUND', 'This app entry is no longer in this server’s list.')
    if (
      await this.confirm(
        'Remove saved entry',
        `Remove “${record.name}” from this list?`,
        'This changes only the saved list on this computer. The server directory and service are kept.',
      )
    )
      await this.repository.removeDeployment(recordId)
  }
  private async tree(
    id: string,
    path: string,
  ): Promise<{ hash: string; count: number; bytes: number }> {
    const fs = this.files.fs(id)
    const rows: string[] = []
    let count = 0
    let bytes = 0
    const walk = async (target: string, depth: number): Promise<void> => {
      if (++count > 10000 || depth > 64)
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'The deployment exceeds the preview limit (10,000 entries or 64 levels). Use Files or Terminal for a deliberate review.',
        )
      const safe = await fs.mutationPath(target)
      const attrs = await fs.lstat(safe)
      rows.push(JSON.stringify([safe, attrs.mode, attrs.size, attrs.mtime, attrs.uid, attrs.gid]))
      if (attrs.isDirectory() && !attrs.isSymbolicLink()) {
        if ((await fs.realpath(safe)) !== safe)
          throw new AppError('FILE_CONFLICT', 'A deployment directory became a symbolic link.')
        for (const entry of (await fs.list(safe)).entries) await walk(entry.path, depth + 1)
      } else if (attrs.isFile()) bytes += attrs.size
    }
    await walk(path, 0)
    return { hash: createHash('sha256').update(rows.sort().join('\n')).digest('hex'), count, bytes }
  }
  async prepare(id: string, kind: 'package' | 'deployment', target: string): Promise<RemovalPlan> {
    const inventory = await this.packages(id)
    const base: RemovalPlan = {
      token: randomUUID(),
      sessionId: id,
      kind,
      target,
      title: target,
      affected: [],
      totalBytes: 0,
      itemCount: 0,
      blocked: [],
      warnings: [],
      expiresAt: Date.now() + 120000,
      uid: inventory.uid,
    }
    let snapshot = inventory.snapshot
    let deployment: Deployment | undefined
    if (kind === 'package') {
      packageName(target)
      const selected = findPackage(inventory, target)
      if (!selected)
        throw new AppError('FILE_NOT_FOUND', 'The selected package is no longer installed.')
      base.target = selected.name
      base.title = selected.name
      if (selected.protectedReason) base.blocked.push(selected.protectedReason)
      if (!base.blocked.length) {
        const names = parseSimulatedRemoval(
          await this.sessions.exec(id, aptPreviewCommand(selected.name), 30000),
        )
        for (const name of names) {
          const pkg = findPackage(inventory, name)
          if (!pkg) base.blocked.push(`APT proposed an unknown package: ${name}`)
          else {
            base.affected.push({ name: pkg.name, version: pkg.version, size: pkg.size })
            if (pkg.protectedReason) base.blocked.push(`${pkg.name}: ${pkg.protectedReason}`)
          }
        }
        if (!base.affected.some((pkg) => pkg.name === selected.name))
          base.blocked.push('APT did not propose removing the selected package.')
        if (base.affected.length > 25)
          base.blocked.push(
            'This preview affects more than 25 packages. Review the operation in Terminal.',
          )
      }
      base.itemCount = base.affected.length
      base.totalBytes = base.affected.reduce((sum, pkg) => sum + pkg.size, 0)
      base.warnings = [
        'APT remove is used without purge or autoremove. Package maintainer scripts can stop services or change application-managed data.',
        'Removal requires existing root permissions or explicitly selected noninteractive sudo authorization.',
      ]
    } else {
      deployment = this.records(id).find((value) => value.id === target)
      if (!deployment)
        throw new AppError(
          'FILE_NOT_FOUND',
          'The saved deployment no longer exists for this server/account.',
        )
      const fs = this.files.fs(id)
      const safe = await fs.mutationPath(deployment.path)
      const attrs = await fs.lstat(safe)
      if (!attrs.isDirectory() || attrs.isSymbolicLink() || (await fs.realpath(safe)) !== safe)
        throw new AppError(
          'INVALID_PATH',
          'The deployment path changed or is not a regular directory.',
        )
      const manifest = await this.tree(id, safe)
      snapshot = manifest.hash
      base.target = safe
      base.title = deployment.name
      base.itemCount = manifest.count
      base.totalBytes = manifest.bytes
      base.service = deployment.service
      if (deployment.service) {
        if (criticalService(deployment.service))
          base.blocked.push(
            'Critical SSH, network, system and database services cannot be removed through a saved deployment.',
          )
        else await this.sessions.exec(id, serviceDetailsCommand(deployment.service))
      }
      base.warnings = [
        'The registered directory and its contents will be permanently removed using your SFTP account’s filesystem permissions. No undo or rollback is available.',
        ...(deployment.service
          ? [
              `${deployment.service} will be stopped and disabled. Its unit definition is retained; files and databases outside this directory are not deleted by this action.`,
            ]
          : [
              'No service is linked. Processes outside this registered directory are not managed by this action.',
            ]),
      ]
    }
    for (const [token, value] of this.plans)
      if (value.public.expiresAt < Date.now()) this.plans.delete(token)
    if (this.plans.size >= 100)
      throw new AppError(
        'INVALID_REQUEST',
        'Too many removal previews are open. Close them and retry shortly.',
      )
    this.plans.set(base.token, { public: base, snapshot, deployment })
    return base
  }
  async execute(
    id: string,
    token: string,
    elevation: Elevation,
  ): Promise<{ completed: boolean; message: string }> {
    const stored = this.plans.get(token)
    if (!stored || stored.public.sessionId !== id || stored.public.expiresAt < Date.now())
      throw new AppError(
        'INVALID_REQUEST',
        'This removal preview expired or belongs to another connection. Create a fresh preview.',
      )
    if (this.busy.has(id))
      throw new AppError(
        'FILE_CONFLICT',
        'Another application removal is already in progress on this server.',
      )
    this.plans.delete(token)
    const plan = stored.public
    if (plan.blocked.length) throw new AppError('PERMISSION_DENIED', plan.blocked.join(' '))
    this.busy.add(id)
    this.report(id, 'preparing', 'Revalidating the removal preview…')
    try {
      if (plan.kind === 'package') {
        const current = await this.packages(id)
        if (current.snapshot !== stored.snapshot)
          throw new AppError(
            'FILE_CONFLICT',
            'The package database changed. Create a fresh removal preview.',
          )
        if (current.uid !== 0 && elevation === 'none')
          throw new AppError(
            'PERMISSION_DENIED',
            'APT package removal requires root authorization.',
            'Explicitly choose existing sudo access, or connect with an authorized account.',
          )
        const actual = parseSimulatedRemoval(
          await this.sessions.exec(id, aptPreviewCommand(plan.target), 30000),
        )
        if (
          !equalPackageNames(
            actual.map((name) => findPackage(current, name)?.name ?? name),
            plan.affected.map((pkg) => pkg.name),
          )
        )
          throw new AppError(
            'FILE_CONFLICT',
            'The removal proposal changed. Create a fresh preview.',
          )
        const approvedNames = actual
        const outcome = await runAptRemoval(
          this.sessions,
          id,
          aptRemovalCommand(plan.target, elevation),
          approvedNames,
          async () => {
            this.report(id, 'confirming', 'Waiting for final confirmation…')
            return this.confirm(
              'Uninstall package',
              `Uninstall ${plan.target}?`,
              `${plan.affected.map((pkg) => `${pkg.name} ${pkg.version}`).join('\n')}\n\nAuthorization: ${elevation === 'sudo' ? 'Explicit noninteractive sudo' : 'Current SSH account'}\n\n${plan.warnings.join('\n')}`,
            )
          },
          () => this.report(id, 'running', 'APT is removing the approved packages…'),
        )
        if (outcome === 'cancelled') {
          this.report(id, 'cancelled', 'Removal cancelled before approval.')
          return { completed: false, message: 'Uninstall cancelled.' }
        }
        this.report(id, 'verifying', 'Checking installed package state…')
        const remaining = await this.packages(id)
        if (plan.affected.some((pkg) => findPackage(remaining, pkg.name)))
          throw new AppError(
            'SERVICE_ERROR',
            'APT returned, but one or more affected packages are still installed.',
            'Inspect package state in Terminal before retrying.',
          )
      } else {
        const record = stored.deployment!
        if (
          !this.records(id).some(
            (value) =>
              value.id === record.id &&
              value.path === record.path &&
              value.service === record.service,
          )
        )
          throw new AppError(
            'FILE_CONFLICT',
            'The saved deployment changed. Create a fresh preview.',
          )
        if ((await this.tree(id, record.path)).hash !== stored.snapshot)
          throw new AppError('FILE_CONFLICT', 'Deployment files changed. Create a fresh preview.')
        this.report(id, 'confirming', 'Waiting for deployment removal confirmation…')
        if (
          !(await this.confirm(
            'Remove deployment files',
            `Permanently remove “${record.name}”?`,
            `${record.path}\n${plan.itemCount} entries; ${plan.totalBytes} bytes\n\n${plan.warnings.join('\n')}\nAuthorization for service actions: ${elevation === 'sudo' ? 'Explicit noninteractive sudo' : 'Current SSH account'}`,
          ))
        ) {
          this.report(id, 'cancelled', 'Deployment removal cancelled.')
          return { completed: false, message: 'Removal cancelled.' }
        }
        if ((await this.tree(id, record.path)).hash !== stored.snapshot)
          throw new AppError(
            'FILE_CONFLICT',
            'Deployment files changed during confirmation. Create a fresh preview.',
          )
        if (record.service) {
          if (criticalService(record.service))
            throw new AppError(
              'PERMISSION_DENIED',
              'A critical service cannot be removed through this action.',
            )
          for (const action of ['stop', 'disable'] as const) {
            const command = serviceActionCommand(record.service, action)
            await this.sessions.exec(
              id,
              elevation === 'sudo'
                ? command.replace('LC_ALL=C systemctl', 'LC_ALL=C sudo -n -- /usr/bin/systemctl')
                : command,
              30000,
            )
          }
          const state = await this.sessions.exec(id, serviceDetailsCommand(record.service))
          if (
            /^ActiveState=(active|activating|reloading)$/m.test(state) ||
            /^UnitFileState=(enabled|enabled-runtime)$/m.test(state)
          )
            throw new AppError(
              'SERVICE_ERROR',
              'The linked service is still active or enabled. Files were preserved.',
            )
        }
        this.report(id, 'running', 'Removing the confirmed deployment directory…')
        const fs = this.files.fs(id)
        await fs.remove(record.path)
        if (await fs.exists(record.path))
          throw new AppError('SFTP_ERROR', 'Deployment removal could not be verified.')
        await this.repository.removeDeployment(record.id)
      }
      const message =
        plan.kind === 'package'
          ? 'Package removal verified.'
          : `Deployment directory removal verified.${plan.service ? ' The linked service is stopped and disabled; its unit definition is retained.' : ''}`
      this.report(id, 'completed', message)
      return { completed: true, message }
    } catch (error) {
      this.report(id, 'failed', mapError(error, 'applications.executeRemoval').message)
      throw error
    } finally {
      this.busy.delete(id)
    }
  }
}
